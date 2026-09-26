-- MacroSync v0.60.6.2 - Fix profiles.primary_goal check/default mismatch
--
-- The existing legacy upgrade normalized old stored values but did not reset
-- the column DEFAULT. On some existing databases the default can still be
-- 'health', which is rejected by the newer profiles_primary_goal_check.
-- Run this once against an existing MacroSync database.

-- Remove the current check first so legacy values can be normalized safely.
alter table public.profiles drop constraint if exists profiles_primary_goal_check;

-- Normalize legacy goal values to the current canonical values used by MacroSync.
update public.profiles
set primary_goal = case primary_goal
  when 'lose' then 'lose_basic'
  when 'gain' then 'gain_basic'
  when 'health' then 'maintain'
  else primary_goal
end
where primary_goal in ('lose', 'gain', 'health');

-- Ensure future profiles get a value accepted by the current constraint.
alter table public.profiles
  alter column primary_goal set default 'maintain';

-- Recreate the constraint using the current selectable goal values plus the
-- legacy custom/other values that may exist in older databases.
alter table public.profiles
  add constraint profiles_primary_goal_check check (
    primary_goal in (
      'lose_basic',
      'lose_muscle',
      'lose_gain_muscle',
      'gain_basic',
      'gain_muscle_maintain_fat',
      'lean_bulk',
      'maintain',
      'recomp',
      'custom',
      'other'
    )
  );

-- Optional verification: should return zero rows.
select primary_goal, count(*) as profile_count
from public.profiles
group by primary_goal
order by primary_goal;
