# MacroSync Project Documentation

This file consolidates the project-specific Markdown documentation that was previously spread across multiple files.



# ADMIN-SETUP.md

# MacroSync Administrator Setup

MacroSync already has an `is_admin` flag in `public.profiles`, and the application now exposes administrator status in the UI. The admin page and trainer-verification controls are protected by the database `is_admin()` function.

## Assign the two initial administrators

The exact two accounts were not included in the source package, so their identifiers must be supplied before they can be safely assigned. Use the Supabase SQL Editor and replace the two email placeholders below with the exact emails belonging to the two intended administrator accounts:

```sql
update public.profiles
set is_admin = true
where lower(email) in (
  lower('ADMIN_ACCOUNT_1@example.com'),
  lower('ADMIN_ACCOUNT_2@example.com')
);
```

Then verify:

```sql
select id, display_name, email, is_admin
from public.profiles
where is_admin = true
order by email;
```

Do not put passwords or authentication secrets in this file or in SQL. The account emails are only used to identify the already-created Supabase profiles.


# FOOD-DATABASE-SHARING.md

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


# FOOD-DATABASES.md

# MacroSync Food Database Layer

MacroSync uses independent food providers and never silently averages conflicting nutrition values.

## Providers

- **USDA FoodData Central** — primary U.S. government reference source; requires `USDA_API_KEY`.
- **Health Canada Canadian Nutrient File (CNF)** — government reference source. The current adapter uses the public CNF API and does not require an API key. Health Canada publishes detailed nutrient data and the 2026 CNF includes 5,993 foods.
- **UK Composition of Foods Integrated Dataset (CoFID)** — UK government reference dataset. The provider adapter is included and supports either a future JSON API through `COFID_API_BASE_URL` or a local normalized CSV through `COFID_DATA_PATH`. CoFID itself is currently distributed by GOV.UK as downloadable dataset files rather than a documented general search API.
- **Open Food Facts** — secondary product database for branded/packaged foods.
- **Community Foods / My Foods** — user-created sources.

## Environment

```
USDA_API_KEY=...
CNF_API_BASE_URL=https://food-nutrition.canada.ca/api/canadian-nutrient-file
COFID_API_BASE_URL=
COFID_DATA_PATH=server/data/cofid.csv
```

### CoFID normalized CSV
If you want to use CoFID before a future API exists, place a CSV at `server/data/cofid.csv` with these columns (aliases are accepted):

`id,name,calories,protein,carbs,fat,fiber,sugar,sodium`

Values are expected per 100 g. Extra columns are ignored.

## Cross-reference

The Compare Sources modal now checks USDA, CNF, CoFID (when configured), and Open Food Facts. It displays calories, protein, carbohydrates, fat, fiber, sugars, and sodium. It reports source-to-source differences but does not average or overwrite values.

This architecture lets another provider be added later by implementing the same normalized provider shape:

- `id`
- `name`
- `brand`
- `dataType`
- `servingSize`
- `servingUnit`
- `householdServing`
- `nutrients.calories`
- `nutrients.protein`
- `nutrients.carbs`
- `nutrients.fat`
- `nutrients.fiber`
- `nutrients.sugar`
- `nutrients.sodium`
- `nutritionVerification`
- `source`

## CoFID 2021 included dataset

MacroSync now ships a normalized `server/data/cofid.json` generated from the McCance and Widdowson's Composition of Foods Integrated Dataset 2021 workbook supplied for this project. No CoFID API key is required. The app searches this local reference dataset directly.

## Provider hierarchy

1. USDA FoodData Central — server-side API; requires `USDA_API_KEY`.
2. Health Canada Canadian Nutrient File — public CNF API; no API key in the configured read flow.
3. UK CoFID 2021 — bundled normalized reference dataset; no API key.
4. Open Food Facts — read API; no API key, but requests identify MacroSync with a User-Agent.
5. Community Foods / My Foods — MacroSync's Supabase data.

Cross-reference results are displayed independently. MacroSync does not average values from different databases.


# MEALS-AND-RECIPE-SEARCH-v29.md

# MacroSync v29 changes

## Recipe ingredient search
The recipe builder now has exactly two ingredient search areas:

1. **MacroSync Community Foods** — searches foods published by MacroSync users.
2. **Reference food databases** — searches USDA FoodData Central, Canada CNF, UK CoFID, and Open Food Facts.

