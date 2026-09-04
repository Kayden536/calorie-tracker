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
  updated_at timestamptz not null default now(),
  unique(user_id, meal_number)
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

create unique index if not exists meals_user_name_unique
  on public.meals(user_id, lower(trim(name)));
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
on conflict (user_id, meal_number) do nothing;

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
on conflict (user_id, meal_number) do nothing;

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
  on conflict (user_id, meal_number) do nothing;

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
on conflict (user_id, meal_number) do nothing;

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
