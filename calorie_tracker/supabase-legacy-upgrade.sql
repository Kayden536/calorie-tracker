-- MacroSync consolidated legacy upgrade
--
-- Use this ONLY to upgrade an existing database that was built from the
-- older MacroSync/PulsePlate SQL files. For a brand-new database, use
-- supabase-schema.sql instead; it already contains the final current state.
--
-- The sections below preserve the original migrations and their intended
-- dependency order. Do not run this file and the full schema on the same
-- empty database.



-- ==========================================================
-- LEGACY MIGRATION 1: supabase-goal-system-migration.sql
-- ==========================================================

-- MacroSync goal system migration.
-- Adds the eight selectable goal types while preserving legacy profile values.

alter table public.profiles drop constraint if exists profiles_primary_goal_check;
alter table public.profiles drop constraint if exists profiles_primary_goal_fkey;
update public.profiles set primary_goal = 'lose_basic' where primary_goal = 'lose';
update public.profiles set primary_goal = 'gain_basic' where primary_goal = 'gain';
update public.profiles set primary_goal = 'maintain' where primary_goal = 'health';

alter table public.profiles add constraint profiles_primary_goal_check check (
  primary_goal in ('lose_basic','lose_muscle','lose_gain_muscle','gain_basic','gain_muscle_maintain_fat','lean_bulk','maintain','recomp','custom','other')
);

-- Optional low-carb flag is stored with the nutrition plan so the Recomp choice can be remembered.
alter table public.nutrition_goals add column if not exists low_carb boolean not null default false;

comment on column public.nutrition_goals.low_carb is 'True only when the user selects the low-carb Recomp variation: 40 g carbs, fat fills remaining calories.';


-- ==========================================================
-- LEGACY MIGRATION 2: supabase-recipes-sharing-migration.sql
-- ==========================================================

-- MacroSync recipe sharing and public recipe search. Run after the main schema.
alter table public.recipes add column if not exists is_public boolean not null default false;
create index if not exists recipes_public_name_idx on public.recipes(is_public, name);
alter table public.recipes enable row level security;
drop policy if exists "recipes public read" on public.recipes;
create policy "recipes public read" on public.recipes for select to authenticated using (is_public = true or auth.uid() = user_id);
alter table public.recipe_items enable row level security;
drop policy if exists "recipe items public read" on public.recipe_items;
create policy "recipe items public read" on public.recipe_items for select to authenticated using (exists (select 1 from public.recipes r where r.id = recipe_items.recipe_id and (r.is_public = true or r.user_id = auth.uid())));


-- ==========================================================
-- LEGACY MIGRATION 3: supabase-meals-migration.sql
-- ==========================================================

-- MacroSync configurable meals migration.
--
-- IMPORTANT: This migration is designed for the existing MacroSync database.
-- The meals table used by the current database has a UUID id and a required
-- sort_order column. Do not omit sort_order when inserting meals.

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  meal_number integer not null check (meal_number between 1 and 10),
  name text not null check (char_length(trim(name)) between 1 and 40),
  sort_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If the table already exists from an earlier meal migration, make sure the
-- required ordering column exists and has a value before any inserts occur.
alter table public.meals add column if not exists sort_order integer;
alter table public.meals add column if not exists updated_at timestamptz not null default now();

update public.meals
set sort_order = meal_number
where sort_order is null;

alter table public.meals alter column sort_order set default 1;
alter table public.meals alter column sort_order set not null;

-- Meal-name uniqueness is date-scoped by supabase-meals-per-day-migration.sql.
-- Remove any legacy user-wide name index before the date-scoped migration runs.
drop index if exists public.meals_user_name_unique;
drop index if exists public.meals_user_id_name_unique;
create index if not exists meals_user_order_idx
  on public.meals(user_id, sort_order);

alter table public.meals enable row level security;

drop policy if exists "meals own rows" on public.meals;
drop policy if exists "meals insert own rows" on public.meals;
drop policy if exists "meals update own rows" on public.meals;
create policy "meals own rows" on public.meals
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Convert the original fixed meal labels to the new numbered defaults.
-- sort_order is required by the existing meals table.
insert into public.meals(user_id, meal_number, name, sort_order)
select p.id, n, 'Meal ' || n, n
from public.profiles p
cross join generate_series(1,3) as gs(n)
where not exists (
  select 1 from public.meals m
  where m.user_id = p.id and m.meal_number = n
);

update public.food_entries
set meal = case lower(trim(meal))
  when 'breakfast' then 'Meal 1'
  when 'lunch' then 'Meal 2'
  when 'dinner' then 'Meal 3'
  when 'snack' then 'Meal 4'
  when 'meal' then 'Meal 1'
  else meal
end
where lower(trim(meal)) in ('breakfast','lunch','dinner','snack','meal');

-- Legacy Snack entries become Meal 4, so create that meal only when needed.
insert into public.meals(user_id, meal_number, name, sort_order)
select distinct fe.user_id, 4, 'Meal 4', 4
from public.food_entries fe
where fe.meal = 'Meal 4'
  and not exists (
    select 1 from public.meals m
    where m.user_id = fe.user_id and m.meal_number = 4
  );

alter table public.food_entries alter column meal set default 'Meal 1';

-- Remove both possible older signatures so there is never an ambiguous RPC.
drop function if exists public.ensure_default_meals();
drop function if exists public.add_meal(text);
drop function if exists public.add_meal(text, uuid);
drop function if exists public.rename_meal(uuid, text);
drop function if exists public.rename_meal(bigint, text);

create function public.ensure_default_meals()
returns setof public.meals
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  insert into public.meals(user_id, meal_number, name, sort_order)
  select auth.uid(), n, 'Meal ' || n, n
  from generate_series(1,3) gs(n)
  where not exists (
    select 1 from public.meals m
    where m.user_id = auth.uid() and m.meal_number = n
  );

  return query
    select *
    from public.meals
    where user_id = auth.uid()
    order by meal_number;
end;
$$;
grant execute on function public.ensure_default_meals() to authenticated;

create function public.add_meal(p_name text default null)
returns public.meals
language plpgsql
security definer
set search_path = public
as $$
declare
  next_number integer;
  meal_row public.meals;
  clean_name text := nullif(trim(coalesce(p_name,'')), '');
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select min(n) into next_number
  from generate_series(1,10) gs(n)
  where not exists (
    select 1
    from public.meals m
    where m.user_id = auth.uid()
      and m.meal_number = n
  );

  if next_number is null then
    raise exception 'You can have up to 10 meals.';
  end if;

  if clean_name is null then
    clean_name := 'Meal ' || next_number;
  end if;

  if char_length(clean_name) > 40 then
    raise exception 'Meal names must be 40 characters or fewer.';
  end if;

  if exists (
    select 1 from public.meals m
    where m.user_id = auth.uid()
      and lower(trim(m.name)) = lower(clean_name)
  ) then
    raise exception 'You already have a meal with that name.';
  end if;

  insert into public.meals(user_id, meal_number, name, sort_order)
  values(auth.uid(), next_number, clean_name, next_number)
  returning * into meal_row;

  return meal_row;
end;
$$;
grant execute on function public.add_meal(text) to authenticated;

create function public.rename_meal(p_meal_id uuid, p_name text)
returns public.meals
language plpgsql
security definer
set search_path = public
as $$
declare
  meal_row public.meals;
  clean_name text := nullif(trim(coalesce(p_name,'')), '');
  old_name text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if clean_name is null then
    raise exception 'Meal name cannot be empty.';
  end if;

  if char_length(clean_name) > 40 then
    raise exception 'Meal names must be 40 characters or fewer.';
  end if;

  select * into meal_row
  from public.meals
  where id = p_meal_id
    and user_id = auth.uid()
  for update;

  if meal_row.id is null then
    raise exception 'Meal not found.';
  end if;

  if exists (
    select 1 from public.meals m
    where m.user_id = auth.uid()
      and m.id <> p_meal_id
      and lower(trim(m.name)) = lower(clean_name)
  ) then
    raise exception 'You already have a meal with that name.';
  end if;

  old_name := meal_row.name;

  update public.food_entries
  set meal = clean_name
  where user_id = auth.uid()
    and meal = old_name;

  update public.meals
  set name = clean_name,
      updated_at = now()
  where id = p_meal_id
    and user_id = auth.uid()
  returning * into meal_row;

  return meal_row;
end;
$$;
grant execute on function public.rename_meal(uuid, text) to authenticated;

-- Make sure the first three meals exist for every existing profile, including
-- accounts created before the configurable-meal feature was added.
insert into public.meals(user_id, meal_number, name, sort_order)
select p.id, n, 'Meal ' || n, n
from public.profiles p
cross join generate_series(1,3) as gs(n)
where not exists (
  select 1 from public.meals m
  where m.user_id = p.id and m.meal_number = n
);

-- Food database sharing: save one food to My Foods and Community Foods together.
alter table public.user_foods add column if not exists community_food_id bigint references public.community_foods(id) on delete set null;
alter table public.community_foods add column if not exists personal_food_id bigint references public.user_foods(id) on delete set null;
alter table public.user_foods drop constraint if exists user_foods_source_check;
alter table public.user_foods add constraint user_foods_source_check check (source in ('manual','usda','community'));
create index if not exists user_foods_community_food_idx on public.user_foods(community_food_id);
create index if not exists community_foods_personal_food_idx on public.community_foods(personal_food_id);

create or replace function public.create_food_records(
  p_name text,
  p_calories_per_100g numeric,
  p_protein_per_100g numeric,
  p_carbs_per_100g numeric,
  p_fat_per_100g numeric,
  p_serving_amount numeric,
  p_serving_unit text,
  p_serving_grams numeric,
  p_save_personal boolean default true,
  p_publish_community boolean default true,
  p_personal_calories numeric default null,
  p_personal_protein numeric default null,
  p_personal_carbs numeric default null,
  p_personal_fat numeric default null,
  p_personal_source text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  community_id bigint;
  personal_id bigint;
  personal_cal numeric;
  personal_pro numeric;
  personal_carb numeric;
  personal_fat numeric;
  clean_name text := nullif(trim(coalesce(p_name,'')), '');
  unit text := nullif(trim(coalesce(p_serving_unit,'')), '');
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if clean_name is null then raise exception 'Food name cannot be empty.'; end if;
  if char_length(clean_name) > 120 then raise exception 'Food names must be 120 characters or fewer.'; end if;
  if not p_save_personal and not p_publish_community then raise exception 'Choose at least one database.'; end if;
  if coalesce(p_serving_grams,0) <= 0 or coalesce(p_serving_amount,0) <= 0 then raise exception 'Serving weight and serving amount must be positive.'; end if;
  if p_calories_per_100g < 0 or p_protein_per_100g < 0 or p_carbs_per_100g < 0 or p_fat_per_100g < 0 then raise exception 'Nutrition values cannot be negative.'; end if;
  if p_protein_per_100g + p_carbs_per_100g + p_fat_per_100g > 100.5 then raise exception 'The macros exceed 100 g per 100 g and cannot be saved.'; end if;
  unit := coalesce(unit, 'serving');

  personal_cal := coalesce(p_personal_calories, p_calories_per_100g * p_serving_grams / 100);
  personal_pro := coalesce(p_personal_protein, p_protein_per_100g * p_serving_grams / 100);
  personal_carb := coalesce(p_personal_carbs, p_carbs_per_100g * p_serving_grams / 100);
  personal_fat := coalesce(p_personal_fat, p_fat_per_100g * p_serving_grams / 100);

  if p_publish_community then
    insert into public.community_foods(
      user_id, name, calories_per_100g, protein_per_100g, carbs_per_100g,
      fat_per_100g, serving_options, is_public
    ) values (
      auth.uid(), clean_name, p_calories_per_100g, p_protein_per_100g,
      p_carbs_per_100g, p_fat_per_100g,
      jsonb_build_array(jsonb_build_object('amount', p_serving_amount, 'unit', unit, 'grams', p_serving_grams)),
      true
    ) returning id into community_id;
  end if;

  if p_save_personal then
    insert into public.user_foods(
      user_id, name, serving_amount, serving_unit, calories, protein, carbs, fat,
      source, community_food_id
    ) values (
      auth.uid(), clean_name, p_serving_amount, unit, personal_cal, personal_pro,
      personal_carb, personal_fat, coalesce(nullif(p_personal_source,''), 'manual'), community_id
    ) returning id into personal_id;
  end if;

  if community_id is not null and personal_id is not null then
    update public.community_foods set personal_food_id = personal_id where id = community_id;
  end if;

  return jsonb_build_object('community_food_id', community_id, 'personal_food_id', personal_id);
end;
$$;
grant execute on function public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text) to authenticated;