Results identify their source so the creator can see which database supplied each ingredient.

## Meal management
Users always retain at least three meals and can have up to ten.

- Meals 1–3 cannot be deleted when they are the only three meals remaining.
- Optional meals (4–10, or any meal while more than three exist) can be deleted.
- A meal must have no foods logged under its name before it can be deleted. The UI tells the user to move or delete those foods first rather than silently moving them.
- Adding a meal reuses the lowest available meal number, so deleting Meal 4 and adding a meal later will use Meal 4 again.


# MEALS-CHANGE.md

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


# MEALS-FIX.md

# Meal system fix

This version starts from the known-working `calorie_tracker(1).zip` Render version.

The meal UI now loads meals directly from `public.meals` instead of depending on the `ensure_default_meals` RPC to return rows. If an account has no meal rows, the app creates Meal 1, Meal 2, and Meal 3 automatically under the user's RLS policy.

The requested behavior remains:
- Meal 1, Meal 2, Meal 3 by default
- Rename any meal
- Add meals up to Meal 10
- Existing food entries are moved to the new name when a meal is renamed

If the existing Supabase database has not yet been migrated, run `supabase-meals-migration.sql` once in the Supabase SQL Editor.


# MEALS-PER-DAY-v30.md

# MacroSync v30 — Meals Per Day

Meal configuration is now date-scoped. Each user can have 3–10 meal slots independently for each calendar day.

- Changing today's meal count does not affect yesterday, tomorrow, or any other date.
- Existing diary dates are preserved by creating meal rows from their logged meal names.
- Days without meal rows are initialized with Meal 1–3 when opened.
- Rename, add, and delete operations are restricted to the selected date.
- A meal cannot be deleted when it still contains food entries on that same date.
- The database enforces the 3–10 range per user/date.

Run `supabase-meals-per-day-migration.sql` after the existing meal migration. The main `supabase-schema.sql` also contains the daily-meal table/index changes for fresh database setup.


# PAID-TIERS.md

# MacroSync Paid Tier Plan

This document records the planned subscription structure for MacroSync. **Payments, subscriptions, and billing are not implemented yet.** These notes are product-planning requirements for a future release.

## Core principle

All eight nutrition goals should remain available to every MacroSync user. Goal selection and the starting macro calculation are **not** intended to be a paid-only feature.

The paid tiers should provide additional convenience, capacity, analysis, and automation rather than locking users out of the core goal system.

## Planned tiers

### Free

The free tier should provide a complete, useful food-tracking experience, including:

- Food logging
- Daily calorie and macro targets
- All eight goal choices
- Starting macro calculations for all eight goals
- Food database search
- Basic progress tracking
- Basic recipes and meals
- Account/settings
- Basic social/friend functionality
- A limited monthly allowance of normal user-to-user messages
- Core trainer/client functionality where applicable

### Basic+

Basic+ is planned as the first paid tier and should focus on expanded limits and additional personalization.

Potential features:

- Larger personal food database limits
- More saved recipes
- Community food creation/publishing
- Expanded food and serving tools
- More detailed nutrition history
- Additional personalization options
- Higher usage limits for applicable features
- A substantially larger monthly user-to-user messaging allowance

### Premium

Premium is planned as the advanced/power-user tier.

Potential features:

- Advanced progress and trend analysis
- Advanced nutrition history and reporting
- Advanced food search/filtering tools
- Advanced trainer tools
- Higher or unlimited applicable limits
- Goal trend monitoring and macro-adjustment automation
- Highest user-to-user messaging allowance, potentially unlimited depending on final storage costs

## Premium goal automation

The eight goals themselves remain free. Premium can add automation around those goals.

Planned Premium functionality:

1. **Trend detection:** analyze logged weight and other relevant logged progress data to identify a sustained trend that may match one of the adjustment recommendations for the selected goal.
2. **Recommended adjustment:** show the user what adjustment is being recommended and why.
3. **One-click adjustment:** provide an option for the Premium user to apply the recommended macro change automatically.
4. **Manual approval:** automatic changes should not silently alter a user's targets. The user should be able to review the recommendation before applying it.
5. **Adjustment history:** keep a record of previous target changes so the user can see when and why targets changed.
6. **Goal reassessment:** support the existing goal guidance around reassessing after meaningful weight changes and transitioning between goal phases.

The recommendation engine should use the adjustment rules already defined for each goal rather than creating a separate set of Premium-only goals.

