export function normalizeImportedFood(input, source = "user-import") {
  return {
    source,
    sourceId: input.sourceId || null,
    name: String(input.name || input.food || "").trim(),
    brand: input.brand || null,
    barcode: input.barcode || input.upc || null,
    serving: {
      size: Number(input.servingSize ?? input.serving_size) || null,
      unit: input.servingUnit ?? input.serving_unit ?? "g",
      grams: Number(input.grams ?? input.serving_grams) || null
    },
    nutrients: {
      calories: Number(input.calories) || null,
      protein: Number(input.protein) || null,
      carbohydrates: Number(input.carbohydrates ?? input.carbs) || null,
      fat: Number(input.fat) || null,
      fiber: Number(input.fiber) || null,
      sugar: Number(input.sugar) || null,
      sodium: Number(input.sodium) || null
    },
    verification: {
      status: "user-imported",
      confidence: 25
    }
  };
}