-- Allow users to remove optional meals while always retaining at least three.
-- A meal must be empty for the current user before it can be deleted; this
-- prevents silently orphaning food entries that store the meal name as text.
drop function if exists public.delete_meal(uuid);
create function public.delete_meal(p_meal_id uuid)
returns public.meals
language plpgsql
security definer
set search_path = public
as $$
declare
  meal_row public.meals;
  remaining_count integer;
  logged_count integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select count(*) into remaining_count
  from public.meals
  where user_id = auth.uid();

  if remaining_count <= 3 then
    raise exception 'MacroSync requires at least 3 meals.';
  end if;

  select * into meal_row
  from public.meals
  where id = p_meal_id and user_id = auth.uid()
  for update;

  if meal_row.id is null then
    raise exception 'Meal not found.';
  end if;

  select count(*) into logged_count
  from public.food_entries
  where user_id = auth.uid() and meal = meal_row.name;

  if logged_count > 0 then
    raise exception 'Move or delete the foods logged under this meal before deleting it.';
  end if;

  delete from public.meals
  where id = p_meal_id and user_id = auth.uid();

  return meal_row;
end;
$$;
grant execute on function public.delete_meal(uuid) to authenticated;


-- ==========================================================
-- LEGACY MIGRATION 4: supabase-meals-per-day-migration.sql
-- ==========================================================

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


-- ==========================================================
-- LEGACY MIGRATION 5: supabase-serving-options-migration.sql
-- ==========================================================

-- MacroSync serving options migration (v27)
-- Run this in Supabase SQL Editor after the main schema.

alter table public.user_foods add column if not exists serving_grams numeric not null default 100 check (serving_grams > 0);
alter table public.user_foods add column if not exists serving_options jsonb not null default '[]'::jsonb;
alter table public.user_foods add column if not exists conversion_mode text not null default 'estimate';
alter table public.user_foods drop constraint if exists user_foods_conversion_mode_check;
alter table public.user_foods add constraint user_foods_conversion_mode_check check (conversion_mode in ('none','estimate'));

alter table public.community_foods add column if not exists conversion_mode text not null default 'estimate';
alter table public.community_foods drop constraint if exists community_foods_conversion_mode_check;
alter table public.community_foods add constraint community_foods_conversion_mode_check check (conversion_mode in ('none','estimate'));

-- Replace the old RPC so new food records can store creator-provided serving options.
drop function if exists public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text);
create or replace function public.create_food_records(
  p_name text, p_calories_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_serving_amount numeric, p_serving_unit text, p_serving_grams numeric, p_save_personal boolean default true, p_publish_community boolean default true,
  p_personal_calories numeric default null, p_personal_protein numeric default null, p_personal_carbs numeric default null, p_personal_fat numeric default null,
  p_personal_source text default 'manual', p_serving_options jsonb default '[]'::jsonb, p_conversion_mode text default 'estimate'
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare community_id bigint; personal_id bigint; clean_name text := nullif(trim(coalesce(p_name,'')), ''); unit text := nullif(trim(coalesce(p_serving_unit,'')), ''); opts jsonb := coalesce(p_serving_options,'[]'::jsonb);
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if clean_name is null then raise exception 'Food name cannot be empty.'; end if;
  if char_length(clean_name)>120 then raise exception 'Food names must be 120 characters or fewer.'; end if;
  if not p_save_personal and not p_publish_community then raise exception 'Choose at least one database.'; end if;
  if coalesce(p_serving_grams,0)<=0 or coalesce(p_serving_amount,0)<=0 then raise exception 'Default serving weight and amount must be positive.'; end if;
  if p_conversion_mode not in ('none','estimate') then raise exception 'Invalid conversion mode.'; end if;
  if jsonb_typeof(opts)<>'array' then raise exception 'Serving options must be an array.'; end if;
  if p_calories_per_100g<0 or p_protein_per_100g<0 or p_carbs_per_100g<0 or p_fat_per_100g<0 then raise exception 'Nutrition values cannot be negative.'; end if;
  if p_protein_per_100g+p_carbs_per_100g+p_fat_per_100g>100.5 then raise exception 'The macros exceed 100 g per 100 g and cannot be saved.'; end if;
  unit:=coalesce(unit,'serving');
  if p_publish_community then
    insert into public.community_foods(user_id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,serving_options,conversion_mode,is_public)
    values(auth.uid(),clean_name,p_calories_per_100g,p_protein_per_100g,p_carbs_per_100g,p_fat_per_100g,
      jsonb_build_array(jsonb_build_object('amount',p_serving_amount,'unit',unit,'grams',p_serving_grams,'calories',coalesce(p_personal_calories,p_calories_per_100g*p_serving_grams/100),'protein',coalesce(p_personal_protein,p_protein_per_100g*p_serving_grams/100),'carbs',coalesce(p_personal_carbs,p_carbs_per_100g*p_serving_grams/100),'fat',coalesce(p_personal_fat,p_fat_per_100g*p_serving_grams/100))) || opts,p_conversion_mode,true) returning id into community_id;
  end if;
  if p_save_personal then
    insert into public.user_foods(user_id,name,serving_amount,serving_unit,serving_grams,serving_options,conversion_mode,calories,protein,carbs,fat,source,community_food_id)
    values(auth.uid(),clean_name,p_serving_amount,unit,p_serving_grams,opts,p_conversion_mode,coalesce(p_personal_calories,p_calories_per_100g*p_serving_grams/100),coalesce(p_personal_protein,p_protein_per_100g*p_serving_grams/100),coalesce(p_personal_carbs,p_carbs_per_100g*p_serving_grams/100),coalesce(p_personal_fat,p_fat_per_100g*p_serving_grams/100),coalesce(nullif(p_personal_source,''),'manual'),community_id) returning id into personal_id;
  end if;
  if community_id is not null and personal_id is not null then update public.community_foods set personal_food_id=personal_id where id=community_id; end if;
  return jsonb_build_object('community_food_id',community_id,'personal_food_id',personal_id);
end; $$;
grant execute on function public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text,jsonb,text) to authenticated;

-- Existing personal foods did not previously store a reliable gram weight.
-- Keep their original serving only rather than offering potentially misleading conversions.
update public.user_foods
set conversion_mode = 'none'
where coalesce(jsonb_array_length(serving_options), 0) = 0;


-- ==========================================================
-- LEGACY MIGRATION 6: supabase-food-edit-migration.sql
-- ==========================================================

-- MacroSync food/recipe editing support.
-- Run this against an existing database upgraded from an earlier MacroSync version.
-- The current schema already contains these policies; this file makes them explicit/idempotent.

alter table public.community_foods enable row level security;
drop policy if exists "community foods update own" on public.community_foods;
create policy "community foods update own" on public.community_foods
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.user_foods enable row level security;
drop policy if exists "user foods update own rows" on public.user_foods;
create policy "user foods update own rows" on public.user_foods
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.recipes enable row level security;
drop policy if exists "recipes update own rows" on public.recipes;
create policy "recipes update own rows" on public.recipes
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.recipe_items enable row level security;
drop policy if exists "recipe items update own rows" on public.recipe_items;
create policy "recipe items update own rows" on public.recipe_items
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ==========================================================
-- LEGACY MIGRATION 7: supabase-trainer-profile-migration.sql
-- ==========================================================

-- MacroSync trainer directory/profile foundation.
-- Compact, structured fields keep storage and search costs low.
create table if not exists public.trainer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bio text,
  location text,
  phone text,
  instagram text,
  facebook text,
  tiktok text,
  youtube text,
  website text,
  training_types smallint[] not null default '{}',
  price_range smallint,
  years_experience smallint,
  is_public boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint trainer_bio_length check (bio is null or char_length(bio) <= 5000),
  constraint trainer_bio_word_limit check (bio is null or char_length(trim(bio)) = 0 or cardinality(regexp_split_to_array(trim(bio), '\s+')) <= 250),
  constraint trainer_location_length check (location is null or char_length(location) <= 160),
  constraint trainer_phone_length check (phone is null or char_length(phone) <= 32),
  constraint trainer_years_experience check (years_experience is null or years_experience between 0 and 100),
  constraint trainer_price_range check (price_range is null or price_range between 1 and 6),
  constraint trainer_training_types_count check (cardinality(training_types) <= 12)
);

