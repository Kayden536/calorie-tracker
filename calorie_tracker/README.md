# PulsePlate Alpha

This package turns the existing PulsePlate UI prototype into a small, real web-app alpha with:

- Supabase email/password authentication
- Persistent user profiles
- Persistent nutrition goals
- Persistent food diary entries
- USDA FoodData Central search through a server-side API proxy
- Responsive existing PulsePlate UI
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

The core account, food logging, goals, and dashboard are real/persistent. Recipes and social/trainer features remain UI previews for the next milestone rather than pretending those systems are production-ready.

Before accepting paid customers, add production hosting, custom email/SMTP, rate limiting, error monitoring, privacy/terms pages, backups, database migrations, and a formal security/privacy review.

## First-time onboarding
New users are prompted after their first successful login to choose a primary goal, optional current/goal weight, daily calorie and macro targets, and whether they are a personal trainer. Trainer status can optionally include a business/gym/organization. These settings can be changed later from Goals and Account.
