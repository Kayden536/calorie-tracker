const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function normalizeFood(food) {
  return {
    source: food.source,
    sourceId: String(food.sourceId ?? ""),
    name: String(food.name ?? "").trim(),
    brand: food.brand ? String(food.brand).trim() : null,
    barcode: food.barcode ? String(food.barcode) : null,
    serving: {
      size: num(food.serving?.size),
      unit: food.serving?.unit || "g",
      grams: num(food.serving?.grams)
    },
    nutrients: {
      calories: num(food.nutrients?.calories),
      protein: num(food.nutrients?.protein),
      carbohydrates: num(food.nutrients?.carbohydrates),
      fat: num(food.nutrients?.fat),
      fiber: num(food.nutrients?.fiber),
      sugar: num(food.nutrients?.sugar),
      sodium: num(food.nutrients?.sodium)
    },
    verification: {
      status: food.verification?.status || "unverified",
      confidence: num(food.verification?.confidence) ?? 0
    },
    raw: food.raw ?? null
  };
}

export function per100g(food) {
  const grams = food.serving?.grams;
  if (!grams || grams <= 0) return food;
  const factor = 100 / grams;
  const nutrients = Object.fromEntries(
    Object.entries(food.nutrients).map(([key, value]) => [
      key, value == null ? null : Math.round(value * factor * 100) / 100
    ])
  );
  return { ...food, nutrients, serving: { size: 100, unit: "g", grams: 100 } };
}