alter table public.trainer_profiles enable row level security;
drop policy if exists "trainer profiles own read" on public.trainer_profiles;
drop policy if exists "trainer profiles own insert" on public.trainer_profiles;
drop policy if exists "trainer profiles own update" on public.trainer_profiles;
drop policy if exists "trainer profiles own delete" on public.trainer_profiles;
drop policy if exists "trainer profiles public read" on public.trainer_profiles;
create policy "trainer profiles own read" on public.trainer_profiles for select to authenticated using (auth.uid() = user_id);
create policy "trainer profiles own insert" on public.trainer_profiles for insert to authenticated with check (auth.uid() = user_id and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer'));
create policy "trainer profiles own update" on public.trainer_profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer'));
create policy "trainer profiles own delete" on public.trainer_profiles for delete to authenticated using (auth.uid() = user_id);
create policy "trainer profiles public read" on public.trainer_profiles for select to authenticated using (is_public = true and not public.is_limited_minor());

create index if not exists trainer_profiles_public_location_idx on public.trainer_profiles(is_public, location) where is_public = true;

drop function if exists public.search_trainers(text,smallint,smallint);
create function public.search_trainers(p_query text default '', p_training_type smallint default null, p_price_range smallint default null)
returns table(user_id uuid, display_name text, business_name text, bio text, location text, phone text, instagram text, facebook text, tiktok text, youtube text, website text, training_types smallint[], price_range smallint, years_experience smallint)
language sql stable security definer set search_path=public as $$
  select tp.user_id, p.display_name, p.business_name, tp.bio, tp.location, tp.phone, tp.instagram, tp.facebook, tp.tiktok, tp.youtube, tp.website, tp.training_types, tp.price_range, tp.years_experience
  from public.trainer_profiles tp
  join public.profiles p on p.id = tp.user_id
  where tp.is_public = true
    and p.role = 'trainer'
    and not public.is_limited_minor()
    and (trim(coalesce(p_query,'')) = '' or p.display_name ilike '%' || trim(p_query) || '%' or coalesce(p.business_name,'') ilike '%' || trim(p_query) || '%' or coalesce(tp.location,'') ilike '%' || trim(p_query) || '%' or coalesce(tp.bio,'') ilike '%' || trim(p_query) || '%')
    and (p_training_type is null or p_training_type = any(tp.training_types))
    and (p_price_range is null or tp.price_range = p_price_range)
  order by p.display_name
  limit 100;
$$;
grant execute on function public.search_trainers(text,smallint,smallint) to authenticated;

drop function if exists public.get_trainer_profile(uuid);
create function public.get_trainer_profile(p_trainer_id uuid)
returns table(user_id uuid, display_name text, business_name text, bio text, location text, phone text, instagram text, facebook text, tiktok text, youtube text, website text, training_types smallint[], price_range smallint, years_experience smallint)
language sql stable security definer set search_path=public as $$
  select tp.user_id, p.display_name, p.business_name, tp.bio, tp.location, tp.phone, tp.instagram, tp.facebook, tp.tiktok, tp.youtube, tp.website, tp.training_types, tp.price_range, tp.years_experience
  from public.trainer_profiles tp
  join public.profiles p on p.id = tp.user_id
  where tp.user_id = p_trainer_id and p.role = 'trainer' and (tp.is_public = true or tp.user_id = auth.uid());
$$;
grant execute on function public.get_trainer_profile(uuid) to authenticated;

-- Directory connections are client -> trainer only; ordinary friend discovery remains separate.
create or replace function public.request_trainer_connection(p_trainer_id uuid)
returns public.friend_connections
language plpgsql security definer set search_path=public as $$
declare r public.friend_connections;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if exists (select 1 from public.profiles where id=auth.uid() and role='trainer') then raise exception 'Trainer accounts cannot send trainer-directory requests.'; end if;
  if not exists (select 1 from public.trainer_profiles tp join public.profiles p on p.id=tp.user_id where tp.user_id=p_trainer_id and tp.is_public=true and p.role='trainer') then raise exception 'That trainer is not currently listed.'; end if;
  insert into public.friend_connections(requester_id,addressee_id,status) values(auth.uid(),p_trainer_id,'pending') returning * into r;
  return r;
exception when unique_violation then
  raise exception 'A connection request already exists.';
end;
$$;
revoke all on function public.request_trainer_connection(uuid) from public;
grant execute on function public.request_trainer_connection(uuid) to authenticated;


-- ==========================================================
-- LEGACY MIGRATION 8: supabase-terms-privacy-minor-migration.sql
-- ==========================================================

-- MacroSync Terms, privacy, and parental-consent columns
alter table public.profiles add column if not exists terms_version text;
alter table public.profiles add column if not exists privacy_version text;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists privacy_accepted_at timestamptz;
alter table public.profiles add column if not exists parental_consent_required boolean not null default false;
alter table public.profiles add column if not exists parental_consent_status text not null default 'not_required' check (parental_consent_status in ('not_required','pending','approved','denied'));
alter table public.profiles add column if not exists parent_guardian_email text;
alter table public.profiles add column if not exists parental_consent_approved_at timestamptz;

-- ================================================================
-- Terms, privacy acceptance, and limited accounts for ages 13-15
-- ================================================================
create or replace function public.user_age_years(p_user_id uuid default auth.uid())
returns integer
language sql stable security definer set search_path=public
as $$
  select case when p.date_of_birth is null then null else
    extract(year from age(current_date, p.date_of_birth))::integer end
  from public.profiles p
  where p.id = p_user_id;
$$;
grant execute on function public.user_age_years(uuid) to authenticated;

create or replace function public.is_limited_minor(p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer set search_path=public
as $$
  select coalesce(public.user_age_years(p_user_id) between 13 and 15, false)
    and exists (
      select 1 from public.profiles p
      where p.id=p_user_id and p.parental_consent_status <> 'approved'
    );
$$;
grant execute on function public.is_limited_minor(uuid) to authenticated;

-- Parent/guardian approval is completed by confirming the parent/guardian email
-- address used for a 13-15 account. The RPC, rather than a client-side update,
-- is the only route that can move consent from pending to approved.
create or replace function public.approve_parental_consent()
returns boolean
language plpgsql security definer set search_path=public,auth
as $$
declare
  profile_row public.profiles;
  confirmed_at timestamptz;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into profile_row from public.profiles where id=auth.uid();
  if profile_row.id is null then raise exception 'Profile not found.'; end if;
  if public.user_age_years(auth.uid()) not between 13 and 15 then return true; end if;
  select email_confirmed_at into confirmed_at from auth.users where id=auth.uid();
  if confirmed_at is null then raise exception 'The parent or legal guardian must complete the email confirmation before this account can be approved.'; end if;
  if nullif(lower(trim(profile_row.parent_guardian_email)), '') is null then raise exception 'Parent or legal guardian email is missing.'; end if;
  if lower(trim(profile_row.parent_guardian_email)) <> lower(trim(coalesce((select email from auth.users where id=auth.uid()),''))) then raise exception 'The approved email does not match the parent or legal guardian email on the account.'; end if;
  perform set_config('macrosync.parent_consent_approval','true',true);
  update public.profiles
    set parental_consent_status='approved', parental_consent_approved_at=now()
  where id=auth.uid() and parental_consent_status <> 'approved';
  return true;
end;
$$;
grant execute on function public.approve_parental_consent() to authenticated;

-- Protect the consent status from ordinary client updates. The approval RPC sets
-- a transaction-local flag that this trigger recognizes.
create or replace function public.protect_parental_consent()
returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and new.parental_consent_status is distinct from old.parental_consent_status
     and coalesce(current_setting('macrosync.parent_consent_approval', true),'') <> 'true' then
    raise exception 'Parental consent status can only be changed through the consent process.';
  end if;
  if tg_op='UPDATE' and old.parent_guardian_email is not null and new.parent_guardian_email is distinct from old.parent_guardian_email then
    raise exception 'Parent or legal guardian email cannot be changed after signup.';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_parental_consent on public.profiles;
create trigger protect_parental_consent before update of parental_consent_status,parent_guardian_email on public.profiles
for each row execute function public.protect_parental_consent();

-- A limited account can only use food logging and the food database. The database
-- remains the enforcement boundary; hiding navigation in the browser is not enough.
drop policy if exists "goals own row" on public.nutrition_goals;
drop policy if exists "goals insert own row" on public.nutrition_goals;
drop policy if exists "goals update own row" on public.nutrition_goals;
create policy "goals own row" on public.nutrition_goals for select using (auth.uid() = user_id and not public.is_limited_minor());
create policy "goals insert own row" on public.nutrition_goals for insert with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "goals update own row" on public.nutrition_goals for update using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());

-- Meals are required for food logging, so limited accounts may use their own meals.
drop policy if exists "meals own rows" on public.meals;
drop policy if exists "meals insert own rows" on public.meals;
drop policy if exists "meals update own rows" on public.meals;
create policy "meals own rows" on public.meals for select to authenticated using (
  auth.uid() = user_id
  or (not public.is_limited_minor() and exists (
    select 1 from public.friend_connections c
    join public.profiles viewer on viewer.id=auth.uid()
    join public.profiles owner on owner.id=public.meals.user_id
    where c.status='accepted'
      and ((c.requester_id=auth.uid() and c.addressee_id=public.meals.user_id) or (c.requester_id=public.meals.user_id and c.addressee_id=auth.uid()))
      and ((viewer.role='trainer' and owner.role='user') or case when c.requester_id=public.meals.user_id then c.requester_share_meals else c.addressee_share_meals end=true)
  ))
);
create policy "meals insert own rows" on public.meals for insert to authenticated with check (auth.uid() = user_id);
create policy "meals update own rows" on public.meals for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Disable social connections for limited accounts at the RLS boundary.
drop policy if exists "friends participants read" on public.friend_connections;
drop policy if exists "friends requester insert" on public.friend_connections;
drop policy if exists "friends participants update" on public.friend_connections;
create policy "friends participants read" on public.friend_connections for select to authenticated using ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor());
create policy "friends requester insert" on public.friend_connections for insert to authenticated with check (auth.uid() = requester_id and not public.is_limited_minor() and not public.is_limited_minor(addressee_id));
create policy "friends participants update" on public.friend_connections for update to authenticated using ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor()) with check ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor() and not public.is_limited_minor(requester_id) and not public.is_limited_minor(addressee_id));

-- Messaging is disabled for limited accounts and their direct reads.
drop policy if exists "messages participants read" on public.messages;
drop policy if exists "messages sender insert" on public.messages;
drop policy if exists "messages participants update" on public.messages;
drop policy if exists "messages sender delete" on public.messages;
create policy "messages participants read" on public.messages for select to authenticated using (not public.is_limited_minor() and (auth.uid() = sender_id or auth.uid() = recipient_id));
create policy "messages sender insert" on public.messages for insert to authenticated with check (not public.is_limited_minor() and auth.uid() = sender_id and not public.is_limited_minor(recipient_id) and exists (select 1 from public.friend_connections c where c.status = 'accepted' and ((c.requester_id = sender_id and c.addressee_id = recipient_id) or (c.requester_id = recipient_id and c.addressee_id = sender_id))));
create policy "messages participants update" on public.messages for update to authenticated using (not public.is_limited_minor() and (auth.uid() = sender_id or auth.uid() = recipient_id)) with check (not public.is_limited_minor() and (auth.uid() = sender_id or auth.uid() = recipient_id));
create policy "messages sender delete" on public.messages for delete to authenticated using (not public.is_limited_minor() and auth.uid() = sender_id);

-- Progress tracking is unavailable to limited accounts.
drop policy if exists "weight logs own rows" on public.weight_logs;
drop policy if exists "weight logs insert own rows" on public.weight_logs;
drop policy if exists "weight logs update own rows" on public.weight_logs;
drop policy if exists "weight logs delete own rows" on public.weight_logs;
create policy "weight logs own rows" on public.weight_logs for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "weight logs insert own rows" on public.weight_logs for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "weight logs update own rows" on public.weight_logs for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "weight logs delete own rows" on public.weight_logs for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "body measurements own rows" on public.body_measurements;
drop policy if exists "body measurements insert own rows" on public.body_measurements;
drop policy if exists "body measurements update own rows" on public.body_measurements;
drop policy if exists "body measurements delete own rows" on public.body_measurements;
create policy "body measurements own rows" on public.body_measurements for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "body measurements insert own rows" on public.body_measurements for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "body measurements update own rows" on public.body_measurements for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "body measurements delete own rows" on public.body_measurements for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

-- Recipes and saved meals are unavailable to limited accounts.
drop policy if exists "recipes own rows" on public.recipes;
drop policy if exists "recipes insert own rows" on public.recipes;
drop policy if exists "recipes update own rows" on public.recipes;
drop policy if exists "recipes delete own rows" on public.recipes;
create policy "recipes own rows" on public.recipes for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipes insert own rows" on public.recipes for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipes update own rows" on public.recipes for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipes delete own rows" on public.recipes for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "recipe items own rows" on public.recipe_items;
drop policy if exists "recipe items insert own rows" on public.recipe_items;
drop policy if exists "recipe items update own rows" on public.recipe_items;
drop policy if exists "recipe items delete own rows" on public.recipe_items;
create policy "recipe items own rows" on public.recipe_items for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipe items insert own rows" on public.recipe_items for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor() and exists (select 1 from public.recipes r where r.id=recipe_items.recipe_id and r.user_id=auth.uid()));
create policy "recipe items update own rows" on public.recipe_items for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipe items delete own rows" on public.recipe_items for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "saved meals own rows" on public.saved_meals;
drop policy if exists "saved meals insert own rows" on public.saved_meals;
drop policy if exists "saved meals update own rows" on public.saved_meals;
drop policy if exists "saved meals delete own rows" on public.saved_meals;
create policy "saved meals own rows" on public.saved_meals for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meals insert own rows" on public.saved_meals for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meals update own rows" on public.saved_meals for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meals delete own rows" on public.saved_meals for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "saved meal items own rows" on public.saved_meal_items;
drop policy if exists "saved meal items insert own rows" on public.saved_meal_items;
drop policy if exists "saved meal items update own rows" on public.saved_meal_items;
drop policy if exists "saved meal items delete own rows" on public.saved_meal_items;
create policy "saved meal items own rows" on public.saved_meal_items for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meal items insert own rows" on public.saved_meal_items for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor() and exists (select 1 from public.saved_meals m where m.id=saved_meal_items.saved_meal_id and m.user_id=auth.uid()));
create policy "saved meal items update own rows" on public.saved_meal_items for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meal items delete own rows" on public.saved_meal_items for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

-- Notifications and feedback are not available to limited accounts.
drop policy if exists "notifications recipient read" on public.notifications;
drop policy if exists "notifications recipient update" on public.notifications;
create policy "notifications recipient read" on public.notifications for select to authenticated using (auth.uid() = recipient_id and not public.is_limited_minor());
create policy "notifications recipient update" on public.notifications for update to authenticated using (auth.uid() = recipient_id and not public.is_limited_minor()) with check (auth.uid() = recipient_id and not public.is_limited_minor());

drop policy if exists "feedback insert own rows" on public.feedback;
drop policy if exists "feedback own rows read" on public.feedback;
create policy "feedback insert own rows" on public.feedback for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "feedback own rows read" on public.feedback for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

-- Do not expose a limited account's parent/guardian email through profile discovery.
create or replace function public.search_people(p_query text)
returns table(id uuid,display_name text,email text,role text,business_name text)
language sql stable security definer set search_path=public as $$
  select p.id,p.display_name,
         case when p.email_search_enabled and not p.parental_consent_required then p.email else null end,
         p.role,p.business_name
  from public.profiles p
  where p.id <> auth.uid()
    and not public.is_limited_minor()
    and (trim(coalesce(p_query,''))='' or p.display_name ilike '%'||trim(p_query)||'%' or (p.email_search_enabled and not p.parental_consent_required and p.email ilike '%'||trim(p_query)||'%'))
  order by p.display_name
  limit 50;
$$;
grant execute on function public.search_people(text) to authenticated;

