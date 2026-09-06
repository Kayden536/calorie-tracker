# PulsePlate Alpha

This package turns the existing PulsePlate UI prototype into a small, real web-app alpha with:

- Supabase email/password authentication
- Persistent user profiles
- Persistent nutrition goals
- Persistent food diary entries
- USDA FoodData Central search through a server-side API proxy
- Responsive existing PulsePlate UI
- Friend discovery and accepted connections
- In-app messaging with a conversation selector
- Per-friend daily meal sharing for normal users
- Automatic client meal visibility for personal trainers
- Same-page shared-meal viewer with a friend selector and date controls
- A foundation that can later be consumed by a mobile client

## 1. Install

Install Node.js 20+ and run:

```bash
npm install
```

## 2. Create Supabase project

Create a Supabase project, open SQL Editor, and run `supabase-schema.sql`. The schema is safe to run again if you need to reset/reapply the policies during development.

Enable Email authentication. For a public alpha, keep email confirmation enabled.

Copy `.env.example` to `.env` and fill in:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `USDA_API_KEY`

The browser receives only the Supabase publishable key. Do NOT put the USDA API key in frontend JavaScript. The server keeps that key in `.env`.

## 3. USDA FoodData Central

Create a Data.gov API key and place it in `USDA_API_KEY`.

PulsePlate calls `/api/foods/search`, and the server calls USDA FoodData Central. This keeps the USDA key out of the browser and makes it possible to add caching/rate limiting later.

## 4. Run

```bash
npm start
```

Open http://localhost:3000

## Alpha scope

The core account, food logging, goals, dashboard, friend connections, messaging, and controlled meal sharing are persistent. Recipes remain sample UI. Social/trainer access is protected by Supabase RLS, including a database function that prevents trainers from disabling client meal sharing.

Before accepting paid customers, add production hosting, custom email/SMTP, rate limiting, error monitoring, privacy/terms pages, backups, database migrations, and a formal security/privacy review.

## First-time onboarding
New users are prompted after their first successful login to choose a primary goal, optional current/goal weight, daily calorie and macro targets, and whether they are a personal trainer. Trainer status can optionally include a business/gym/organization. These settings can be changed later from Goals and Account.

## Personal foods, recipes, and saved meals

This update adds three private, user-owned database layers:

- **My Foods**: manual foods are saved to `user_foods` and can be reused later.
- **Recipes**: reusable combinations of foods are stored in `recipes` and `recipe_items`.
- **Saved Meals**: an entire logged meal can be saved to `saved_meals` and `saved_meal_items` for quick future logging.

### Supabase setup

Run the complete `supabase-schema.sql` in the Supabase SQL Editor. The new tables and RLS policies are included at the bottom of the file.

### Logging workflow

1. Search an existing USDA food.
2. Click it to open the serving picker.
3. Change amount and serving type; the macro preview updates automatically.
4. Choose Breakfast, Lunch, Dinner, or Snack and add it.
5. If the food does not exist, choose **Create Manual Food**. The new food is saved to the user's private `My Foods` library and can then be logged normally.
6. Use **Recipes** to create reusable combinations.
7. Use **Save this meal** in the diary to save a complete meal for personal quick logging.

Saved foods, recipes, and saved meals are protected by Supabase row-level security and are not automatically visible to other users.


## Current combined update

This build combines the food/recipe/database features with the MacroSync settings update:
- USDA food search with serving-size controls and automatic macro recalculation
- separate manual-food creation for foods not in USDA
- personal food database
- reusable recipes
- private saved meals for faster logging
- collapsible meal categories
- MacroSync frontend branding while backend/internal PulsePlate names remain unchanged
- hamburger settings menu with dark/light mode and email change
- forgot-password flow
- message notifications using the `notifications` table and `send_message` RPC

Run the complete `supabase-schema.sql` in Supabase after deploying this update.

## Terms, privacy, and age-based access

See `POLICY-SETUP.md`. Existing Supabase databases should run `supabase-terms-privacy-minor-migration.sql`. New installations can use the updated `supabase-schema.sql`.

## CSV meal history import/export

MacroSync supports browser-based CSV data portability from **Settings → Privacy & data**.

- **Import MyFitnessPal CSV** accepts the nutrition/meal CSV from a MyFitnessPal export. Current MyFitnessPal exports arrive as a ZIP containing separate nutrition, progress, and exercise CSV files; select the nutrition CSV when importing.
- The importer recognizes common MyFitnessPal headers for date, meal, food, serving, calories, protein, carbohydrates, and fat.
- Standard MyFitnessPal meal names such as Breakfast, Lunch, Dinner, and Snacks are mapped to the user's numbered MacroSync meals when possible. Additional meal names can be added up to MacroSync's 10-meal limit.
- Exact duplicate food-log rows are skipped automatically when the same user/date/meal/food/serving/macros already exist.
- Import is performed in the browser and inserts the resulting food entries through the user's normal Supabase permissions.
- **Export meal history CSV** downloads all of the signed-in user's food-log rows in a MacroSync-compatible CSV format, including date, meal, food, serving, calories, protein, carbs, fat, FDC ID, and logged timestamp.


## Food databases

See `FOOD-DATABASES.md` for the multi-database search and cross-reference design.

## Food databases
See `FOOD-DATABASES.md` for USDA, Health Canada CNF, UK CoFID, Open Food Facts, and cross-reference setup. CNF is live through its public API; CoFID is prepared for a future API or local normalized CSV.

## Planned Paid Tiers

MacroSync's future paid-tier plan is documented in `PAID-TIERS.md`. Payments and subscriptions are not implemented yet. All eight nutrition goals are intended to remain available to everyone; Premium is planned to add optional goal trend detection and one-click macro-adjustment automation rather than locking the goals themselves behind a paywall.

### Future paid-tier messaging
Normal user-to-user messaging is planned to remain available to Free users with a limited monthly allowance. Basic+ would receive a larger allowance, while Premium would receive the highest allowance and may eventually have unlimited messaging if storage and abuse controls support it. Payments and these limits are not implemented yet.

## Scalability hardening (v43)

This release adds a database/application hardening layer intended to keep the architecture efficient as MacroSync grows toward hundreds of thousands of accounts:

- composite indexes for the main food-log, messaging, social, meal, recipe, moderation, and report access paths
- PostgreSQL trigram indexes for the existing community/trainer/profile `%query%` searches
- a `daily_nutrition_summaries` aggregate maintained by database triggers so progress/streak views do not rescan the complete food-entry history
- `nutrition_goal_history` so future Premium trend/adjustment automation has an auditable history rather than repeatedly scanning raw logs
- cursor-based conversation pagination with a bounded default of 50 messages instead of loading an entire conversation
- Realtime message events instead of 3-second client polling; message bodies are not placed in the Realtime event payload
- optional Redis-backed API rate limiting for horizontally scaled Express instances, with a bounded local fallback
- an explicit operational-data cleanup function for scheduled retention jobs
- fresh-install schema includes the hardening; existing installations should also run `supabase-scalability-hardening-migration.sql`

The large `food_entries` table is intentionally not partitioned in this release. Its access paths are indexed and progress reads use daily aggregates, while partitioning remains a planned migration if raw-log volume eventually reaches a point where physical table size/maintenance becomes the next bottleneck.

For multiple Express instances, configure `REDIS_URL` before scaling out so rate limits are shared between instances.
