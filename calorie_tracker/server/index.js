import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const USDA_API_KEY = String(process.env.USDA_API_KEY || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();

function nutrientMap(food) {
  const values = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  for (const nutrient of food.foodNutrients || []) {
    const name = String(nutrient.nutrientName || nutrient.name || "").toLowerCase();
    const unit = String(nutrient.unitName || nutrient.unit || "").toLowerCase();
    const amount = Number(nutrient.value ?? nutrient.amount ?? 0);
    if (!Number.isFinite(amount)) continue;
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

app.get("/api/config", (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Supabase configuration is missing." });
  }
  res.json({ supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    server: "PulsePlate Alpha",
    usdaApiKeyConfigured: Boolean(USDA_API_KEY),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)
  });
});

app.get("/api/foods/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) return res.json({ foods: [], totalHits: 0 });
  if (!USDA_API_KEY) return res.status(500).json({ error: "USDA API key is not configured." });

  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("api_key", USDA_API_KEY);
    url.searchParams.set("query", query);
    url.searchParams.set("pageSize", "12");

    const logUrl = new URL(url);
    logUrl.searchParams.set("api_key", "REDACTED");
    console.log(`USDA search: ${logUrl}`);

    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "PulsePlate-Alpha/0.1" }
    });
    const responseText = await response.text();

    if (!response.ok) {
      console.error(`USDA returned HTTP ${response.status}: ${responseText.slice(0, 500)}`);
      if (response.status === 401 || response.status === 403) {
        return res.status(502).json({ error: "The USDA API rejected the API key." });
      }
      if (response.status === 429) {
        return res.status(502).json({ error: "The USDA API rate limit was reached. Please wait and try again." });
      }
      return res.status(502).json({ error: `USDA API returned HTTP ${response.status}.` });
    }

    let data;
    try { data = JSON.parse(responseText); }
    catch { return res.status(502).json({ error: "USDA returned invalid JSON." }); }

    const foods = Array.isArray(data.foods) ? data.foods.map(food => ({
      id: food.fdcId,
      name: food.description || "Unknown food",
      brand: food.brandOwner || food.brandName || "",
      dataType: food.dataType || "",
      servingSize: food.servingSize || null,
      servingUnit: food.servingSizeUnit || "",
      householdServing: food.householdServingFullText || "",
      nutrients: nutrientMap(food)
    })) : [];

    res.json({ foods, totalHits: Number(data.totalHits) || 0 });
  } catch (error) {
    console.error("USDA request failed:", error);
    res.status(502).json({ error: "Unable to reach the USDA food database right now." });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "auth.html"));
});

app.listen(port, () => {
  console.log("========================================");
  console.log("       PulsePlate Alpha Server");
  console.log("========================================");
  console.log(`Server: http://localhost:${port}`);
  console.log(`USDA API key: ${USDA_API_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log(`Supabase: ${SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log("========================================");
});