-- Meal sharing policies must also reject limited accounts.
drop policy if exists "food entries own rows" on public.food_entries;
create policy "food entries own rows" on public.food_entries for select to authenticated using (
  auth.uid() = user_id
  or (not public.is_limited_minor() and exists (
    select 1 from public.friend_connections c
    join public.profiles viewer on viewer.id = auth.uid()
    join public.profiles owner on owner.id = food_entries.user_id
    where c.status = 'accepted'
      and ((c.requester_id = auth.uid() and c.addressee_id = food_entries.user_id)
        or (c.requester_id = food_entries.user_id and c.addressee_id = auth.uid()))
      and ((viewer.role = 'trainer' and owner.role = 'user') or case when c.requester_id = food_entries.user_id then c.requester_share_meals else c.addressee_share_meals end = true)
  ))
);


-- Prevent unrelated users from reading profile contact fields directly.
drop policy if exists "authenticated profiles discovery" on public.profiles;
create policy "authenticated profiles discovery" on public.profiles for select to authenticated using (
  auth.uid() = id
  or exists (
    select 1 from public.friend_connections c
    where c.status='accepted'
      and ((c.requester_id=auth.uid() and c.addressee_id=profiles.id)
        or (c.requester_id=profiles.id and c.addressee_id=auth.uid()))
  )
);


drop function if exists public.set_meal_sharing(bigint, boolean);
create or replace function public.set_meal_sharing(connection_id bigint, enabled boolean)
returns public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.friend_connections;
  my_role text;
  other_role text;
  other_user_id uuid;
begin
  if public.is_limited_minor() then raise exception 'Meal sharing is not available to limited accounts for users ages 13–15.'; end if;
  select *
    into connection_row
    from public.friend_connections
   where id = connection_id
     and status = 'accepted'
     and (requester_id = auth.uid() or addressee_id = auth.uid());

  if connection_row.id is null then
    raise exception 'Accepted friend connection not found.';
  end if;

  other_user_id := case
    when connection_row.requester_id = auth.uid() then connection_row.addressee_id
    else connection_row.requester_id
  end;

  select role into my_role from public.profiles where id = auth.uid();
  select role into other_role from public.profiles where id = other_user_id;

  -- A Personal user connected to a Personal Trainer must share their own
  -- food log with that trainer. The trainer can still independently choose
  -- whether to share the trainer's own food log with the client.
  update public.friend_connections
     set requester_share_meals = case
           when requester_id = auth.uid() then
             case
               when my_role = 'user' and other_role = 'trainer' then true
               else enabled
             end
           else requester_share_meals
         end,
         addressee_share_meals = case
           when addressee_id = auth.uid() then
             case
               when my_role = 'user' and other_role = 'trainer' then true
               else enabled
             end
           else addressee_share_meals
         end,
         share_meals = (
           case when requester_id = auth.uid() then enabled else requester_share_meals end
           or case when addressee_id = auth.uid() then enabled else addressee_share_meals end
         ),
         updated_at = now()
   where id = connection_row.id
  returning * into connection_row;

  return connection_row;
end;
$$;

grant execute on function public.set_meal_sharing(bigint, boolean) to authenticated;


create or replace function public.get_conversation_messages(p_friend_id uuid)
returns table(id bigint, sender_id uuid, recipient_id uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path=public
as $$
declare
  viewer_dob date;
  viewer_minor boolean;
  m record;
  blocked text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if public.is_limited_minor() then raise exception 'Messaging is not available to limited accounts for users ages 13–15.'; end if;
  select date_of_birth into viewer_dob from public.profiles where profiles.id=auth.uid();
  viewer_minor := viewer_dob is null or age(current_date,viewer_dob) < interval '18 years';
  for m in
    select messages.id,messages.sender_id,messages.recipient_id,messages.body,messages.created_at
    from public.messages
    where (messages.sender_id=auth.uid() and messages.recipient_id=p_friend_id)
       or (messages.sender_id=p_friend_id and messages.recipient_id=auth.uid())
    order by messages.created_at
  loop
    if viewer_minor then
      blocked := public.validate_macro_text(m.body,'message',true);
      if blocked is not null then
        id:=m.id; sender_id:=m.sender_id; recipient_id:=m.recipient_id;
        body:='[Message unavailable: this message contains content that is not available to accounts under 18.]';
        created_at:=m.created_at; return next;
      end if;
    end if;
    id:=m.id; sender_id:=m.sender_id; recipient_id:=m.recipient_id; body:=m.body; created_at:=m.created_at; return next;
  end loop;
end;
$$;
grant execute on function public.get_conversation_messages(uuid) to authenticated;


create or replace function public.send_message(p_recipient_id uuid, p_body text)
returns public.messages language plpgsql security definer set search_path=public as $$
declare new_message public.messages; validation_message text; my_status text; recipient_status text;
begin
 if auth.uid() is null then raise exception 'You must be signed in to send messages.'; end if;
 if public.is_limited_minor() then raise exception 'Messaging is not available to limited accounts for users ages 13–15.'; end if;
 select account_status into my_status from public.profiles where id=auth.uid();
 if coalesce(my_status,'active')='banned' then raise exception 'Your account is banned.'; end if;
 if coalesce(my_status,'active')='suspended' and exists(select 1 from public.profiles where id=auth.uid() and moderation_status_until is null) then raise exception 'Your account is suspended.'; end if;
 select account_status into recipient_status from public.profiles where id=p_recipient_id;
 if coalesce(recipient_status,'active')<>'active' then raise exception 'This user cannot receive messages right now.'; end if;
 if p_recipient_id=auth.uid() then raise exception 'You cannot message yourself.'; end if;
 validation_message:=public.validate_macro_text(p_body, 'message', false); if validation_message is not null then raise exception '%',validation_message; end if;
 if not exists(select 1 from public.friend_connections c where c.status='accepted' and ((c.requester_id=auth.uid() and c.addressee_id=p_recipient_id) or (c.requester_id=p_recipient_id and c.addressee_id=auth.uid()))) then raise exception 'You can only message an accepted friend.'; end if;
 insert into public.messages(sender_id,recipient_id,body) values(auth.uid(),p_recipient_id,trim(p_body)) returning * into new_message;
 if exists(select 1 from public.profiles p where p.id=p_recipient_id and p.message_notifications_enabled=true) then insert into public.notifications(recipient_id,sender_id,type,title,body,message_id) values(p_recipient_id,auth.uid(),'message','New message',trim(p_body),new_message.id); end if;
 return new_message;
end;
$$;
grant execute on function public.send_message(uuid,text) to authenticated;



-- ==========================================================
-- LEGACY MIGRATION 9: supabase-scalability-hardening-migration.sql
-- ==========================================================

-- MacroSync scalability hardening migration (v43)
-- Goal: keep the existing relational design, but make hot paths bounded,
-- paginated, indexed, aggregate-friendly, and horizontally scalable.
-- Safe to run after the current schema/migrations.

-- ---------------------------------------------------------------------------
-- 1) Hot-path indexes
-- ---------------------------------------------------------------------------
create index if not exists food_entries_user_date_created_id_idx
  on public.food_entries(user_id, logged_date, created_at, id);

create index if not exists messages_sender_recipient_created_id_idx
  on public.messages(sender_id, recipient_id, created_at desc, id desc);
create index if not exists messages_recipient_sender_created_id_idx
  on public.messages(recipient_id, sender_id, created_at desc, id desc);

create index if not exists friend_connections_requester_status_idx
  on public.friend_connections(requester_id, status, created_at desc);
create index if not exists friend_connections_addressee_status_idx
  on public.friend_connections(addressee_id, status, created_at desc);

create index if not exists meals_user_date_number_idx
  on public.meals(user_id, meal_date, meal_number);
create index if not exists recipe_items_user_recipe_idx
  on public.recipe_items(user_id, recipe_id);
create index if not exists saved_meal_items_user_meal_idx
  on public.saved_meal_items(user_id, saved_meal_id);

create index if not exists moderation_flags_user_status_created_idx
  on public.moderation_flags(user_id, status, created_at desc);

create index if not exists feedback_user_created_idx
  on public.feedback(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2) Trigram search indexes for the existing ILIKE directory/database search.
--    This keeps the current API while making '%query%' searches indexable.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;

create index if not exists profiles_display_name_trgm_idx
  on public.profiles using gin (display_name extensions.gin_trgm_ops);
create index if not exists profiles_business_name_trgm_idx
  on public.profiles using gin (business_name extensions.gin_trgm_ops);
create index if not exists community_foods_public_name_trgm_idx
  on public.community_foods using gin (name extensions.gin_trgm_ops)
  where is_public = true;
create index if not exists trainer_profiles_location_trgm_idx
  on public.trainer_profiles using gin (location extensions.gin_trgm_ops)
  where is_public = true;
create index if not exists trainer_profiles_bio_trgm_idx
  on public.trainer_profiles using gin (bio extensions.gin_trgm_ops)
  where is_public = true;

-- ---------------------------------------------------------------------------
-- 3) Bounded daily nutrition aggregates.
--    Progress/streak screens should not rescan raw food_entries as history grows.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_nutrition_summaries (
  user_id uuid not null references auth.users(id) on delete cascade,
  logged_date date not null,
  entry_count integer not null default 0 check (entry_count >= 0),
  calories numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, logged_date)
);

create index if not exists daily_nutrition_summaries_user_date_idx
  on public.daily_nutrition_summaries(user_id, logged_date desc);

alter table public.daily_nutrition_summaries enable row level security;
drop policy if exists "daily summaries own read" on public.daily_nutrition_summaries;
create policy "daily summaries own read"
  on public.daily_nutrition_summaries
  for select to authenticated
  using (auth.uid() = user_id);

create or replace function public.apply_food_entry_summary_delta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_user uuid;
  old_date date;
  old_cal numeric;
  old_pro numeric;
  old_car numeric;
  old_fat numeric;
  new_user uuid;
  new_date date;
  new_cal numeric;
  new_pro numeric;
  new_car numeric;
  new_fat numeric;
begin
  if tg_op in ('UPDATE','DELETE') then
    old_user := old.user_id;
    old_date := old.logged_date;
    old_cal := coalesce(old.calories,0);
    old_pro := coalesce(old.protein,0);
    old_car := coalesce(old.carbs,0);
    old_fat := coalesce(old.fat,0);

    update public.daily_nutrition_summaries
       set entry_count = greatest(entry_count - 1, 0),
           calories = calories - old_cal,
           protein = protein - old_pro,
           carbs = carbs - old_car,
           fat = fat - old_fat,
           updated_at = now()
     where user_id = old_user and logged_date = old_date;

    delete from public.daily_nutrition_summaries
     where user_id = old_user and logged_date = old_date and entry_count <= 0;
  end if;

  if tg_op in ('INSERT','UPDATE') then
    new_user := new.user_id;
    new_date := new.logged_date;
    new_cal := coalesce(new.calories,0);
    new_pro := coalesce(new.protein,0);
    new_car := coalesce(new.carbs,0);
    new_fat := coalesce(new.fat,0);

    insert into public.daily_nutrition_summaries(
      user_id, logged_date, entry_count, calories, protein, carbs, fat, updated_at
    ) values (
      new_user, new_date, 1, new_cal, new_pro, new_car, new_fat, now()
    )
    on conflict (user_id, logged_date) do update set
      entry_count = public.daily_nutrition_summaries.entry_count + 1,
      calories = public.daily_nutrition_summaries.calories + excluded.calories,
      protein = public.daily_nutrition_summaries.protein + excluded.protein,
      carbs = public.daily_nutrition_summaries.carbs + excluded.carbs,
      fat = public.daily_nutrition_summaries.fat + excluded.fat,
      updated_at = now();
  end if;

  return coalesce(new, old);
end;
$$;

 drop trigger if exists food_entries_daily_summary_trigger on public.food_entries;
create trigger food_entries_daily_summary_trigger
after insert or update or delete on public.food_entries
for each row execute function public.apply_food_entry_summary_delta();

-- Backfill existing data once. ON CONFLICT is intentionally additive-safe for reruns.
insert into public.daily_nutrition_summaries(user_id, logged_date, entry_count, calories, protein, carbs, fat, updated_at)
select user_id, logged_date, count(*)::integer,
       coalesce(sum(calories),0), coalesce(sum(protein),0), coalesce(sum(carbs),0), coalesce(sum(fat),0), now()
from public.food_entries
group by user_id, logged_date
on conflict (user_id, logged_date) do update set
  entry_count = excluded.entry_count,
  calories = excluded.calories,
  protein = excluded.protein,
  carbs = excluded.carbs,
  fat = excluded.fat,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 4) Goal audit/history. This is the durable foundation for future Premium
