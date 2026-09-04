# Configurable Meals Update

This version starts from the exact `calorie_tracker(1).zip` working version. No previous combined build was used.

## Behavior
- Every account starts with **Meal 1**, **Meal 2**, and **Meal 3**.
- Each meal can be renamed.
- Renaming a meal also updates existing food entries assigned to that meal, so logged foods are not lost.
- Users can add additional meals up to **10 total**.
- New meals are numbered by their permanent meal number and default to `Meal 4`, `Meal 5`, etc., but can be renamed immediately.
- Food logging, moving entries, saved-meal logging, and recipe logging now use the user's configurable meal list instead of Breakfast/Lunch/Dinner/Snack.
- Shared meal viewing uses the shared user's configurable meal names when the database migration has been applied.

## Database
Run `supabase-meals-migration.sql` in Supabase SQL Editor if the existing database is already populated and you do not want to rerun the complete schema.

If setting up a new database from scratch, use the updated `supabase-schema.sql` instead.
