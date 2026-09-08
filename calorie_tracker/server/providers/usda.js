import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

function nutrientMap(food) {
  const values = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  for (const item of food.foodNutrients || []) {
    const name = String(item.nutrientName || item.name || "").toLowerCase();
    const unit = String(item.unitName || item.unit || "").toLowerCase();
    const amount = Number(item.value ?? item.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (name.includes("energy") && (unit === "kcal" || name.includes("kcal"))) values.calories = amount;
    else if (name === "protein") values.protein = amount;
    else if (name.includes("carbohydrate")) values.carbs = amount;
    else if (name.includes("total lipid") || name === "fat") values.fat = amount;
    else if (name.includes("fiber")) values.fiber = amount;
    else if (name.includes("sugars, total") || name === "sugars") values.sugar = amount;
    else if (name.includes("sodium")) values.sodium = amount;
  }
  return values;
}

function verifyNutrition(nutrients) {
  const warnings = [];
  const errors = [];
  const values = [nutrients.calories, nutrients.protein, nutrients.carbs, nutrients.fat];
  if (!values.every(Number.isFinite)) errors.push("One or more nutrient values is not numeric.");
  if (values.some(v => v < 0)) errors.push("Negative nutrient values are not valid.");
  for (const [name, value] of [["protein", nutrients.protein], ["carbs", nutrients.carbs], ["fat", nutrients.fat]]) {
    if (value > 100.01) errors.push(`${name} exceeds 100 g per 100 g of food.`);
  }
  if (nutrients.protein + nutrients.carbs + nutrients.fat > 100.5) errors.push("Protein, carbohydrate, and fat exceed the food's total mass.");
  const macroCalories = nutrients.protein * 4 + nutrients.carbs * 4 + nutrients.fat * 9;
  if (nutrients.calories > 0 && macroCalories > 0) {
    const relativeDifference = Math.abs(macroCalories - nutrients.calories) / nutrients.calories;
    if (relativeDifference > 0.35) warnings.push("Reported calories differ substantially from calories estimated from macros.");
  }
  return { verified: errors.length === 0, warnings, errors, basis: "per 100 g" };
}

export async function search(query) {
  if (!config.providers.usda) return [];
  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("api_key", config.usdaApiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", String(config.maxResults));
  const data = await fetchJson(url, { headers: { Accept: "application/json", "User-Agent": "MacroSync/1.0" } }, config.timeoutMs);
  return (data.foods || []).map(food => {
    const nutrients = nutrientMap(food);
    return {
      id: `usda:${food.fdcId}`,
      source: "usda",
      sourceId: String(food.fdcId),
      name: food.description || "Unknown food",
      brand: food.brandOwner || food.brandName || "",
      dataType: food.dataType || "",
      servingSize: food.servingSize || null,
      servingUnit: food.servingSizeUnit || "g",
      servingGrams: String(food.servingSizeUnit || "").toLowerCase().includes("g") ? Number(food.servingSize) || null : null,
      householdServing: food.householdServingFullText || "",
      nutritionBasis: "per100g",
      nutrients,
      nutritionVerification: verifyNutrition(nutrients)
    };
  }).filter(food => food.nutritionVerification.verified);
}
