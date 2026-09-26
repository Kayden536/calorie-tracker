# MacroSync v0.60.6.12

- Added visible in-app login and password-reset progress/error/success feedback.
- Disabled browser-native form validation blocking so authentication errors are surfaced inside MacroSync.
- Added explicit email validation and button working states for login/reset.
- Fixed auth page markup and synchronized application version reporting.

# v0.60.6.9

## 0.60.6.9
- Fixed authentication mode visibility so login only shows email, password, and password recovery.
- Date of birth, new-password confirmation, display name, and Terms/Privacy/parental agreements are now shown only while creating an account.
- Prevented the generic `.field` display styling from overriding HTML `hidden` attributes on the authentication page.

# v0.60.6.9

## 0.60.6.9
- Added Quick add buttons directly to searched External, Personal, and Community Food results.
- Quick add uses each food's default serving immediately and respects the preselected meal and planning destination.
- Users can still choose the amount with the existing food-serving modal, and logged entries can be edited later.
- Audited application JavaScript for syntax errors and corrected the onboarding fallback that could submit the invalid legacy `health` goal.
- Polished bulk food deletion, saved-meal removal, and confirmation dialogs with consistent MacroSync modals and responsive controls.
- Fixed the HTML structure of the signup logo block and strengthened the project smoke test for URL fragments.
- Replaced remaining native browser alert/confirm dialogs in the main app with consistent MacroSync notices and confirmation modals.

# v0.60.6.6
- Moved future-date selection out of the individual food serving modal.
- Added a pre-logging Quick add destination selector for selected date, 1 day ahead, 2 days ahead, or both.
- Applied the selected Quick add destination to normal foods, recent foods, and saved meals.

## 0.60.6.6
- Fixed signup Terms of Service and Privacy Policy agreement text disappearing on narrow screens.
- Reworked agreement rows to use a fixed checkbox column and a flexible text column.
- Kept checkbox sizing compact so the agreement checkboxes no longer appear unusually far apart.
- Preserved wrapping for long agreement and parental-consent text without hiding content.

## 0.60.6.4
- Fixed mobile/narrow-screen signup layout so Terms of Service, Privacy Policy, and parental agreement text wraps inside the signup card instead of extending off the right side.
- Added overflow-safe sizing for signup agreement rows and form children.

## 0.60.6.2
- Fixed profile creation failures caused by the existing `profiles_primary_goal_check` allowing a different set of values than the onboarding flow.
- Added an explicit `primary_goal: 'maintain'` when a new profile is first created, so profile creation does not depend on a stale database default.
- Added `supabase-fix-profile-primary-goal-v60.6.2.sql`, which normalizes legacy `health`, `lose`, and `gain` values, sets the database default to `maintain`, and recreates the goal check constraint.

## 0.60.6.1

- Added bulk selection and deletion for foods logged on the selected day.
- Added Select all / Clear / Delete selected controls for the daily food log.
- Added bulk selection and removal for foods inside Saved Meal editing.
- Kept individual food delete/remove controls available alongside bulk actions.

## 0.60.1

- Fixed the Log Food page so saved meals are loaded and can be recalled with the existing Add button.
- Saved meals now appear in the Quick logging section on the Log Food page after login.


## 0.60.0

- Separated the MacroSync food search into independent **Personal Foods** and **Community Foods** tabs.
- Personal Food searches now query only the signed-in user’s private food library.
- Community Food searches now query only published Community Foods and retain `@displayname` author search support.
- External Foods remains a separate combined search across USDA FoodData Central, Open Food Facts, Health Canada CNF, and UK CoFID.
- Updated the mobile food-source tabs to support all three search categories.
# MacroSync v0.59.1

## Bug fix
- Fixed the Supabase legacy upgrade SQL error `42P13` caused by a historical `request_trainer_verification()` definition that had a defaulted parameter followed by required parameters.
- The historical six-argument definition now gives defaults to all parameters after the first default, allowing the full legacy upgrade script to compile before the later expanded verification function replaces it.

## 0.59.0

### Future-date multi-add
- Planning ahead now offers three future-date choices when adding a food: **1 day ahead**, **2 days ahead**, or **both days**.
- The same serving, meal, nutrition, brand, store, and source metadata is added as separate food entries for each selected future date.
- The feature remains limited to the existing two-day planning window and only appears when Planning ahead is enabled.

### Automatic serving conversions
- External Foods now always receive MacroSync automatic serving conversions.
- Every external food gets a cup option, plus common volume/weight conversions where a gram basis can be established.
- Source-provided household measurements are preferred over generated estimates.
- Food-specific units such as slices, pieces, eggs, and scoops are preserved when the external source provides their gram weight.
- Generated household conversions are explicitly marked as estimated; MacroSync does not claim an invented density is source-exact.
- User-added Personal Foods and Community Foods are now exact-serving-only by default.
- Users can explicitly choose “Allow MacroSync auto conversions” when creating or editing their own foods.

## 0.57.0
- Added combined external food search and MacroSync Foods search (Personal + Community).
- Added optional Brand and Store metadata for Personal and Community Foods.
- Added source-aware serving conversions and external household measures.
- Added meal-once-per-session logging, 20-item Recent Foods, and last-used serving amounts.
- Added two-day planning toggle and copy-to-tomorrow for individual dashboard entries.

# MacroSync Changelog

## 0.56.0 — Public launch preparation
- Restricted new Community Food publishing to verified trainers at both UI and database/RPC layers.
- Added optional product analytics for authenticated users.
- Added client error reporting visible to administrators.
- Added app version context to feedback and error reports.
- Added support-request feedback category.
- Added a public landing page and root route.
- Added basic production response security headers.
- Added public-launch telemetry cleanup function.
- Removed the real development `.env` from the distributable package; use `.env.example`.
- Fixed invalid nested trainer verification/profile forms.
