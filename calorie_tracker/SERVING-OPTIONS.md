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
