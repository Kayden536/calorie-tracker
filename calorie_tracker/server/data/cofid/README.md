# UK CoFID provider

MacroSync includes a normalized local copy of the **McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID) 2021** workbook supplied for this integration.

- Source: official UK CoFID 2021 workbook
- Records: 2,886 usable food records
- Basis: per 100 g
- Common nutrients: energy, protein, carbohydrate, fat, fibre, sugars, sodium
- Additional nutrients: selected minerals, vitamins, and cholesterol are retained when available.

The normalized file is `server/data/cofid.json`. The original Excel workbook is intentionally not shipped with the application because the JSON is smaller and faster to search.

`COFID_API_BASE_URL` remains available as an optional override if an official future CoFID API is introduced.
