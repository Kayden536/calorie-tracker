import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

export const config = {
  port: Number(process.env.PORT || 3000),
  providers: {
    usda: bool(process.env.USDA_ENABLED, true) && Boolean(process.env.USDA_API_KEY),
    openFoodFacts: bool(process.env.OPENFOODFACTS_ENABLED, true),
    fatsecret: bool(process.env.FATSECRET_ENABLED, false) &&
      Boolean(process.env.FATSECRET_CLIENT_ID) && Boolean(process.env.FATSECRET_CLIENT_SECRET)
  },
  usdaApiKey: process.env.USDA_API_KEY || "",
  offUserAgent: process.env.OPENFOODFACTS_USER_AGENT || "MacroSync/1.0",
  fatsecretClientId: process.env.FATSECRET_CLIENT_ID || "",
  fatsecretClientSecret: process.env.FATSECRET_CLIENT_SECRET || "",
  timeoutMs: Number(process.env.FOOD_PROVIDER_TIMEOUT_MS || 8000),
  maxResults: Number(process.env.FOOD_PROVIDER_MAX_RESULTS || 12),
  minChars: Number(process.env.FOOD_PROVIDER_SEARCH_MIN_CHARS || 2)
};
