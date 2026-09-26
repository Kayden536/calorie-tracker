-- MacroSync v0.60.6.1.1 - Remove duplicate daily meal definitions
-- Purpose: clean up duplicate rows in public.meals that can cause shared meal
-- viewers to render Meal 1/2/3 multiple times.
--
-- Safe behavior:
--   * Keeps the oldest row for each user/date/meal_number.
--   * Deletes only duplicate meal-definition rows.
--   * food_entries are not deleted; they reference meal names, not these rows.
--   * Re-creates the intended uniqueness constraints/indexes afterward.
--
-- Run this once in Supabase SQL Editor.

begin;

-- Keep the oldest meal row (created_at, then id) for each user/date/meal number.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, meal_date, meal_number
      order by created_at asc nulls last, id asc
    ) as rn
  from public.meals
)
delete from public.meals m
using ranked r
where m.id = r.id
  and r.rn > 1;

-- Also clean exact duplicate names within the same user's day.
-- This catches duplicate rows that may have inconsistent meal_number values
-- but represent the same named meal.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, meal_date, lower(trim(name))
      order by created_at asc nulls last, id asc
    ) as rn
  from public.meals
  where name is not null
)
delete from public.meals m
using ranked r
where m.id = r.id
  and r.rn > 1;

-- Enforce the intended final-state rules so the duplicates cannot return.
create unique index if not exists meals_user_date_number_unique
  on public.meals(user_id, meal_date, meal_number);

create unique index if not exists meals_user_date_name_unique
  on public.meals(user_id, meal_date, lower(trim(name)));

create index if not exists meals_user_date_order_idx
  on public.meals(user_id, meal_date, meal_number);

commit;

-- Optional verification:
-- select user_id, meal_date, meal_number, count(*)
-- from public.meals
-- group by user_id, meal_date, meal_number
-- having count(*) > 1
-- order by meal_date, meal_number;
