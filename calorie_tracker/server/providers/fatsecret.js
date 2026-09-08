import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

let tokenCache = { token: null, expiresAt: 0 };

async function accessToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 30000) return tokenCache.token;
  const basic = Buffer.from(`${config.fatsecretClientId}:${config.fatsecretClientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: "basic" });
  const data = await fetchJson("https://oauth.fatsecret.com/connect/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body
  }, config.timeoutMs);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function parse(description, label) {
  const match = String(description || "").match(new RegExp(`${label}\\s*:\\s*([0-9.]+)`, "i"));
  return match ? Number(match[1]) : null;
}

export async function search(query) {
  if (!config.providers.fatsecret) return [];
  const token = await accessToken();
  const url = new URL("https://platform.fatsecret.com/rest/foods/search/v1");
  url.searchParams.set("search_expression", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("max_results", String(config.maxResults));
  const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } }, config.timeoutMs);
  return (data?.foods?.food || []).map(food => {
    const description = String(food.food_description || "");
    return {
      id: `fatsecret:${food.food_id}`,
      source: "fatsecret",
      sourceId: String(food.food_id),
      name: food.food_name || "Unknown food",
      brand: food.brand_name || "",
      dataType: "FatSecret",
      servingSize: 1,
      servingUnit: "serving",
      servingGrams: null,
      householdServing: "",
      nutritionBasis: "serving",
      nutrients: {
        calories: parse(description, "Calories") || 0,
        protein: parse(description, "Protein") || 0,
        carbs: parse(description, "Carbs") || parse(description, "Carbohydrates") || 0,
        fat: parse(description, "Fat") || 0
      },
      nutritionVerification: { verified: true, warnings: [], errors: [], basis: "listed serving", sourceStatus: "commercial-source" }
    };
  });
}