## Planned user-to-user messaging limits

Normal user-to-user messaging can remain available on the Free tier, but a monthly message allowance can help control database growth and abuse without removing messaging entirely.

A possible starting structure is:

- **Free:** limited monthly message allowance.
- **Basic+:** substantially higher monthly allowance.
- **Premium:** highest allowance, potentially unlimited if storage and abuse controls make that practical.

These limits should apply to normal user-to-user conversations. Trainer/client messaging can be evaluated separately because it is part of the trainer feature set.

The message limit should be enforced server-side/Supabase-side, not only by disabling the send button in the frontend. The system should also consider rate limiting and message retention/cleanup later if storage becomes a concern. Message text is relatively small compared with media files, so message count is primarily an abuse and database-growth control rather than a major storage concern by itself.

## Planned entitlement architecture

When subscriptions are eventually added, feature access should be controlled through a centralized entitlement system rather than scattered payment checks throughout the frontend.

Example concepts:

```js
canUseFeature('advanced_progress')
canUseFeature('community_food_creation')
canUseFeature('goal_auto_adjustments')
getLimit('personal_foods')
getLimit('saved_recipes')
```

Entitlements and limits should ultimately be enforced server-side/Supabase-side as well as reflected in the UI. Hiding a button in client-side JavaScript alone is not sufficient access control.

## Payments status

**Not implemented.**

There should be no payment provider, checkout flow, subscription requirement, or billing dependency added until the product's pricing and tier limits are finalized.


## v43 infrastructure notes

The core application now records nutrition-goal history and maintains daily nutrition aggregates. Premium automation can later consume those bounded datasets rather than repeatedly scanning the raw food-entry table. Conversation history is cursor-paginated, and normal message updates use Realtime events instead of client polling.

## Verified trainer program and future trainer monetization

Trainer accounts are separate from verified status. A user may create a trainer account, but an unverified trainer is treated as a normal account for privileges: trainer-only tools, client connections, and trainer-specific capabilities remain unavailable until verification is approved by an administrator.

Verified trainers receive a visible **Verified Trainer** badge. Verification is an administrative trust decision, not a paid feature. Normal users cannot publish directly to the Community Foods database; Community Food publishing is intended for verified trainers and remains subject to validation and moderation.

### Planned verified-trainer pricing incentive

When payments are eventually implemented, verified trainers are planned to receive a heavily discounted subscription, potentially at the Basic price or below. The intended incentive is for trainers to use MacroSync themselves and encourage their clients to join.

The planned value proposition is:

- Verified trainers receive full access to the MacroSync app and trainer-only features for a very low subscription price.
- Clients continue to choose Free, Basic, or Premium independently and pay the normal user price.
- Trainer use of MacroSync can therefore act as an ongoing, product-driven acquisition channel for clients.
- A trainer/client connection does not automatically give the client a free subscription.
- Any future trainer-sponsored client seats or discounts should be implemented as a separate feature rather than silently changing the normal subscription price.

### Future trainer services and payments

Payments are **not implemented yet**. The architecture should eventually support trainers offering paid services or plans through MacroSync without coupling payment state to the trainer/client connection itself.

Future concepts may include:

- Trainer services or coaching plans
- Client subscriptions to a trainer service
- Payment records and payout records
- Trainer/client billing status
- Workout programming and assignments
- Workout tracking and workout history
- Trainer review of shared nutrition, progress, and workout data
- Trainer feedback and communication

Payment processing should eventually use a dedicated payment provider rather than storing raw card/payment credentials in MacroSync. Trainer verification and payment/subscription status should remain separate concepts.


# POLICY-SETUP.md

# MacroSync Terms, Privacy, and Minor-Account Setup

This release adds:

- Terms of Service and Privacy Policy version 1.0.
- Required Terms + Privacy acceptance during signup.
- Minimum account age of 13.
- Ages 13–15 are limited accounts until parent/guardian consent is completed.
- Ages 16+ receive the standard feature set.
- For ages 13–15, the signup email field is the parent/legal-guardian email; the child's own email is not required.
- A display name is not required for ages 13–15.
- Limited accounts can use food logging and the food database only.
- Friends, messaging, shared meals, goals, progress, recipes, feedback, and notifications are blocked for limited accounts.
- Limited-account restrictions are enforced in the database as well as the UI.
- Parent/guardian consent is tied to completion of the Supabase email confirmation for the parent/guardian email supplied during signup.
- Terms/privacy version and acceptance timestamps are stored on the user's profile.

