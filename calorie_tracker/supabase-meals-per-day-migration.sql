-- MacroSync: meals are configured independently for each calendar day.
-- Run after the existing meal migration(s).

alter table public.meals add column if not exists meal_date date;
update public.meals set meal_date = current_date where meal_date is null;
alter table public.meals alter column meal_date set default current_date;
alter table public.meals alter column meal_date set not null;

-- The old schema had one meal-number slot per user. Remove that global constraint;
-- meal numbers are now unique only within a user's selected day.
alter table public.meals drop constraint if exists meals_user_meal_number_key;
alter table public.meals drop constraint if exists meals_user_id_meal_number_key;
drop index if exists meals_user_order_idx;
drop index if exists meals_user_id_meal_number_key;
drop index if exists public.meals_user_name_unique;
drop index if exists public.meals_user_id_name_unique;
drop index if exists public.meals_user_date_name_unique;
-- Remove any stale legacy index with an unqualified name as well.
drop index if exists meals_user_name_unique;
drop index if exists meals_user_id_name_unique;
create unique index if not exists meals_user_date_number_unique
  on public.meals(user_id, meal_date, meal_number);
create unique index if not exists meals_user_date_name_unique
  on public.meals(user_id, meal_date, lower(trim(name)));
create index if not exists meals_user_date_order_idx
  on public.meals(user_id, meal_date, meal_number);

-- Preserve historical food entries that already use meal names by creating a
-- daily meal row for every user/date/name represented in the diary. Existing
-- numbered names keep their number; other names receive the next available slot.
with distinct_meals as (
  select distinct user_id, logged_date as meal_date, trim(meal) as name
  from public.food_entries
  where nullif(trim(meal), '') is not null
), numbered as (
  select dm.*, case when dm.name ~* '^Meal [1-9]$' then substring(dm.name from 6)::int end as preferred_number
  from distinct_meals dm
), assigned as (
  select n.*, coalesce(
    case when preferred_number between 1 and 10 then preferred_number end,
    row_number() over (partition by user_id, meal_date order by name)
  )::int as assigned_number
  from numbered n
)
insert into public.meals(user_id, meal_date, meal_number, name, sort_order)
select user_id, meal_date, assigned_number, name, assigned_number
from assigned
where assigned_number between 1 and 10
on conflict (user_id, meal_date, meal_number) do nothing;

-- Ensure every user has at least three meals for today. Other days are created
-- lazily by the app when the user visits them.
insert into public.meals(user_id, meal_date, meal_number, name, sort_order)
select p.id, current_date, n, 'Meal ' || n, n
from public.profiles p
cross join generate_series(1,3) gs(n)
on conflict (user_id, meal_date, meal_number) do nothing;

-- Replace old global meal functions with date-scoped versions.
drop function if exists public.ensure_default_meals();
drop function if exists public.ensure_default_meals(date);
drop function if exists public.add_meal(text);
drop function if exists public.add_meal(text, date);
drop function if exists public.rename_meal(uuid, text);
drop function if exists public.rename_meal(uuid, text, date);
drop function if exists public.delete_meal(uuid);
drop function if exists public.delete_meal(uuid, date);

create function public.ensure_default_meals(p_meal_date date default current_date)
returns setof public.meals
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  insert into public.meals(user_id, meal_date, meal_number, name, sort_order)
  select auth.uid(), p_meal_date, n, 'Meal ' || n, n
  from generate_series(1,3) gs(n)
  where not exists (
    select 1 from public.meals m
    where m.user_id=auth.uid() and m.meal_date=p_meal_date and m.meal_number=n
  );
  return query select * from public.meals
  where user_id=auth.uid() and meal_date=p_meal_date order by meal_number;
end; $$;
grant execute on function public.ensure_default_meals(date) to authenticated;

create function public.add_meal(p_name text default null, p_meal_date date default current_date)
returns public.meals
language plpgsql security definer set search_path = public
as $$
declare next_number integer; meal_row public.meals; clean_name text := nullif(trim(coalesce(p_name,'')), '');
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select min(n) into next_number from generate_series(1,10) gs(n)
  where not exists (select 1 from public.meals m where m.user_id=auth.uid() and m.meal_date=p_meal_date and m.meal_number=n);
  if next_number is null then raise exception 'You can have up to 10 meals on this day.'; end if;
  if clean_name is null then clean_name := 'Meal ' || next_number; end if;
  if char_length(clean_name)>40 then raise exception 'Meal names must be 40 characters or fewer.'; end if;
  if exists (select 1 from public.meals m where m.user_id=auth.uid() and m.meal_date=p_meal_date and lower(trim(m.name))=lower(clean_name)) then
    raise exception 'You already have a meal with that name on this day.';
  end if;
  insert into public.meals(user_id,meal_date,meal_number,name,sort_order)
  values(auth.uid(),p_meal_date,next_number,clean_name,next_number) returning * into meal_row;
  return meal_row;
end; $$;
grant execute on function public.add_meal(text,date) to authenticated;

create function public.rename_meal(p_meal_id uuid, p_name text, p_meal_date date default current_date)
returns public.meals
language plpgsql security definer set search_path = public
as $$
declare meal_row public.meals; clean_name text := nullif(trim(coalesce(p_name,'')), ''); old_name text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if clean_name is null then raise exception 'Meal name cannot be empty.'; end if;
  if char_length(clean_name)>40 then raise exception 'Meal names must be 40 characters or fewer.'; end if;
  select * into meal_row from public.meals where id=p_meal_id and user_id=auth.uid() and meal_date=p_meal_date for update;
  if meal_row.id is null then raise exception 'Meal not found for this day.'; end if;
  if exists (select 1 from public.meals m where m.user_id=auth.uid() and m.meal_date=p_meal_date and m.id<>p_meal_id and lower(trim(m.name))=lower(clean_name)) then
    raise exception 'You already have a meal with that name on this day.';
  end if;
  old_name:=meal_row.name;
  update public.food_entries set meal=clean_name where user_id=auth.uid() and logged_date=p_meal_date and meal=old_name;
  update public.meals set name=clean_name,updated_at=now() where id=p_meal_id and user_id=auth.uid() and meal_date=p_meal_date returning * into meal_row;
  return meal_row;
end; $$;
grant execute on function public.rename_meal(uuid,text,date) to authenticated;

create function public.delete_meal(p_meal_id uuid, p_meal_date date default current_date)
returns public.meals
language plpgsql security definer set search_path = public
as $$
declare meal_row public.meals; remaining_count integer; logged_count integer;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select count(*) into remaining_count from public.meals where user_id=auth.uid() and meal_date=p_meal_date;
  if remaining_count<=3 then raise exception 'MacroSync requires at least 3 meals on each day.'; end if;
  select * into meal_row from public.meals where id=p_meal_id and user_id=auth.uid() and meal_date=p_meal_date for update;
  if meal_row.id is null then raise exception 'Meal not found for this day.'; end if;
  select count(*) into logged_count from public.food_entries where user_id=auth.uid() and logged_date=p_meal_date and meal=meal_row.name;
  if logged_count>0 then raise exception 'Move or delete the foods logged under this meal before deleting it.'; end if;
  delete from public.meals where id=p_meal_id and user_id=auth.uid() and meal_date=p_meal_date;
  return meal_row;
end; $$;
grant execute on function public.delete_meal(uuid,date) to authenticated;

-- Optional cleanup of the old unique index names if they were recreated by a
-- previous migration. The new indexes above are the authoritative constraints.