--    trend detection and one-click/approved target adjustments.
-- ---------------------------------------------------------------------------
create table if not exists public.nutrition_goal_history (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  calorie_goal numeric not null,
  protein_goal numeric not null,
  carbs_goal numeric not null,
  fat_goal numeric not null,
  current_weight numeric,
  goal_weight numeric,
  low_carb boolean not null default false,
  source text not null default 'manual' check (source in ('manual','auto','premium_auto','migration')),
  created_at timestamptz not null default now()
);
create index if not exists nutrition_goal_history_user_created_idx
  on public.nutrition_goal_history(user_id, created_at desc, id desc);

alter table public.nutrition_goal_history enable row level security;
drop policy if exists "goal history own read" on public.nutrition_goal_history;
create policy "goal history own read"
  on public.nutrition_goal_history
  for select to authenticated
  using (auth.uid() = user_id);

create or replace function public.record_nutrition_goal_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or
     old.calorie_goal is distinct from new.calorie_goal or
     old.protein_goal is distinct from new.protein_goal or
     old.carbs_goal is distinct from new.carbs_goal or
     old.fat_goal is distinct from new.fat_goal or
     old.current_weight is distinct from new.current_weight or
     old.goal_weight is distinct from new.goal_weight or
     old.low_carb is distinct from new.low_carb then
    insert into public.nutrition_goal_history(
      user_id, calorie_goal, protein_goal, carbs_goal, fat_goal,
      current_weight, goal_weight, low_carb, source
    ) values (
      new.user_id, new.calorie_goal, new.protein_goal, new.carbs_goal, new.fat_goal,
      new.current_weight, new.goal_weight, new.low_carb, 'manual'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists nutrition_goals_history_trigger on public.nutrition_goals;
create trigger nutrition_goals_history_trigger
after insert or update on public.nutrition_goals
for each row execute function public.record_nutrition_goal_history();

-- Seed history for existing current targets if a user has no history yet.
insert into public.nutrition_goal_history(
  user_id, calorie_goal, protein_goal, carbs_goal, fat_goal,
  current_weight, goal_weight, low_carb, source
)
select ng.user_id, ng.calorie_goal, ng.protein_goal, ng.carbs_goal, ng.fat_goal,
       ng.current_weight, ng.goal_weight, ng.low_carb, 'migration'
from public.nutrition_goals ng
where not exists (
  select 1 from public.nutrition_goal_history h where h.user_id = ng.user_id
);

-- ---------------------------------------------------------------------------
-- 5) Bounded conversation RPC. Newest 50 messages are returned by default.
--    Older messages use a cursor instead of OFFSET.
-- ---------------------------------------------------------------------------
drop function if exists public.get_conversation_messages(uuid);
drop function if exists public.get_conversation_messages(uuid,timestamptz,bigint,integer);
create or replace function public.get_conversation_messages(
  p_friend_id uuid,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 50
)
returns table(id bigint, sender_id uuid, recipient_id uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path=public
as $$
declare
  viewer_dob date;
  viewer_minor boolean;
  m record;
  blocked text;
  safe_limit integer := greatest(1, least(coalesce(p_limit,50),100));
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if public.is_limited_minor() then raise exception 'Messaging is not available to limited accounts for users ages 13–15.'; end if;

  select date_of_birth into viewer_dob from public.profiles where profiles.id=auth.uid();
  viewer_minor := viewer_dob is null or age(current_date,viewer_dob) < interval '18 years';

  for m in
    select q.id,q.sender_id,q.recipient_id,q.body,q.created_at
    from (
      select messages.id,messages.sender_id,messages.recipient_id,messages.body,messages.created_at
      from public.messages
      where ((messages.sender_id=auth.uid() and messages.recipient_id=p_friend_id)
          or (messages.sender_id=p_friend_id and messages.recipient_id=auth.uid()))
        and (
          p_before is null
          or messages.created_at < p_before
          or (messages.created_at = p_before and p_before_id is not null and messages.id < p_before_id)
        )
      order by messages.created_at desc, messages.id desc
      limit safe_limit
    ) q
    order by q.created_at asc, q.id asc
  loop
    if viewer_minor then
      blocked := public.validate_macro_text(m.body,'message',true);
      if blocked is not null then
        id:=m.id; sender_id:=m.sender_id; recipient_id:=m.recipient_id;
        body:='[Message unavailable: this message contains content that is not available to accounts under 18.]';
        created_at:=m.created_at; return next;
      end if;
    end if;
    id:=m.id; sender_id:=m.sender_id; recipient_id:=m.recipient_id; body:=m.body; created_at:=m.created_at; return next;
  end loop;
end;
$$;
grant execute on function public.get_conversation_messages(uuid,timestamptz,bigint,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Operational retention helpers. Schedule these with pg_cron/your platform
--    scheduler in production; they are deliberately explicit rather than
--    silently deleting user data during migration.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_operational_data(
  p_notification_days integer default 90,
  p_resolved_moderation_days integer default 180
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  deleted_notifications bigint := 0;
  deleted_flags bigint := 0;
begin
  if not public.is_admin() then raise exception 'Administrator access required.'; end if;

  delete from public.notifications
   where created_at < now() - make_interval(days => greatest(30, least(p_notification_days,3650)));

  get diagnostics deleted_notifications = row_count;

  delete from public.moderation_flags
   where status='resolved'
     and resolved_at is not null
     and resolved_at < now() - make_interval(days => greatest(90, least(p_resolved_moderation_days,3650)));
  get diagnostics deleted_flags = row_count;

  return jsonb_build_object(
    'notifications_deleted', deleted_notifications,
    'resolved_moderation_flags_deleted', deleted_flags,
    'ran_at', now()
  );
end;
$$;
revoke all on function public.cleanup_operational_data(integer,integer) from public;
grant execute on function public.cleanup_operational_data(integer,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Realtime without exposing message bodies to restricted/under-18 users.
--    Clients receive a tiny event and then call the age-aware conversation RPC.
-- ---------------------------------------------------------------------------
create table if not exists public.message_events (
  id bigint generated by default as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists message_events_recipient_created_idx
  on public.message_events(recipient_id, created_at desc, id desc);
create index if not exists message_events_sender_created_idx
  on public.message_events(sender_id, created_at desc, id desc);

alter table public.message_events enable row level security;
drop policy if exists "message events participants read" on public.message_events;
create policy "message events participants read"
  on public.message_events
  for select to authenticated
  using (
    not public.is_limited_minor()
    and (auth.uid() = sender_id or auth.uid() = recipient_id)
  );

create or replace function public.emit_message_event()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.message_events(message_id,sender_id,recipient_id,created_at)
  values(new.id,new.sender_id,new.recipient_id,new.created_at);
  return new;
end;
$$;

drop trigger if exists messages_realtime_event_trigger on public.messages;
create trigger messages_realtime_event_trigger
after insert on public.messages
for each row execute function public.emit_message_event();

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='message_events') then
      alter publication supabase_realtime add table public.message_events;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='meals') then
      alter publication supabase_realtime add table public.meals;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8) Document the remaining deliberate scaling boundary.
--    food_entries is kept as a normal table for compatibility now. At very high
--    row counts, it can be partitioned by logged_date in a planned migration.
--    The composite indexes above and aggregate table make that future change
--    non-urgent and avoid forcing a risky partition rewrite into this release.
-- ---------------------------------------------------------------------------


-- ==========================================================
-- LEGACY MIGRATION 10: supabase-verified-trainers-v44-migration.sql
-- ==========================================================

-- MacroSync V44 verified trainer migration.
-- Run this after the existing MacroSync schema/migrations.
-- This file intentionally does not assign administrators because the two
-- account identifiers were not included in the application source.

create table if not exists public.trainer_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected','revoked')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewer_note text,
  updated_at timestamptz not null default now(),
  experience text,
  credentials text,
  credential_number text,
  proof_url text,
  professional_background text,
  statement text,
  constraint trainer_verification_application_lengths check (
    char_length(coalesce(experience,'')) <= 2000 and
    char_length(coalesce(credentials,'')) <= 1500 and
    char_length(coalesce(credential_number,'')) <= 120 and
    char_length(coalesce(proof_url,'')) <= 500 and
    char_length(coalesce(professional_background,'')) <= 4000 and
    char_length(coalesce(statement,'')) <= 2000
  )
);
create index if not exists trainer_verifications_status_requested_idx on public.trainer_verifications(status, requested_at desc);
alter table public.trainer_verifications enable row level security;
drop policy if exists "trainer verification own read" on public.trainer_verifications;
drop policy if exists "trainer verification own insert" on public.trainer_verifications;
drop policy if exists "trainer verification own update" on public.trainer_verifications;
drop policy if exists "trainer verification admin read" on public.trainer_verifications;
drop policy if exists "trainer verification admin update" on public.trainer_verifications;
create policy "trainer verification own read" on public.trainer_verifications for select to authenticated using (auth.uid()=user_id);
create policy "trainer verification own insert" on public.trainer_verifications for insert to authenticated with check (auth.uid()=user_id and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='trainer'));
create policy "trainer verification own update" on public.trainer_verifications for update to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id and status in ('pending','rejected'));
create policy "trainer verification admin read" on public.trainer_verifications for select to authenticated using (public.is_admin());
create policy "trainer verification admin update" on public.trainer_verifications for update to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.is_verified_trainer(p_user_id uuid default auth.uid()) returns boolean language sql stable security definer set search_path=public as $$
select exists(select 1 from public.profiles p join public.trainer_verifications v on v.user_id=p.id where p.id=p_user_id and p.role='trainer' and v.status='approved');
$$;
grant execute on function public.is_verified_trainer(uuid) to authenticated;

drop function if exists public.request_trainer_verification();
create function public.request_trainer_verification(
  p_experience text,
  p_credentials text,
  p_credential_number text default null,
  p_proof_url text,
  p_professional_background text,
  p_statement text
) returns public.trainer_verifications
language plpgsql security definer set search_path=public as $$
declare r public.trainer_verifications;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and role='trainer') then
    raise exception 'Only trainer accounts can request verification.';
  end if;
  if exists(select 1 from public.trainer_verifications where user_id=auth.uid() and status='approved') then
    raise exception 'This trainer account is already verified.';
  end if;
  if nullif(trim(p_experience),'') is null then raise exception 'Training experience is required.'; end if;
  if nullif(trim(p_credentials),'') is null then raise exception 'Certifications, licenses, or credentials are required.'; end if;
  if nullif(trim(p_proof_url),'') is null then raise exception 'A verification link is required.'; end if;
  if nullif(trim(p_professional_background),'') is null then raise exception 'Professional background is required.'; end if;
  if nullif(trim(p_statement),'') is null then raise exception 'The applicant statement is required.'; end if;
  if p_proof_url !~* '^https?://[^[:space:]]+$' then raise exception 'The verification link must be a valid http or https URL.'; end if;

  insert into public.trainer_verifications(
    user_id,status,requested_at,reviewed_at,reviewed_by,reviewer_note,updated_at,
    experience,credentials,credential_number,proof_url,professional_background,statement
  ) values(
    auth.uid(),'pending',now(),null,null,null,now(),
    trim(p_experience),trim(p_credentials),nullif(trim(p_credential_number),''),
    trim(p_proof_url),trim(p_professional_background),trim(p_statement)
  )
  on conflict(user_id) do update set
    status='pending',requested_at=now(),reviewed_at=null,reviewed_by=null,reviewer_note=null,updated_at=now(),
    experience=excluded.experience,credentials=excluded.credentials,credential_number=excluded.credential_number,
    proof_url=excluded.proof_url,professional_background=excluded.professional_background,statement=excluded.statement
  returning * into r;
  return r;
end; $$;
revoke all on function public.request_trainer_verification() from public;
grant execute on function public.request_trainer_verification() to authenticated;

drop function if exists public.admin_list_trainer_verifications();
create function public.admin_list_trainer_verifications() returns table(
  user_id uuid,display_name text,email text,business_name text,status text,requested_at timestamptz,
  reviewed_at timestamptz,reviewer_note text,experience text,credentials text,credential_number text,
  proof_url text,professional_background text,statement text
) language plpgsql security definer set search_path=public as $$
begin
 if not public.is_admin() then raise exception 'Administrator access required.'; end if;
 return query
 select p.id,p.display_name,p.email,p.business_name,v.status,v.requested_at,v.reviewed_at,v.reviewer_note,
        v.experience,v.credentials,v.credential_number,v.proof_url,v.professional_background,v.statement
 from public.trainer_verifications v
 join public.profiles p on p.id=v.user_id
 where p.role='trainer'
 order by case when v.status='pending' then 0 else 1 end,v.requested_at desc;
