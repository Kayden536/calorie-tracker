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