## Supabase setup

1. Run `supabase-terms-privacy-minor-migration.sql` in the Supabase SQL Editor for an existing MacroSync database.
2. For a new database, `supabase-schema.sql` already contains the required columns, functions, triggers, and policies.
3. Keep Supabase email confirmation enabled. For ages 13–15, the parent/guardian email is the authentication email and must complete the confirmation process before the account can become fully approved.
4. If you customize the Supabase confirmation email template, clearly state that the email recipient is being asked to confirm the parent/guardian email and approve the minor's MacroSync account.
5. Test both an age 13–15 account and an age 16+ account before production deployment.

## Important legal note

The policy text is written to reflect the product behavior in this release, including the no-sale/data-use commitment and third-party service-provider processing. It is not a substitute for legal advice. Before commercial launch, have the Terms, Privacy Policy, minor-consent flow, monetization terms, and applicable state/federal privacy requirements reviewed by a qualified attorney.


# PUBLIC-LAUNCH-CHECKLIST.md

# MacroSync Public Launch Checklist

## Must complete in production
- [ ] Run `supabase-public-launch-v56-migration.sql` in Supabase.
- [ ] Confirm Community Food insert attempts by unverified users fail at the database layer.
- [ ] Confirm an approved trainer can publish a Community Food.
- [ ] Rotate the USDA API key if the previous `.env` was ever shared outside a trusted environment.
- [ ] Configure production environment variables; never upload `.env`.
- [ ] Enable Supabase backups / Point-in-Time Recovery and perform a restore test.
- [ ] Verify production HTTPS and the final domain.
- [ ] Test RLS for food logs, profiles, messages, friendships, trainer verification, feedback, and admin-only data.
- [ ] Test account deletion end-to-end in production.
- [ ] Review Terms and Privacy contact information before launch.
- [ ] Add a real support contact to the public app before launch.

## Recommended operational setup
- [ ] Configure Redis for multi-instance deployments.
- [ ] Review the Admin → App errors queue regularly.
- [ ] Review product analytics weekly.
- [ ] Schedule `cleanup_public_launch_telemetry(90)` as a recurring database job if desired.
- [ ] Run the smoke test against the deployed domain.

## Launch strategy
1. Small public beta.
2. Observe onboarding completion and first-food logging.
3. Fix reliability/usability issues.
4. Add small, non-blocking banner advertising only after the core user experience is stable.


# RELIABILITY.md

# MacroSync reliability checklist

This update adds an application health endpoint, graceful shutdown, bounded public API rate limiting, database-side account deletion, RLS/RPC enforcement, and moderation audit records.

For production: enable Supabase Point-in-Time Recovery/backups on the paid plan you choose, test restores, monitor database size and API errors, keep secrets server-side, use HTTPS, configure a production process manager, and use a shared rate-limit store if more than one server instance is deployed.

The `/api/health` endpoint reports server and configuration state but does not expose secrets.


# SERVING-OPTIONS.md

# MacroSync Serving Options

Creator foods now support a default serving plus optional exact alternative servings.

## Default serving
The creator enters:
- amount (for example `4`)
- unit (for example `oz`, `egg`, `cup`, `slice`)
- weight in grams
- calories, protein, carbs, and fat for that default serving

The default serving is the preferred basis for logging because its nutrition values are stored directly.

## Additional serving options
A creator can add alternatives such as `100 g`, `4 oz`, `1 egg`, or `1 cup`. Each option includes its amount, unit, and gram weight. The creator can also enter exact nutrition for that option. When exact nutrition is supplied, MacroSync uses it directly instead of converting from another basis.

If exact nutrition is not supplied, the option is estimated from the stored serving weight.

## Conversion policy
Creators choose one of:
- **Do not offer gram/ounce/unit conversions** — only the creator's saved serving choices can be logged.
- **Allow estimated conversions** — MacroSync may convert to grams or ounces using the stored weight. These conversions are estimates and are not guaranteed to match the original source exactly.

Cups and arbitrary units should normally be added as creator-provided options because a generic conversion from grams requires food-specific density or unit weight information.


# STORAGE-OPTIMIZATION.md

# MacroSync storage optimization

This build preserves the existing user-facing behavior while applying safe storage optimizations.

## Messages

