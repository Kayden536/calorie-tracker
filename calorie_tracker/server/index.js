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

// Lightweight in-process rate limiting for public API endpoints. For multi-instance deployments,
// move this counter to a shared store such as Redis.
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`; const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || now - b.start >= windowMs) b = { start: now, count: 0 };
    b.count++; rateBuckets.set(key, b);
    if (b.count > max) return res.status(429).json({ error: "Too many requests. Please wait and try again." });
    next();
  };
}

function nutrientMap(food) {
  // FoodData Central nutrient records are represented on a 100 g / 100 ml basis.
  // Keep that basis intact here; serving-size conversion is handled separately.
  const values = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  for (const nutrient of food.foodNutrients || []) {
    const name = String(nutrient.nutrientName || nutrient.name || "").toLowerCase();
    const unit = String(nutrient.unitName || nutrient.unit || "").toLowerCase();
    const amount = Number(nutrient.value ?? nutrient.amount ?? 0);
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

  // A gram of food cannot contain more than 100 g of any macronutrient.
  for (const [name, value] of [["protein", nutrients.protein], ["carbs", nutrients.carbs], ["fat", nutrients.fat]]) {
    if (value > 100.01) errors.push(`${name} exceeds 100 g per 100 g of food.`);
  }

  // Protein/carbohydrate/fat are components of the food's mass. Allow a tiny
  // rounding margin, but reject mathematically impossible combinations.
  if (nutrients.protein + nutrients.carbs + nutrients.fat > 100.5) {
    errors.push("Protein, carbohydrate, and fat exceed the food's total mass.");
  }

  // Calorie/macronutrient comparison is a warning rather than a hard rejection:
  // fiber, alcohol, organic acids, rounding, and USDA calculation methods can
  // make the simple 4/4/9 estimate differ from reported energy.
  const macroCalories = nutrients.protein * 4 + nutrients.carbs * 4 + nutrients.fat * 9;
  if (nutrients.calories > 0 && macroCalories > 0) {
    const relativeDifference = Math.abs(macroCalories - nutrients.calories) / nutrients.calories;
    if (relativeDifference > 0.35) warnings.push("Reported calories differ substantially from calories estimated from macros.");
  }

  return {
    verified: errors.length === 0,
    warnings,
    errors,
    basis: "per 100 g"
  };
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

app.get("/api/foods/search", rateLimit(60, 60_000), async (req, res) => {
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

    const foods = Array.isArray(data.foods) ? data.foods.map(food => {
      const nutrients = nutrientMap(food);
      return {
        id: food.fdcId,
        name: food.description || "Unknown food",
        brand: food.brandOwner || food.brandName || "",
        dataType: food.dataType || "",
        servingSize: food.servingSize || null,
        servingUnit: food.servingSizeUnit || "",
        householdServing: food.householdServingFullText || "",
        nutrients,
        nutritionVerification: verifyNutrition(nutrients)
      };
    }).filter(food => food.nutritionVerification.verified) : [];

    res.json({ foods, totalHits: Number(data.totalHits) || 0, verification: { rejectedInvalidRecords: (Array.isArray(data.foods) ? data.foods.length : 0) - foods.length } });
  } catch (error) {
    console.error("USDA request failed:", error);
    res.status(502).json({ error: "Unable to reach the USDA food database right now." });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled server error:", error);
  if (res.headersSent) return;
  res.status(500).json({ error: "An unexpected server error occurred." });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "auth.html"));
});

const server = app.listen(port, () => {
  console.log("========================================");
  console.log("       PulsePlate Alpha Server");
  console.log("========================================");
  console.log(`Server: http://localhost:${port}`);
  console.log(`USDA API key: ${USDA_API_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log(`Supabase: ${SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log("========================================");
});


process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
