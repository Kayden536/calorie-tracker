# Food database sharing update

This version keeps the configurable meal system from the previous working meal version and adds two-way food database saving.

## Meals
- Every account starts with Meal 1, Meal 2, and Meal 3.
- Each meal can be renamed.
- Users can add meals through Meal 10.
- Meal numbers remain stable even when names change.

## Personal + Community foods
- The Add Food flow can save a food to My Foods, Community Foods, or both at once.
- The manual-food flow can also publish the same food to Community Foods while keeping the personal copy.
- A single Supabase RPC performs the two inserts in one database transaction, so a partial save is avoided if one side fails.
- The personal and community records retain links to each other when both are created together.

## Database
If you already have the MacroSync database, run `supabase-meals-migration.sql` once.
If you are creating a new database, `supabase-schema.sql` contains the same changes.