end; $$;
grant execute on function public.admin_list_trainer_verifications() to authenticated;

create or replace function public.admin_set_trainer_verification(p_user_id uuid,p_status text,p_note text default null) returns public.trainer_verifications language plpgsql security definer set search_path=public as $$
declare r public.trainer_verifications;
begin
 if not public.is_admin() then raise exception 'Administrator access required.'; end if;
 if p_status not in ('approved','rejected','revoked') then raise exception 'Invalid verification status.'; end if;
 if not exists(select 1 from public.profiles where id=p_user_id and role='trainer') then raise exception 'That account is not a trainer account.'; end if;
 insert into public.trainer_verifications(user_id,status,requested_at,reviewed_at,reviewed_by,reviewer_note,updated_at) values(p_user_id,p_status,coalesce((select requested_at from public.trainer_verifications where user_id=p_user_id),now()),now(),auth.uid(),nullif(trim(p_note),''),now())
 on conflict(user_id) do update set status=excluded.status,reviewed_at=now(),reviewed_by=auth.uid(),reviewer_note=excluded.reviewer_note,updated_at=now() returning * into r;
 if p_status in ('rejected','revoked') then update public.trainer_profiles set is_public=false,updated_at=now() where user_id=p_user_id; end if;
 return r;
end; $$;
revoke all on function public.admin_set_trainer_verification(uuid,text,text) from public;
grant execute on function public.admin_set_trainer_verification(uuid,text,text) to authenticated;


-- Verified directory RPCs. PostgreSQL requires DROP before changing RETURNS TABLE / OUT parameters.
drop function if exists public.search_trainers(text,smallint,smallint);
create function public.search_trainers(p_query text default '', p_training_type smallint default null, p_price_range smallint default null)
returns table(user_id uuid, display_name text, business_name text, bio text, location text, phone text, instagram text, facebook text, tiktok text, youtube text, website text, training_types smallint[], price_range smallint, years_experience smallint, verified boolean)
language sql stable security definer set search_path=public as $$
  select tp.user_id, p.display_name, p.business_name, tp.bio, tp.location, tp.phone, tp.instagram, tp.facebook, tp.tiktok, tp.youtube, tp.website, tp.training_types, tp.price_range, tp.years_experience, true
  from public.trainer_profiles tp
  join public.profiles p on p.id=tp.user_id
  join public.trainer_verifications v on v.user_id=p.id and v.status='approved'
  where tp.is_public=true and p.role='trainer' and not public.is_limited_minor()
    and (trim(coalesce(p_query,''))='' or p.display_name ilike '%'||trim(p_query)||'%' or coalesce(p.business_name,'') ilike '%'||trim(p_query)||'%' or coalesce(tp.location,'') ilike '%'||trim(p_query)||'%' or coalesce(tp.bio,'') ilike '%'||trim(p_query)||'%')
    and (p_training_type is null or p_training_type=any(tp.training_types))
    and (p_price_range is null or tp.price_range=p_price_range)
  order by p.display_name limit 100;
$$;
grant execute on function public.search_trainers(text,smallint,smallint) to authenticated;

drop function if exists public.get_trainer_profile(uuid);
create function public.get_trainer_profile(p_trainer_id uuid)
returns table(user_id uuid, display_name text, business_name text, bio text, location text, phone text, instagram text, facebook text, tiktok text, youtube text, website text, training_types smallint[], price_range smallint, years_experience smallint, verified boolean)
language sql stable security definer set search_path=public as $$
  select tp.user_id, p.display_name, p.business_name, tp.bio, tp.location, tp.phone, tp.instagram, tp.facebook, tp.tiktok, tp.youtube, tp.website, tp.training_types, tp.price_range, tp.years_experience, true
  from public.trainer_profiles tp
  join public.profiles p on p.id=tp.user_id
  join public.trainer_verifications v on v.user_id=p.id and v.status='approved'
  where tp.user_id=p_trainer_id and p.role='trainer' and tp.is_public=true;
$$;
grant execute on function public.get_trainer_profile(uuid) to authenticated;


-- ==========================================================
-- LEGACY MIGRATION 11: supabase-nutrition-sharing-v46-migration.sql
-- ==========================================================

-- MacroSync V46: trainer/client nutrition sharing and controlled friend requests.
-- Run after the existing MacroSync/Supabase schema and prior migrations.

-- ================================================================
-- Friend requests
-- ================================================================

alter table public.friend_connections
  drop constraint if exists friend_connections_status_check;

alter table public.friend_connections
  add constraint friend_connections_status_check
  check (status in ('pending','accepted','declined','expired'));

alter table public.friend_connections
  add column if not exists expires_at timestamptz;

create index if not exists friend_connections_pending_expiry_idx
  on public.friend_connections(addressee_id, status, expires_at);

-- Give existing pending requests the same seven-day expiry window.
update public.friend_connections
   set expires_at = created_at + interval '7 days'
 where status = 'pending' and expires_at is null;

-- Keep friend-request creation behind a security-definer function so the
-- trainer -> normal-user restriction cannot be bypassed through direct inserts.
revoke insert on public.friend_connections from authenticated;

drop function if exists public.send_friend_request(uuid);
create function public.send_friend_request(p_addressee_id uuid)
returns public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text;
  addressee_role text;
  existing public.friend_connections;
  new_connection public.friend_connections;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to send a friend request.';
  end if;

  if p_addressee_id is null or p_addressee_id = auth.uid() then
    raise exception 'Invalid friend request recipient.';
  end if;

  if public.is_limited_minor() or public.is_limited_minor(p_addressee_id) then
    raise exception 'Friend requests are not available for limited accounts.';
  end if;

  select role into requester_role from public.profiles where id = auth.uid();
  select role into addressee_role from public.profiles where id = p_addressee_id;

  if requester_role is null or addressee_role is null then
    raise exception 'Both users must have valid MacroSync profiles.';
  end if;

  -- Trainers may network with trainers, but cannot initiate unsolicited
  -- friend requests to normal Personal users.
  if requester_role = 'trainer' and addressee_role = 'user' then
    raise exception 'Trainers cannot send friend requests to normal users. The user must send the request first.';
  end if;

  select * into existing
  from public.friend_connections
  where (requester_id = auth.uid() and addressee_id = p_addressee_id)
     or (requester_id = p_addressee_id and addressee_id = auth.uid())
  order by id desc
  limit 1;

  if existing.id is not null then
    if existing.status = 'accepted' then
      raise exception 'You are already friends with this person.';
    end if;

    if existing.status = 'pending' then
      if existing.addressee_id = auth.uid() then
        raise exception 'This person has already sent you a friend request.';
      else
        raise exception 'A friend request is already pending.';
      end if;
    end if;
  end if;

  -- If an old declined/expired row exists, create a fresh request instead of
  -- changing historical state. The pair-unique index from older schemas may
  -- prevent a second physical row, so reuse the historical row in that case.
  if existing.id is not null then
    update public.friend_connections
       set requester_id = auth.uid(),
           addressee_id = p_addressee_id,
           status = 'pending',
           expires_at = now() + interval '7 days',
           updated_at = now(),
           share_meals = false,
           requester_share_meals = false,
           addressee_share_meals = false
     where id = existing.id
     returning * into new_connection;
  else
    insert into public.friend_connections(
      requester_id, addressee_id, status, expires_at,
      share_meals, requester_share_meals, addressee_share_meals
    ) values (
      auth.uid(), p_addressee_id, 'pending', now() + interval '7 days',
      false, false, false
    ) returning * into new_connection;
  end if;

  insert into public.notifications(recipient_id, sender_id, type, title, body)
  values (
    p_addressee_id,
    auth.uid(),
    'friend_request',
    'New friend request',
    'You have a new MacroSync friend request.'
  );

  return new_connection;
end;
$$;

grant execute on function public.send_friend_request(uuid) to authenticated;

-- Accept and reject are also RPC-only so the requester cannot manufacture an
-- accepted connection by updating the row directly.
revoke update on public.friend_connections from authenticated;
grant update (requester_share_meals, addressee_share_meals, share_meals) on public.friend_connections to authenticated;

drop function if exists public.accept_friend_request(bigint);
create function public.accept_friend_request(p_connection_id bigint)
returns public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
declare r public.friend_connections;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;

  update public.friend_connections
     set status = 'accepted',
         expires_at = null,
         updated_at = now()
   where id = p_connection_id
     and addressee_id = auth.uid()
     and status = 'pending'
     and (expires_at is null or expires_at > now())
   returning * into r;

  if r.id is null then
    raise exception 'This friend request is no longer pending or has expired.';
  end if;

  insert into public.notifications(recipient_id, sender_id, type, title, body)
  values (r.requester_id, auth.uid(), 'friend_request_accepted', 'Friend request accepted', 'Your MacroSync friend request was accepted.');

  return r;
end;
$$;
grant execute on function public.accept_friend_request(bigint) to authenticated;

drop function if exists public.reject_friend_request(bigint);
create function public.reject_friend_request(p_connection_id bigint)
returns public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
declare r public.friend_connections;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;

  update public.friend_connections
     set status = 'declined',
         expires_at = null,
         updated_at = now()
   where id = p_connection_id
     and addressee_id = auth.uid()
     and status = 'pending'
   returning * into r;

  if r.id is null then raise exception 'This friend request is no longer pending.'; end if;

  return r;
end;
$$;
grant execute on function public.reject_friend_request(bigint) to authenticated;

-- Expire pending requests lazily whenever the social system is read. This is
-- intentionally idempotent, so a scheduled job is optional rather than required.
drop function if exists public.expire_friend_requests();
create function public.expire_friend_requests()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  update public.friend_connections
     set status = 'expired', updated_at = now()
   where status = 'pending'
     and expires_at is not null
     and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;
grant execute on function public.expire_friend_requests() to authenticated;

-- ================================================================
-- Shared nutrition items
-- ================================================================

create table if not exists public.nutrition_shares (
  id bigint generated by default as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  message_id bigint references public.messages(id) on delete cascade,
  item_type text not null check (item_type in ('food','meal','recipe','day_plan')),
  title text not null check (char_length(trim(title)) between 1 and 200),
  note text,
  source_id bigint,
  snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','accepted','declined','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  check (sender_id <> recipient_id)
);

create index if not exists nutrition_shares_recipient_status_idx
  on public.nutrition_shares(recipient_id, status, created_at desc);
create index if not exists nutrition_shares_message_idx
  on public.nutrition_shares(message_id);

alter table public.nutrition_shares enable row level security;
drop policy if exists "nutrition shares participants read" on public.nutrition_shares;
create policy "nutrition shares participants read"
on public.nutrition_shares for select to authenticated
using (auth.uid() = sender_id or auth.uid() = recipient_id);

revoke insert, update, delete on public.nutrition_shares from authenticated;