- Message bodies remain lossless text; no lossy compression is used.
- PostgreSQL can automatically TOAST/compress sufficiently large text values.
- Message notification rows no longer duplicate the complete message body. They store a short generic notification and reference the message by `message_id`.
- The existing participant/chronological index is kept intentionally small instead of adding overlapping indexes.
- Base64 is not used as a compression technique because it increases data size.

## Food logs

- USDA records are referenced by `fdc_id` rather than copying the USDA database into Supabase.
- Food-entry nutrition values remain available as a compact historical snapshot so editing a community food cannot rewrite old nutrition history.
- The existing user/date index is retained for efficient diary and history queries.

## Further scale optimization

At very large scale, the next measured optimization should be a migration to a compact meal/log hierarchy and selective lossless compression for unusually large message bodies. That should be benchmarked against real MacroSync data before changing the live storage representation.


# SUPABASE-SQL-GUIDE.md

# MacroSync Supabase SQL Guide

The SQL setup has been consolidated to two files.

## New database

Run **`supabase-schema.sql`**. It is the authoritative current-state schema and includes the features that previously lived in separate migrations, including recipe sharing, trainer verification/social fields, and public-launch hardening/telemetry.

## Existing database

If the database was created from the older MacroSync/PulsePlate SQL files, run **`supabase-legacy-upgrade.sql`** once. It preserves the historical migrations in dependency order so older installations can be brought forward without manually tracking 14 separate files.

Do not run the full schema and legacy upgrade together on a fresh database.

## Ongoing changes

For future changes, add a new numbered migration only when an already-deployed database needs an upgrade. Periodically fold completed migrations into `supabase-schema.sql` so the project keeps a clean current-state baseline.


## v0.57.0 food logging update

For an already-deployed v0.56.0 database, run **`supabase-food-logging-v57-migration.sql`**. It adds Brand/Store metadata, Recent Foods, normalized food-entry serving/source fields, the two-day planning limit, and the copy-to-tomorrow RPC.

The same final state is already included in `supabase-schema.sql` and `supabase-legacy-upgrade.sql` for their respective setup paths.


# V46-CHANGES.md

# MacroSync V46 changes

## Friend request safety
- Normal users can initiate friend requests to normal users and trainers.
- Trainer -> trainer requests remain allowed.
- Trainer -> normal-user requests are blocked at the database boundary.
- Incoming requests have Accept and Reject actions.
- Pending friend requests expire after 7 days and must be sent again.
- Friend request creation/accept/reject are handled by security-definer RPCs instead of direct client updates.

## Nutrition sharing
- Friends can share a Food, Saved Meal, Recipe, or Day Plan.
- Sharing can happen from an accepted-friend message conversation.
- The recipient must Accept or Decline the share.
- Accepting never changes the recipient's food log automatically.
- After acceptance, the recipient chooses whether to log/save the item.
- Recipes can be saved to the recipient's own Recipes or logged for today.
- Meals can be saved as a Saved Meal or added to today's log.
- Food can be added to today's log.
- Day Plans can be added to today's log.
- Shared nutrition uses a snapshot so later edits to the sender's source do not break the shared item.
- Shared nutrition can also appear in the Friends hub as a standalone inbox item.

## Supabase
Run `supabase-nutrition-sharing-v46-migration.sql` after the existing migrations.


# V46.1-SETTINGS-TRAINER-LAYOUT-FIX.md

# V46.1 — Settings / Personal Trainer Layout Fix

Fixed the Settings → Personal Trainer subpage layout:

- Reasserted the mobile bottom navigation as viewport-fixed on Settings.
- Prevented the Settings/Trainer content from creating horizontal page overflow.
- Constrained the main content and trainer profile form to the viewport width.
- Added mobile min-width/max-width safeguards to the trainer form and two-column fields.
- Prevented horizontal overflow from producing white space to the right of the page.

No Supabase migration is required for this CSS/layout-only fix.


# V46.2-SETTINGS-TRAINER-FIX.md

# V46.2 — Personal Trainer Settings Layout Fix

- Reverted the global layout hardening added in V46.1 so other pages keep their original behavior.
- Kept the existing site-wide/mobile navigation CSS unchanged.
- Applied narrow-screen width/min-width constraints only to the Personal Trainer settings panel and its form controls.
- Changed the trainer profile two-column form grids to one column on narrow screens, matching the existing mobile form behavior.
- No Supabase migration changes.


# V46.3-SETTINGS-UI-REFRESH.md

