# MacroSync v30 — Meals Per Day

Meal configuration is now date-scoped. Each user can have 3–10 meal slots independently for each calendar day.

- Changing today's meal count does not affect yesterday, tomorrow, or any other date.
- Existing diary dates are preserved by creating meal rows from their logged meal names.
- Days without meal rows are initialized with Meal 1–3 when opened.
- Rename, add, and delete operations are restricted to the selected date.
- A meal cannot be deleted when it still contains food entries on that same date.
- The database enforces the 3–10 range per user/date.

Run `supabase-meals-per-day-migration.sql` after the existing meal migration. The main `supabase-schema.sql` also contains the daily-meal table/index changes for fresh database setup.