-- The sender must already be an accepted friend. For trainer -> normal-user
-- sharing, this also guarantees the trainer has not bypassed the connection rule.
drop function if exists public.create_nutrition_share(uuid,text,text,text,jsonb,bigint,boolean);
create function public.create_nutrition_share(
  p_recipient_id uuid,
  p_item_type text,
  p_title text,
  p_note text default null,
  p_snapshot jsonb default '{}'::jsonb,
  p_source_id bigint default null,
  p_attach_to_message boolean default true
)
returns public.nutrition_shares
language plpgsql
security definer
set search_path = public
as $$
declare
  share_row public.nutrition_shares;
  message_row public.messages;
  my_status text;
  recipient_status text;
  body_text text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if p_recipient_id is null or p_recipient_id = auth.uid() then raise exception 'Invalid recipient.'; end if;
  if p_item_type not in ('food','meal','recipe','day_plan') then raise exception 'Invalid nutrition share type.'; end if;
  if nullif(trim(p_title),'') is null then raise exception 'A title is required.'; end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then raise exception 'Nutrition share data is invalid.'; end if;

  select account_status into my_status from public.profiles where id = auth.uid();
  select account_status into recipient_status from public.profiles where id = p_recipient_id;
  if coalesce(my_status,'active') <> 'active' then raise exception 'Your account cannot send nutrition shares right now.'; end if;
  if coalesce(recipient_status,'active') <> 'active' then raise exception 'This user cannot receive nutrition shares right now.'; end if;

  if not exists(
    select 1 from public.friend_connections c
    where c.status='accepted'
      and ((c.requester_id=auth.uid() and c.addressee_id=p_recipient_id)
        or (c.requester_id=p_recipient_id and c.addressee_id=auth.uid()))
  ) then
    raise exception 'You can only share nutrition with an accepted friend.';
  end if;

  -- A nutrition share can optionally appear as a message. The message body is
  -- deliberately short; the structured nutrition payload stays in this table.
  if p_attach_to_message then
    body_text := coalesce(nullif(trim(p_note),''), 'Shared nutrition: ' || trim(p_title));
    if public.validate_macro_text(body_text, 'message', false) is not null then
      raise exception 'The share note contains prohibited content.';
    end if;
    insert into public.messages(sender_id, recipient_id, body)
    values(auth.uid(), p_recipient_id, body_text)
    returning * into message_row;

    if exists(select 1 from public.profiles p where p.id=p_recipient_id and p.message_notifications_enabled=true) then
      insert into public.notifications(recipient_id,sender_id,type,title,body,message_id)
      values(p_recipient_id,auth.uid(),'nutrition_share','Nutrition shared with you',trim(p_title),message_row.id);
    end if;
  end if;

  insert into public.nutrition_shares(
    sender_id, recipient_id, message_id, item_type, title, note,
    source_id, snapshot, status, expires_at
  ) values (
    auth.uid(), p_recipient_id, message_row.id, p_item_type, trim(p_title),
    nullif(trim(p_note),''), p_source_id, p_snapshot, 'pending', null
  ) returning * into share_row;

  if not p_attach_to_message then
    insert into public.notifications(recipient_id,sender_id,type,title,body)
    values(p_recipient_id,auth.uid(),'nutrition_share','Nutrition shared with you',trim(p_title));
  end if;

  return share_row;
end;
$$;
grant execute on function public.create_nutrition_share(uuid,text,text,text,jsonb,bigint,boolean) to authenticated;

-- Recipient controls the decision. Accepting does NOT change the recipient's
-- food log; it only makes the shared item eligible for the recipient's chosen action.
drop function if exists public.accept_nutrition_share(bigint);
create function public.accept_nutrition_share(p_share_id bigint)
returns public.nutrition_shares
language plpgsql
security definer
set search_path = public
as $$
declare r public.nutrition_shares;
begin
  update public.nutrition_shares
     set status='accepted', accepted_at=now()
   where id=p_share_id
     and recipient_id=auth.uid()
     and status='pending'
     and (expires_at is null or expires_at > now())
   returning * into r;
  if r.id is null then raise exception 'This shared item is no longer pending or has expired.'; end if;
  return r;
end;
$$;
grant execute on function public.accept_nutrition_share(bigint) to authenticated;

drop function if exists public.decline_nutrition_share(bigint);
create function public.decline_nutrition_share(p_share_id bigint)
returns public.nutrition_shares
language plpgsql
security definer
set search_path = public
as $$
declare r public.nutrition_shares;
begin
  update public.nutrition_shares
     set status='declined', declined_at=now()
   where id=p_share_id
     and recipient_id=auth.uid()
     and status='pending'
   returning * into r;
  if r.id is null then raise exception 'This shared item is no longer pending.'; end if;
  return r;
end;
$$;
grant execute on function public.decline_nutrition_share(bigint) to authenticated;

-- Lazy expiration for nutrition shares as well.
drop function if exists public.expire_nutrition_shares();
create function public.expire_nutrition_shares()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  update public.nutrition_shares
     set status='expired'
   where status='pending'
     and expires_at is not null
     and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;
grant execute on function public.expire_nutrition_shares() to authenticated;

-- ================================================================
-- RLS compatibility for existing installations
-- ================================================================

-- The old insert policy must not permit direct client-side friend requests.
drop policy if exists "friends requester insert" on public.friend_connections;

-- Existing status updates are no longer allowed directly. Meal-sharing RPCs
-- receive their explicit column privilege above.
drop policy if exists "friends participants update" on public.friend_connections;

-- Keep reads for participants; pending expiration is applied by the RPC/read path.
drop policy if exists "friends participants read" on public.friend_connections;
create policy "friends participants read" on public.friend_connections
for select to authenticated
using ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor());

-- Explicitly expire old requests for the current user before returning data.
drop function if exists public.get_my_friend_connections();
create function public.get_my_friend_connections()
returns setof public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.expire_friend_requests();
  return query
    select * from public.friend_connections
    where (requester_id=auth.uid() or addressee_id=auth.uid())
      and not public.is_limited_minor()
    order by created_at desc;
end;
$$;
grant execute on function public.get_my_friend_connections() to authenticated;

-- Automatically keep the visible status correct when nutrition shares are read.
drop function if exists public.get_my_nutrition_shares();
create function public.get_my_nutrition_shares()
returns setof public.nutrition_shares
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.expire_nutrition_shares();
  return query
    select * from public.nutrition_shares
    where sender_id=auth.uid() or recipient_id=auth.uid()
    order by created_at desc;
end;
$$;
grant execute on function public.get_my_nutrition_shares() to authenticated;


-- Replace the older trainer-directory request implementation. A directory request
-- is still client -> verified trainer only, but it now uses the same V46 friend
-- request security, expiry, and notification behavior.
drop function if exists public.request_trainer_connection(uuid);
create function public.request_trainer_connection(p_trainer_id uuid)
returns public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.trainer_profiles tp
    join public.profiles p on p.id=tp.user_id
    where tp.user_id=p_trainer_id and tp.is_public=true and p.role='trainer'
  ) then
    raise exception 'That trainer is not currently listed.';
  end if;
  return public.send_friend_request(p_trainer_id);
end;
$$;
revoke all on function public.request_trainer_connection(uuid) from public;
grant execute on function public.request_trainer_connection(uuid) to authenticated;


-- ==========================================================
-- LEGACY MIGRATION 12: supabase-moderation-abbreviation-migration.sql
-- ==========================================================

-- MacroSync moderation abbreviation / obfuscation hardening migration
-- Run this in Supabase SQL Editor after the current MacroSync schema.
-- This keeps one authoritative validate_macro_text(text,text,boolean) function.

create or replace function public.moderation_normalize(p_text text)
returns text
language sql immutable
as $$
  select regexp_replace(
    translate(
      lower(coalesce(p_text,'')),
      '0134578@$!+',
      'oieastbasit'
    ),
    '[^a-z0-9]+', '', 'g'
  );
$$;

-- Authoritative non-AI moderation function. It uses normalization, token checks,
-- high-risk term groups, contextual phrase rules, and PII patterns. It deliberately
-- errs on the side of blocking questionable content rather than silently rewriting it.
create or replace function public.validate_macro_text(p_text text, p_kind text, p_is_minor boolean default false)
returns text
language plpgsql
immutable
as $$
declare
  raw text := lower(trim(coalesce(p_text,'')));
  normalized text := public.moderation_normalize(p_text);
  profanity text[] := array['fuck','fucker','fucking','motherfucker','shit','shitty','bullshit','bitch','bitches','asshole','dumbass','bastard','cunt','dick','dickhead','pussy','cock','slut','whore','damn','crap','piss','jackass','asshat','prick','twat','wanker','fck','fuk','fking','fkng','sht','btch','bch','a55','dck','dckhead','p55y','wh0re','pr1ck'];
  hate text[] := array['nigger','niggers','nigga','niggas','chink','chinks','spic','spics','kike','kikes','gook','gooks','wetback','wetbacks','beaner','beaners','raghead','ragheads','coon','coons','fag','fags','faggot','faggots','dyke','dykes','tranny','trannies','ch1nk','sp1c','k1ke','g00k','w3tback','b3aner','c00n','r4ghead','f4g','f4ggot','dyk3','tr4nny'];
  term text;
  token text;
  skeleton text;
  normalized_spaced text := regexp_replace(
    translate(lower(coalesce(p_text,'')), '0134578@$!+', 'oieastbasit'),
    '[^a-z0-9]+', ' ', 'g'
  );
  hate_abbreviation text[] := array['nig','nigg','n1g','n1gg','n1gga'];
  sexual_abbreviation text[] := array['bbc'];
begin
  if char_length(raw)=0 then return 'Text cannot be empty.'; end if;

  if p_kind='display_name' then
    if char_length(raw)>80 then return 'Display names must be 80 characters or fewer.'; end if;
  elsif p_kind in ('message','feedback') then
    if char_length(raw)>4000 then return 'Text must be 4000 characters or fewer.'; end if;
  end if;

  foreach term in array hate loop
    if normalized like '%'||public.moderation_normalize(term)||'%' then
      return 'This text contains hateful or discriminatory language and cannot be submitted.';
    end if;
  end loop;

  -- Also detect common vowel-removal abbreviations (for example, shortening a
  -- prohibited word by removing its vowels). This is intentionally limited to
  -- compact tokens to reduce false positives in ordinary words.
  foreach token in array regexp_split_to_array(trim(normalized_spaced), ' +') loop
    if char_length(token) >= 3 then
      foreach term in array hate loop
        skeleton := regexp_replace(public.moderation_normalize(term), '[aeiou]', '', 'g');
        if char_length(skeleton) >= 3 and token = skeleton then
          return 'This text contains hateful or discriminatory language and cannot be submitted.';
        end if;
      end loop;
      foreach term in array hate_abbreviation loop
        if token = public.moderation_normalize(term) then
          return 'This text contains hateful or discriminatory language and cannot be submitted.';
        end if;
      end loop;
    end if;
  end loop;

  -- Short sexual abbreviations are checked separately because they are often
  -- embedded in otherwise harmless-looking display names. This applies to display
  -- names as well as messages/feedback, and normalization catches common leetspeak.
  if p_kind='display_name' then
    foreach term in array sexual_abbreviation loop
      if normalized like '%'||public.moderation_normalize(term)||'%' then
        return 'That display name contains language or content that is not allowed.';
      end if;
    end loop;
  end if;

  -- Sexual terminology and explicit/suggestive solicitation are blocked for all ages.
  if normalized ~ '(pornography|porn|onlyfans|nudes|nude|naked|sexting|sex|sexual|sexy|sexualservices|sexuallyexplicit|childsexual|minorsexual|sexualcontent|rape|rapist|pedo|pedophile|groomer)' then
    return 'This text contains sexual or otherwise inappropriate content and cannot be submitted.';
  end if;

  -- Threat/self-harm encouragement and targeted violence terminology.
  if normalized ~ '(killyourself|kys|gobackto|die[[:alpha:]]*|ethniccleansing|genocide)' then
    return 'This text contains threatening or abusive content and cannot be submitted.';
  end if;

  -- Profanity is blocked in display names and feedback. Messages are now deliberately
  -- strict too; this avoids the inconsistent "some swears are okay" boundary until an AI
  -- contextual moderation layer is introduced.
  foreach term in array profanity loop
    if normalized like '%'||public.moderation_normalize(term)||'%' then
      if p_kind='display_name' then return 'That display name contains profanity or inappropriate language and is not allowed.';
      elsif p_kind='message' then return 'This message contains profanity that is not allowed on MacroSync.';
      else return 'This feedback contains profanity that is not allowed.';
      end if;
    end if;
  end loop;

  -- PII / doxxing patterns.
  if raw ~ '(^|[^0-9])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9]|$)' then return 'This text appears to contain an IP address. Remove it before submitting.'; end if;
  if raw ~ '([0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}' then return 'This text appears to contain an IP address. Remove it before submitting.'; end if;
  if raw ~ '(^|[^0-9])[0-9]{1,5}[[:space:]]+[[:alnum:].''-]+[[:space:]]+(street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|way|parkway|pkwy|place|pl)([^[:alpha:]]|$)' then return 'This text appears to contain a home address. Remove personal location information before submitting.'; end if;
  if raw ~ '(^|[^0-9])\+?[0-9][0-9(). -]{7,}[0-9]([^0-9]|$)' then return 'This text appears to contain a phone number. Remove personal contact information before submitting.'; end if;
  if raw ~ '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then return 'This text appears to contain an email address. Remove personal contact information before submitting.'; end if;

  return null;
end;
$$;