# MacroSync v46.3 — Settings UI Refresh

- Reworked the Settings page to use the same `.workspace` layout used by the rest of MacroSync.
- Updated Settings sub-navigation to match the app navigation/card language.
- Standardized Settings inputs, selects, textareas, buttons, toggles, dividers, and danger zone styling.
- Updated Trainer Profile and Trainer Verification UI to use the same field/card treatment.
- Added responsive rules for tablet/mobile without changing global navigation or other pages.
- No Supabase migration required.


# V46.4-SETTINGS-MOBILE-NAV-FIX.md

# V46.5 — Settings Mobile Navigation Fix

- Moved the Settings mobile bottom navigation outside `.app-shell` so it cannot become anchored to the page/document layout.
- Kept the change scoped to `settings.html`; other pages are not modified by this fix.
- Reasserted viewport-fixed positioning, safe-area offsets, width, and z-index for the Settings mobile navigation.
- Preserved the existing Settings UI refresh and trainer settings layout.
- No Supabase migration required.


# V46.5-SETTINGS-MOBILE-NAV-FIX.md

# V46.5 — Settings Mobile Navigation Fix

## Root cause addressed
The Settings mobile navigation could render correctly during the initial page paint, then lose viewport anchoring after MacroSync finished initializing. The Settings page's initialized DOM/layout could leave the navigation affected by the page layout tree, producing a bottom-of-document nav and horizontal white space.

## Fix
- Settings mobile navigation is moved to the document root after the common MacroSync UI initializes.
- The nav is explicitly kept `position: fixed` on viewports below 760px.
- Settings page, app shell, workspace, and settings grid are constrained to the viewport width.
- Horizontal overflow is clipped only for the Settings page.
- Resize/orientation changes re-apply the Settings nav anchoring.
- Other pages' navigation/layout rules are not modified.

## Validation
- JavaScript syntax check: passed.
- No Supabase migration required.


# V46.6.1-TRAINER-SETTINGS-LEAK-FIX.md

# MacroSync V46.6.1 — Trainer Settings Leak Fix

- Restored the complete V46.5 `public/js/app.js` baseline so application initialization is intact.
- Removed the V46.5 Settings mobile-navigation stabilization code and all references to it.
- Restricted `renderTrainerSettings()` to `body[data-page="settings"]` and a Settings-scoped host.
- Added a narrow defensive cleanup for explicit Settings/trainer UI roots on non-Settings pages.
- Added a MutationObserver guard for asynchronous insertion of those explicit Settings roots.
- No Supabase/database changes.
- Verified `public/js/app.js` with Node syntax checking.


# V47-TRAINER-PROFILE-REBUILD.md

# V47 — Trainer Profile Rebuild

- Removed the previous trainer-profile settings renderer and rebuilt it as a new, Settings-only component.
- Removed the global MutationObserver/settings leak guard introduced during V46.6.
- The trainer profile UI is now mounted only inside the existing Settings trainer-profile host.
- Rebuilt profile sections: Profile basics, Professional details, Professional links, Public profile, and Verification.
- Kept existing `trainer_profiles` storage and verification RPC compatibility so existing trainer data is not discarded.
- Business/professional name is saved to `profiles.business_name`; trainer profile fields continue using `trainer_profiles`.
- Public listing remains disabled until verification is approved.
- No Supabase migration is required for this rebuild.


# V48-SETTINGS-BASE-ONLY.md

# MacroSync V48 — Base Settings Only

- Completely removed the Trainer Profile settings page/section from Settings.
- Removed the Trainer Profile tab from the Settings navigation.
- Removed the Trainer Profile settings renderer and its Settings-specific form logic.
- Removed Trainer Profile Settings CSS.
- Settings now contains only the existing base settings sections: Account, Privacy, and Feedback.
- The separate Find a Trainer page and trainer functionality elsewhere in MacroSync were not removed.
- No Supabase migration is required for this change.


# V55-AUDIT.md

# MacroSync V55 stability audit

## Baseline
The latest MacroSync archive available in the project library was V47. This V55 build uses that latest available archive as the baseline because a separate V55 archive was not available in the workspace.

## Pages checked
- Dashboard
- Log Food
- Goals
- Progress / Stats
- Recipes
- Friends
- Add Friends
- Messages
- Shared Meals
- Find a Trainer
- Settings
- Account
- Admin Moderation
- Authentication
- Terms of Service
- Privacy Policy

