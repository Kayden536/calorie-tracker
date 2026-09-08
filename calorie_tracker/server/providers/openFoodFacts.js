import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

const n = (obj, key) => {
  const value = obj?.nutriments?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

export async function search(query) {
  if (!config.providers.openFoodFacts) return [];
  const url = new URL("https://world.openfoodfacts.org/api/v3/search");
  url.searchParams.set("search_terms", query);
  url.searchParams.set("page_size", String(config.maxResults));
  url.searchParams.set("fields", "code,_id,product_name,generic_name,brands,serving_size,product_quantity,nutriments");
  const data = await fetchJson(url, { headers: { "User-Agent": config.offUserAgent } }, config.timeoutMs);
  return (data.products || []).filter(p => p.product_name || p.generic_name).map(product => ({
    id: `openfoodfacts:${product.code || product._id}`,
    source: "openfoodfacts",
    sourceId: String(product.code || product._id || ""),
    name: product.product_name || product.generic_name || "Unknown food",
    brand: product.brands || "",
    dataType: "Open Food Facts",
    servingSize: null,
    servingUnit: "g",
    servingGrams: null,
    householdServing: product.serving_size || "",
    nutritionBasis: "per100g",
    nutrients: {
      calories: n(product, "energy-kcal_100g") || 0,
      protein: n(product, "proteins_100g") || 0,
      carbs: n(product, "carbohydrates_100g") || 0,
      fat: n(product, "fat_100g") || 0,
      fiber: n(product, "fiber_100g") || 0,
      sugar: n(product, "sugars_100g") || 0,
      sodium: n(product, "sodium_100g") || 0
    },
    nutritionVerification: { verified: true, warnings: [], errors: [], basis: "per 100 g", sourceStatus: "community-source" }
  }));
}
