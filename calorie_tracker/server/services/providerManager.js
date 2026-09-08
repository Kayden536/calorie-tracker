import { config } from "../config.js";
import { search as searchUSDA } from "../providers/usda.js";
import { search as searchOFF } from "../providers/openFoodFacts.js";
import { search as searchFatSecret } from "../providers/fatsecret.js";
import { allSettledMap } from "../utils/http.js";
import { compareFoods } from "./compare.js";

const providers = [
  ["usda", searchUSDA, "usda"],
  ["openfoodfacts", searchOFF, "openFoodFacts"],
  ["fatsecret", searchFatSecret, "fatsecret"]
];

export async function searchAll(query) {
  const results = await allSettledMap(providers, async ([name, search]) => {
    const foods = await search(query);
    return { provider: name, foods };
  });

  const foods = results.flatMap(result => {
    const configKey = result.item[2];
    return result.ok && config.providers[configKey] ? result.value.foods : [];
  });
  const failures = results
    .filter(result => !result.ok)
    .map(result => ({ provider: result.item[0], message: result.error?.message || "Provider error" }));

  return {
    foods,
    providers: results.map(result => ({
      name: result.item[0],
      enabled: Boolean(config.providers[result.item[2]]) && result.ok,
      count: result.ok ? result.value.foods.length : 0,
      error: result.ok ? null : result.error?.message || "Provider error"
    })),
    failures,
    comparison: compareFoods(foods)
  };
}