-- Display-name hardening for short/embedded sexual abbreviations.
-- This intentionally checks the normalized display name so common character
-- substitutions such as 8 -> b cannot be used to bypass the rule.


-- ==========================================================
-- LEGACY MIGRATION 13: supabase-trainer-verification-social-v49-migration.sql
-- ==========================================================

-- ==========================================================
-- V49 TRAINER VERIFICATION SOCIAL RESEARCH FIELDS
-- Makes the verification link optional and lets applicants
-- optionally provide social-media identities for admin review.
-- ==========================================================

alter table public.trainer_verifications
  add column if not exists instagram text,
  add column if not exists facebook text,
  add column if not exists tiktok text,
  add column if not exists youtube text,
  add column if not exists other_social text;

-- Replace the existing six-argument RPC with the expanded version.
drop function if exists public.request_trainer_verification(text,text,text,text,text,text);

create function public.request_trainer_verification(
  p_experience text,
  p_credentials text,
  p_credential_number text default null,
  p_proof_url text default null,
  p_instagram text default null,
  p_facebook text default null,
  p_tiktok text default null,
  p_youtube text default null,
  p_other_social text default null,
  p_professional_background text default null,
  p_statement text default null
) returns public.trainer_verifications
language plpgsql security definer set search_path=public as $$
declare r public.trainer_verifications;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if not exists(select 1 from public.profiles where id=auth.uid() and role='trainer') then
    raise exception 'Only trainer accounts can request verification.';
  end if;
  if exists(select 1 from public.trainer_verifications where user_id=auth.uid() and status='approved') then
    raise exception 'This trainer account is already verified.';
  end if;
  if nullif(trim(p_experience),'') is null then
    raise exception 'Training experience is required.';
  end if;
  if nullif(trim(p_credentials),'') is null then
    raise exception 'Certifications, licenses, or credentials are required.';
  end if;
  if nullif(trim(p_professional_background),'') is null then
    raise exception 'Professional background is required.';
  end if;
  if nullif(trim(p_statement),'') is null then
    raise exception 'The applicant statement is required.';
  end if;
  if nullif(trim(p_proof_url),'') is not null and p_proof_url !~* '^https?://[^[:space:]]+$' then
    raise exception 'The verification link must be a valid http or https URL.';
  end if;

  insert into public.trainer_verifications(
    user_id,status,requested_at,reviewed_at,reviewed_by,reviewer_note,updated_at,
    experience,credentials,credential_number,proof_url,instagram,facebook,tiktok,youtube,other_social,
    professional_background,statement
  )
  values(
    auth.uid(),'pending',now(),null,null,null,now(),
    trim(p_experience),trim(p_credentials),nullif(trim(p_credential_number),''),nullif(trim(p_proof_url),''),
    nullif(trim(p_instagram),''),nullif(trim(p_facebook),''),nullif(trim(p_tiktok),''),
    nullif(trim(p_youtube),''),nullif(trim(p_other_social),''),
    trim(p_professional_background),trim(p_statement)
  )
  on conflict(user_id) do update set
    status='pending',requested_at=now(),reviewed_at=null,reviewed_by=null,reviewer_note=null,updated_at=now(),
    experience=excluded.experience,credentials=excluded.credentials,credential_number=excluded.credential_number,
    proof_url=excluded.proof_url,instagram=excluded.instagram,facebook=excluded.facebook,tiktok=excluded.tiktok,
    youtube=excluded.youtube,other_social=excluded.other_social,
    professional_background=excluded.professional_background,statement=excluded.statement
  returning * into r;
  return r;
end; $$;

revoke all on function public.request_trainer_verification(text,text,text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.request_trainer_verification(text,text,text,text,text,text,text,text,text,text,text) to authenticated;

-- Include the optional social research fields in the admin verification queue.
drop function if exists public.admin_list_trainer_verifications();
create function public.admin_list_trainer_verifications() returns table(
  user_id uuid,display_name text,email text,business_name text,status text,requested_at timestamptz,
  reviewed_at timestamptz,reviewer_note text,experience text,credentials text,credential_number text,
  proof_url text,instagram text,facebook text,tiktok text,youtube text,other_social text,
  professional_background text,statement text
) language plpgsql security definer set search_path=public as $$
begin
 if not public.is_admin() then raise exception 'Administrator access required.'; end if;
 return query
 select p.id,p.display_name,p.email,p.business_name,v.status,v.requested_at,v.reviewed_at,v.reviewer_note,
        v.experience,v.credentials,v.credential_number,v.proof_url,v.instagram,v.facebook,v.tiktok,v.youtube,v.other_social,
        v.professional_background,v.statement
 from public.trainer_verifications v join public.profiles p on p.id=v.user_id
 where p.role='trainer'
 order by case when v.status='pending' then 0 else 1 end,v.requested_at desc;
end; $$;
grant execute on function public.admin_list_trainer_verifications() to authenticated;


-- ==========================================================
-- LEGACY MIGRATION 14: supabase-public-launch-v56-migration.sql
-- ==========================================================

-- ==========================================================
-- V56 PUBLIC LAUNCH HARDENING
-- Verified-trainer-only Community Foods, telemetry, feedback context,
-- and admin reliability visibility.
-- ==========================================================

-- Community Foods: only verified trainers may publish new rows.
drop policy if exists "community foods insert own" on public.community_foods;
create policy "community foods insert verified trainer" on public.community_foods
for insert to authenticated
with check (auth.uid() = user_id and public.is_verified_trainer(auth.uid()));

-- Defense in depth: the RPC that creates personal/community foods enforces the same rule.
-- This prevents direct RPC calls from bypassing the UI.
drop function if exists public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text,jsonb,text);
create or replace function public.create_food_records(
  p_name text, p_calories_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_serving_amount numeric, p_serving_unit text, p_serving_grams numeric, p_save_personal boolean default true, p_publish_community boolean default false,
  p_personal_calories numeric default null, p_personal_protein numeric default null, p_personal_carbs numeric default null, p_personal_fat numeric default null,
  p_personal_source text default 'manual', p_serving_options jsonb default '[]'::jsonb, p_conversion_mode text default 'estimate'
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  community_id bigint; personal_id bigint; clean_name text := nullif(trim(coalesce(p_name,'')), ''); unit text := nullif(trim(coalesce(p_serving_unit,'')), ''); opts jsonb := coalesce(p_serving_options,'[]'::jsonb);
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if clean_name is null then raise exception 'Food name cannot be empty.'; end if;
  if char_length(clean_name)>120 then raise exception 'Food names must be 120 characters or fewer.'; end if;
  if not p_save_personal and not p_publish_community then raise exception 'Choose at least one database.'; end if;
  if coalesce(p_serving_grams,0)<=0 or coalesce(p_serving_amount,0)<=0 then raise exception 'Default serving weight and amount must be positive.'; end if;
  if p_conversion_mode not in ('none','estimate') then raise exception 'Invalid conversion mode.'; end if;
  if jsonb_typeof(opts)<>'array' then raise exception 'Serving options must be an array.'; end if;
  if p_calories_per_100g<0 or p_protein_per_100g<0 or p_carbs_per_100g<0 or p_fat_per_100g<0 then raise exception 'Nutrition values cannot be negative.'; end if;
  if p_protein_per_100g+p_carbs_per_100g+p_fat_per_100g>100.5 then raise exception 'The macros exceed 100 g per 100 g and cannot be saved.'; end if;
  unit:=coalesce(unit,'serving');
  if p_publish_community then
    if not public.is_verified_trainer(auth.uid()) then raise exception 'Only verified trainers can publish Community Foods.'; end if;
    insert into public.community_foods(user_id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,serving_options,conversion_mode,is_public)
    values(auth.uid(),clean_name,p_calories_per_100g,p_protein_per_100g,p_carbs_per_100g,p_fat_per_100g,
      jsonb_build_array(jsonb_build_object('amount',p_serving_amount,'unit',unit,'grams',p_serving_grams,'calories',coalesce(p_personal_calories,p_calories_per_100g*p_serving_grams/100),'protein',coalesce(p_personal_protein,p_protein_per_100g*p_serving_grams/100),'carbs',coalesce(p_personal_carbs,p_carbs_per_100g*p_serving_grams/100),'fat',coalesce(p_personal_fat,p_fat_per_100g*p_serving_grams/100))) || opts, p_conversion_mode, true) returning id into community_id;
  end if;
  if p_save_personal then
    insert into public.user_foods(user_id,name,serving_amount,serving_unit,serving_grams,serving_options,conversion_mode,calories,protein,carbs,fat,source,community_food_id)
    values(auth.uid(),clean_name,p_serving_amount,unit,p_serving_grams,opts,p_conversion_mode,coalesce(p_personal_calories,p_calories_per_100g*p_serving_grams/100),coalesce(p_personal_protein,p_protein_per_100g*p_serving_grams/100),coalesce(p_personal_carbs,p_carbs_per_100g*p_serving_grams/100),coalesce(p_personal_fat,p_fat_per_100g*p_serving_grams/100),coalesce(nullif(p_personal_source,''),'manual'),community_id) returning id into personal_id;
  end if;
  if community_id is not null and personal_id is not null then update public.community_foods set personal_food_id=personal_id where id=community_id; end if;
  return jsonb_build_object('community_food_id',community_id,'personal_food_id',personal_id);
end; $$;
revoke all on function public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text,jsonb,text) from public;
grant execute on function public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text,jsonb,text) to authenticated;

-- Feedback context for support/debugging.
alter table public.feedback add column if not exists app_version text;
alter table public.feedback add column if not exists page_path text;
alter table public.feedback add column if not exists user_agent text;

-- Privacy-conscious product analytics. Only authenticated users are tracked.
create table if not exists public.app_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_name text not null check (char_length(event_name) between 1 and 80),
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_events_created_idx on public.app_events(created_at desc);
create index if not exists app_events_name_created_idx on public.app_events(event_name, created_at desc);
alter table public.app_events enable row level security;
drop policy if exists "app events admin read" on public.app_events;
create policy "app events admin read" on public.app_events for select to authenticated using (public.is_admin());

create or replace function public.log_app_event(p_event_name text, p_properties jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if nullif(trim(p_event_name),'') is null then return; end if;
  if char_length(p_event_name)>80 then raise exception 'Event name is too long.'; end if;
  if (select count(*) from public.app_events where user_id=auth.uid() and created_at > now() - interval '1 hour') >= 300 then raise exception 'Event logging limit reached. Please try again later.'; end if;
  insert into public.app_events(user_id,event_name,properties) values(auth.uid(),trim(p_event_name),coalesce(p_properties,'{}'::jsonb));
end; $$;
revoke all on function public.log_app_event(text,jsonb) from public;
grant execute on function public.log_app_event(text,jsonb) to authenticated;

-- Client error reports visible only to administrators.
create table if not exists public.app_error_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  page_path text,
  message text not null,
  stack text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_error_events_created_idx on public.app_error_events(created_at desc);
create index if not exists app_error_events_page_idx on public.app_error_events(page_path, created_at desc);
alter table public.app_error_events enable row level security;
drop policy if exists "app errors admin read" on public.app_error_events;
create policy "app errors admin read" on public.app_error_events for select to authenticated using (public.is_admin());

create or replace function public.log_client_error(p_page text, p_message text, p_stack text default null, p_context jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then return; end if;
  if (select count(*) from public.app_error_events where user_id=auth.uid() and created_at > now() - interval '1 hour') >= 30 then return; end if;
  insert into public.app_error_events(user_id,page_path,message,stack,context)
  values(auth.uid(),left(p_page,200),left(coalesce(p_message,'Unknown client error'),1000),left(coalesce(p_stack,''),4000),coalesce(p_context,'{}'::jsonb));
end; $$;
revoke all on function public.log_client_error(text,text,text,jsonb) from public;
grant execute on function public.log_client_error(text,text,text,jsonb) to authenticated;

-- Operational cleanup: keep telemetry/error records for 90 days.
create or replace function public.cleanup_public_launch_telemetry(p_days integer default 90)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Administrator access required.'; end if;
  delete from public.app_events where created_at < now() - make_interval(days => greatest(1,least(p_days,365)));
  delete from public.app_error_events where created_at < now() - make_interval(days => greatest(1,least(p_days,365)));
end; $$;
revoke all on function public.cleanup_public_launch_telemetry(integer) from public;
grant execute on function public.cleanup_public_launch_telemetry(integer) to authenticated;
