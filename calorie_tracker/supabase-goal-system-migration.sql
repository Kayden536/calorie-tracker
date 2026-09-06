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