## Automated checks completed
- All JavaScript files pass `node --check`.
- All local HTML `href`/`src` references resolve to files in the package.
- No duplicate HTML element IDs were found.
- HTML5 doctype is present on every page.
- All 16 HTML pages are included in the smoke test.
- Notification selector syntax was audited; malformed selectors were fixed.

## Stability fixes in V55
1. Fixed the message-notification toggle selector.
2. Fixed the mark-all-notifications-read selector.
3. Fixed limited-minor mobile navigation hiding to target the actual `.mobile-nav` element.
4. Preserved the V47 trainer-settings tab visibility fix and the global `[hidden]` CSS safeguard.
5. Added an explicit `data-page="goals"` marker to Goals.
6. Restored `account.html` as a functioning Account page instead of an immediate meta-refresh to Settings.
7. Added `smoke-test.mjs` so the same basic integrity checks can be rerun after future edits.
8. Updated `package.json` to MacroSync V55 (`0.55.0`).

## Important verification boundary
The audit is code/package-level. Live Supabase authentication, RLS policies, RPCs, USDA/Open Food Facts/Canada/CoFID API calls, browser notifications, and production hosting behavior require the actual configured deployment environment and cannot be fully validated from the archive alone.


# V57-FOOD-LOGGING-UPDATE.md

# MacroSync v0.57.0 — Food logging update

This update adds the requested food-logging improvements:

- Optional Brand and Store fields for Personal Foods and Community Foods.
- One combined External Foods search across USDA, Open Food Facts, Health Canada CNF, and UK CoFID.
- MacroSync Foods search combines the signed-in user's Personal Foods with public Community Foods. Personal Foods remain available to all users.
- Meal is selected once for the logging session; individual food serving dialogs use that selected meal.
- Recent Foods keeps up to 20 recently logged food identities and remembers the last-used serving/amount.
- Recent Foods can be added directly to the currently selected meal.
- External serving dialogs use source-provided household measures when available (for example scoop, cup, slice, piece) and always retain grams/ounces as the weight fallback. MacroSync does not invent a household conversion when a source does not provide one.
- Planning ahead can be enabled to allow logging up to two days in advance. The database also enforces the two-day limit.
- Dashboard food entries can be copied to tomorrow without removing the original entry.
- Food-entry metadata is stored so recent foods and copied entries retain source, serving, brand, and store information.

## SQL

For an existing database, run `supabase-food-logging-v57-migration.sql`.

For a new database, `supabase-schema.sql` contains the final v0.57.0 state.


# server/data/cofid/README.md

# UK CoFID provider

MacroSync includes a normalized local copy of the **McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID) 2021** workbook supplied for this integration.

- Source: official UK CoFID 2021 workbook
- Records: 2,886 usable food records
- Basis: per 100 g
- Common nutrients: energy, protein, carbohydrate, fat, fibre, sugars, sodium
- Additional nutrients: selected minerals, vitamins, and cholesterol are retained when available.

The normalized file is `server/data/cofid.json`. The original Excel workbook is intentionally not shipped with the application because the JSON is smaller and faster to search.

`COFID_API_BASE_URL` remains available as an optional override if an official future CoFID API is introduced.

## v0.59.0 — Automatic Serving Conversions


### Future-date multi-add
- With Planning ahead enabled, the serving dialog now lets the user add the food to **1 day ahead**, **2 days ahead**, or **both days**.
- Selecting both creates two independent `food_entries` rows, one for each future date.
- The existing database two-day limit remains the enforcement boundary.

The serving selector now treats external database foods and user-created foods differently:

- **External Foods:** MacroSync automatically builds serving conversions from source-provided gram weights whenever available. Every external food includes a **cup** option. Common conversions such as tablespoons, teaspoons, ml, grams, and ounces are also provided. Source-specific units such as slices, pieces, eggs, and scoops are kept when the source supplies their weight.
- **Estimated conversions:** When a source does not provide a usable household-volume weight, MacroSync uses an estimated cup basis and clearly labels the conversion as estimated. It does not present that estimate as source-exact.
- **User-added foods:** Personal Foods and Community Foods are **exact-serving-only by default**. A creator can explicitly select **Allow MacroSync auto conversions** to enable estimated conversions for that food.
- Existing creator choices are preserved when a food already has an explicit `conversion_mode`; the new UI default is exact-only for newly created user foods.

