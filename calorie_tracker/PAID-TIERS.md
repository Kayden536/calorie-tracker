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
