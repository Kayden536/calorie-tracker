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
