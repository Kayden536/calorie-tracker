# Meal system fix

This version starts from the known-working `calorie_tracker(1).zip` Render version.

The meal UI now loads meals directly from `public.meals` instead of depending on the `ensure_default_meals` RPC to return rows. If an account has no meal rows, the app creates Meal 1, Meal 2, and Meal 3 automatically under the user's RLS policy.

The requested behavior remains:
- Meal 1, Meal 2, Meal 3 by default
- Rename any meal
- Add meals up to Meal 10
- Existing food entries are moved to the new name when a meal is renamed

If the existing Supabase database has not yet been migrated, run `supabase-meals-migration.sql` once in the Supabase SQL Editor.
