import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import fs from "node:fs";
import Redis from "ioredis";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "1mb" }));

app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  next();
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'landing.html')));
app.use(express.static(path.join(__dirname, "..", "public")));

const USDA_API_KEY = String(process.env.USDA_API_KEY || "").trim();
const OPEN_FOOD_FACTS_BASE = "https://world.openfoodfacts.org";
const OPEN_FOOD_FACTS_USER_AGENT = "MacroSync/0.1 (nutrition food database integration)";
const CNF_API_BASE = String(process.env.CNF_API_BASE_URL || "https://food-nutrition.canada.ca/api/canadian-nutrient-file").replace(/\/$/, "");
const COFID_API_BASE = String(process.env.COFID_API_BASE_URL || "").trim().replace(/\/$/, "");
const COFID_DATA_PATH_CONFIG = String(process.env.COFID_DATA_PATH || "").trim();
const COFID_DATA_PATH = COFID_DATA_PATH_CONFIG
  ? (path.isAbsolute(COFID_DATA_PATH_CONFIG)
      ? COFID_DATA_PATH_CONFIG
      : path.resolve(__dirname, "..", COFID_DATA_PATH_CONFIG))
  : path.join(__dirname, "data", "cofid.json");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();

// Shared rate limiting when REDIS_URL is configured; bounded in-process fallback
// keeps a single-instance deployment functional. This avoids a per-instance
// limiter becoming a horizontal-scaling bypass.
const rateBuckets = new Map();
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }) : null;
if (redis) redis.on('error', error => console.error('Redis rate-limit error:', error.message));

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, bucket] of rateBuckets) if (bucket.start < cutoff) rateBuckets.delete(key);
}, 5 * 60 * 1000).unref();

function rateLimit(max, windowMs) {
  return async (req, res, next) => {
    const key = `macrosync:rate:${req.ip}:${req.path}`;
    if (redis) {
      try {
        if (redis.status === 'wait') await redis.connect();
        const bucket = Math.floor(Date.now() / windowMs);
        const redisKey = `${key}:${bucket}`;
        const count = await redis.incr(redisKey);
        if (count === 1) await redis.expire(redisKey, Math.ceil(windowMs / 1000) + 1);
        if (count > max) return res.status(429).json({ error: "Too many requests. Please wait and try again." });
        return next();
      } catch (error) {
        console.warn('Redis unavailable; using local rate limiter:', error.message);
      }
    }

    const now = Date.now();
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


function openFoodFactsNutrients(product) {
  const n = product?.nutriments || {};
  const number = value => {
    const x = Number(value);
    return Number.isFinite(x) && x >= 0 ? x : 0;
  };
  return {
    calories: number(n['energy-kcal_100g'] ?? n['energy-kcal'] ?? (Number(n['energy_100g']) / 4.184)),
    protein: number(n['proteins_100g'] ?? n['proteins']),
    carbs: number(n['carbohydrates_100g'] ?? n['carbohydrates']),
    fat: number(n['fat_100g'] ?? n['fat']),
    fiber: number(n['fiber_100g'] ?? n['fiber']),
    sugar: number(n['sugars_100g'] ?? n['sugars']),
    sodium: number(n['sodium_100g'] ?? n['sodium']) * 1000
  };
}

function normalizeFoodName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function foodSimilarity(a, b) {
  const aa = new Set(normalizeFoodName(a).split(/\s+/).filter(Boolean));
  const bb = new Set(normalizeFoodName(b).split(/\s+/).filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  const intersection = [...aa].filter(x => bb.has(x)).length;
  return intersection / Math.max(aa.size, bb.size);
}

function compareNutrition(a, b) {
  const fields = ['calories', 'protein', 'carbs', 'fat'];
  const differences = {};
  for (const field of fields) {
    const av = Number(a?.[field] || 0);
    const bv = Number(b?.[field] || 0);
    differences[field] = av === 0 && bv === 0 ? 0 : Math.abs(av - bv) / Math.max(Math.abs(av), Math.abs(bv), 1);
  }
  const maxDifference = Math.max(...fields.map(field => differences[field]));
  return {
    differences,
    maxDifference,
    status: maxDifference <= 0.10 ? 'close' : maxDifference <= 0.25 ? 'moderate' : 'significant'
  };
}

async function fetchOpenFoodFacts(url, options = {}, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": OPEN_FOOD_FACTS_USER_AGENT,
          ...(options.headers || {})
        }
      });
      clearTimeout(timeout);

      if (response.ok) return response;

      const transient = [429, 500, 502, 503, 504].includes(response.status);
      const body = await response.text();
      lastError = new Error(`Open Food Facts returned HTTP ${response.status}.`);
      if (!transient || attempt === attempts - 1) {
        lastError.body = body.slice(0, 500);
        throw lastError;
      }

      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8_000)
        : 500 * (2 ** attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Open Food Facts request failed.");
}

async function searchOpenFoodFacts(query, page = 1, pageSize = 15) {
  const url = new URL(`${OPEN_FOOD_FACTS_BASE}/cgi/search.pl`);
  url.searchParams.set('search_terms', query);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('page', String(page));
  url.searchParams.set('fields', 'code,product_name,brands,nutriments,serving_size,serving_quantity,product_quantity,quantity');

  const response = await fetchOpenFoodFacts(url);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Open Food Facts returned invalid JSON.'); }

  const foods = (Array.isArray(data.products) ? data.products : []).map(product => {
    const nutrients = openFoodFactsNutrients(product);
    const servingSize = Number(product.serving_quantity);
    return {
      id: String(product.code || ''),
      name: product.product_name || 'Unknown food',
      brand: product.brands || '',
      dataType: 'Open Food Facts',
      servingSize: Number.isFinite(servingSize) && servingSize > 0 ? servingSize : null,
      servingUnit: Number.isFinite(servingSize) && servingSize > 0 ? 'g' : '',
      householdServing: product.serving_size || product.quantity || '',
      nutrients,
      nutritionVerification: verifyNutrition(nutrients),
      source: 'openfoodfacts',
      barcode: String(product.code || '')
    };
  }).filter(food => food.name && food.nutritionVerification.verified);

  return { foods, totalHits: Number(data.count) || foods.length, available: true, page, pageSize, totalPages: Math.max(1, Math.ceil((Number(data.count) || foods.length) / pageSize)) };
}

let cnfFoodIndexCache = { loadedAt: 0, foods: [] };
const CNF_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

function cnfNutrientMap(rows) {
  const values = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row.nutrient_web_name || row.nutrient_name || '').toLowerCase();
    const value = Number(row.nutrient_value);
    if (!Number.isFinite(value) || value < 0) continue;
    if (name.includes('energy') && (name.includes('kcal') || name.includes('kilocal'))) values.calories = value;
    else if (name === 'protein') values.protein = value;
    else if (name === 'carbohydrate') values.carbs = value;
    else if (name === 'fat, total') values.fat = value;
    else if (name.includes('fibre') || name.includes('fiber')) values.fiber = value;
    else if (name === 'sugars') values.sugar = value;
    else if (name === 'sodium') values.sodium = value;
  }
  return values;
}

function rankTextMatches(query, foods, limit = 8) {
  const q = normalizeFoodName(query);
  const qTokens = q.split(/\s+/).filter(Boolean);
  if (!qTokens.length) return [];
  return foods.map(food => {
    const name = normalizeFoodName(food.food_description || food.name);
    const tokens = new Set(name.split(/\s+/).filter(Boolean));
    const exactTokenHits = qTokens.filter(t => tokens.has(t)).length;
    const partialHits = qTokens.filter(t => name.includes(t)).length;
    const phrase = name.includes(q) ? 1 : 0;
    return { food, score: phrase * 100 + exactTokenHits * 12 + partialHits * 4 + foodSimilarity(q, name) * 10 };
  }).filter(x => x.score > 0).sort((a,b) => b.score-a.score).slice(0, limit).map(x=>x.food);
}

async function loadCnfFoodIndex() {
  if (cnfFoodIndexCache.foods.length && Date.now() - cnfFoodIndexCache.loadedAt < CNF_INDEX_TTL_MS) return cnfFoodIndexCache.foods;
  const url = new URL(`${CNF_API_BASE}/food/`);
  url.searchParams.set('lang', 'en'); url.searchParams.set('type', 'json');
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MacroSync/0.1' } });
  if (!response.ok) throw new Error(`Canadian Nutrient File returned HTTP ${response.status}.`);
  const data = await response.json();
  const foods = Array.isArray(data) ? data : (Array.isArray(data.foods) ? data.foods : []);
  cnfFoodIndexCache = { loadedAt: Date.now(), foods };
  return foods;
}

async function fetchCnfFood(food) {
  const id = Number(food.food_code);
  if (!Number.isFinite(id)) return null;
  const url = new URL(`${CNF_API_BASE}/nutrientamount/`);
  url.searchParams.set('id', String(id)); url.searchParams.set('lang', 'en'); url.searchParams.set('type', 'json');
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MacroSync/0.1' } });
  if (!response.ok) return null;
  const rows = await response.json();
  const nutrients = cnfNutrientMap(rows);
  const verification = verifyNutrition(nutrients);
  if (!verification.verified || nutrients.calories <= 0) return null;
  return {
    id: String(id), name: food.food_description || 'Unknown food', brand: '', dataType: 'Canadian Nutrient File',
    servingSize: 100, servingUnit: 'g', householdServing: '', nutrients, nutritionVerification: verification,
    source: 'cnf'
  };
}

async function searchCanadianNutrientFile(query, page = 1, pageSize = 15) {
  const index = await loadCnfFoodIndex();
  const candidates = rankTextMatches(query, index, 200);
  const start = (page - 1) * pageSize;
  const pageCandidates = candidates.slice(start, start + pageSize);
  const foods = (await Promise.all(pageCandidates.map(fetchCnfFood))).filter(Boolean);
  return { foods, totalHits: candidates.length, configured: true, page, pageSize, totalPages: Math.max(1, Math.ceil(candidates.length / pageSize)) };
}

let cofidCache = { loadedAt: 0, foods: [] };
const COFID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cofidConfigured() { return Boolean(COFID_API_BASE) || fs.existsSync(COFID_DATA_PATH); }

function loadCofidLocal() {
  if (cofidCache.foods.length && Date.now() - cofidCache.loadedAt < COFID_CACHE_TTL_MS) return cofidCache.foods;
  if (!fs.existsSync(COFID_DATA_PATH)) return [];
  const raw = fs.readFileSync(COFID_DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.foods) ? parsed.foods : []);
  cofidCache = { loadedAt: Date.now(), foods: rows.map(row => {
    const nutrients = {
      calories: Number(row.calories) || 0,
      protein: Number(row.protein) || 0,
      carbs: Number(row.carbs) || 0,
      fat: Number(row.fat) || 0,
      fiber: Number(row.fiber) || 0,
      sugar: Number(row.sugar) || 0,
      sodium: Number(row.sodium) || 0
    };
    return {
      id: String(row.id ?? row.food_code ?? ''),
      name: String(row.name ?? row.food_name ?? 'Unknown food'),
      brand: '', dataType: 'UK CoFID (2021)', servingSize: 100, servingUnit: 'g', householdServing: '',
      nutrients, extraNutrients: row.extraNutrients || {}, nutritionVerification: verifyNutrition(nutrients), source: 'cofid'
    };
  }).filter(food => food.name && food.nutritionVerification.verified) };
  return cofidCache.foods;
}

async function searchCofid(query, page = 1, pageSize = 15) {
  if (COFID_API_BASE) {
    const url = new URL(COFID_API_BASE);
    url.searchParams.set('q', query); url.searchParams.set('limit', String(pageSize)); url.searchParams.set('page', String(page));
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MacroSync/0.1' } });
    if (!response.ok) throw new Error(`CoFID API returned HTTP ${response.status}.`);
    const data = await response.json();
    const rows = Array.isArray(data) ? data : (Array.isArray(data.foods) ? data.foods : []);
    const foods = rows.map(row => {
      const nutrients = { calories:Number(row.calories ?? row.energy_kcal ?? 0), protein:Number(row.protein ?? 0), carbs:Number(row.carbs ?? row.carbohydrate ?? 0), fat:Number(row.fat ?? 0), fiber:Number(row.fiber ?? row.fibre ?? 0), sugar:Number(row.sugar ?? row.sugars ?? 0), sodium:Number(row.sodium ?? 0) };
      return { id:String(row.id ?? row.food_code ?? row.code ?? ''), name:row.name ?? row.food_name ?? row.food_description ?? 'Unknown food', brand:row.brand || '', dataType:'UK CoFID', servingSize:100, servingUnit:'g', householdServing:'', nutrients, extraNutrients:row.extraNutrients || {}, source:'cofid', nutritionVerification:verifyNutrition(nutrients) };
    }).filter(food=>food.nutritionVerification.verified);
    return { foods, totalHits: foods.length, configured:true, page, pageSize, totalPages: Math.max(1, Math.ceil(foods.length / pageSize)) };
  }
  const allFoods = rankTextMatches(query, loadCofidLocal(), 200);
  const start = (page - 1) * pageSize;
  const foods = allFoods.slice(start, start + pageSize);
  return { foods, totalHits: allFoods.length, configured: cofidConfigured(), page, pageSize, totalPages: Math.max(1, Math.ceil(allFoods.length / pageSize)) };
}

function buildCrossSourceComparison(sources) {
  const available = Object.entries(sources).filter(([, foods]) => foods?.length);
  if (available.length < 2) return null;
  const base = available[0][1][0];
  const comparisons = available.slice(1).map(([source, foods]) => ({
    source, nameSimilarity: foodSimilarity(base.name, foods[0].name), brandSimilarity: foodSimilarity(base.brand, foods[0].brand), nutrition: compareNutrition(base.nutrients, foods[0].nutrients)
  }));
  return { baseSource: available[0][0], comparisons, note: 'Candidate matches are ranked by food-name similarity. Values from separate databases are shown independently and are never silently averaged.' };
}

app.get("/api/config", (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: "Supabase configuration is missing." });
  }
  res.json({ supabaseUrl: SUPABASE_URL, supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY, appVersion: '0.59.0' });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    server: "MacroSync Beta",
    usdaApiKeyConfigured: Boolean(USDA_API_KEY),
    canadianNutrientFileConfigured: true,
    cofidConfigured: cofidConfigured(),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)
  });
});

app.get('/api/foods/search-all', rateLimit(45, 60_000), async (req, res) => {
  const query = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(20, Math.max(1, Number(req.query.pageSize) || 15));
  if (query.length < 2) return res.json({ foods: [], totalHits: 0, page, pageSize, totalPages: 0, sources: {} });

  const sourceResults = await Promise.allSettled([
    (async () => {
      if (!USDA_API_KEY) return { foods: [], totalHits: 0, available: false, error: 'USDA API key is not configured.' };
      const url = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
      url.searchParams.set('api_key', USDA_API_KEY); url.searchParams.set('query', query); url.searchParams.set('pageSize', '8'); url.searchParams.set('pageNumber', '1');
      const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MacroSync-Alpha/0.1' } });
      if (!response.ok) throw new Error(`USDA API returned HTTP ${response.status}.`);
      const data = JSON.parse(await response.text());
      const foods = (Array.isArray(data.foods) ? data.foods : []).map(food => { const nutrients=nutrientMap(food); return { id:food.fdcId,name:food.description||'Unknown food',brand:food.brandOwner||food.brandName||'',dataType:food.dataType||'USDA FoodData Central',servingSize:food.servingSize||null,servingUnit:food.servingSizeUnit||'',householdServing:food.householdServingFullText||'',nutrients,nutritionVerification:verifyNutrition(nutrients),source:'usda' }; }).filter(food=>food.nutritionVerification.verified);
      return { foods, totalHits:Number(data.totalHits)||foods.length, available:true };
    })(),
    searchOpenFoodFacts(query,1,8),
    searchCanadianNutrientFile(query,1,8),
    searchCofid(query,1,8)
  ]);
  const labels=['usda','openfoodfacts','cnf','cofid'];
  const sources={};
  labels.forEach((label,i)=>{const r=sourceResults[i];if(r.status==='fulfilled')sources[label]=r.value;else sources[label]={foods:[],totalHits:0,available:false,error:'Source temporarily unavailable.'};});
  const all=labels.flatMap(label=>(sources[label].foods||[]).map(food=>({...food,source:food.source||label,_sourceLabel:label})));
  const exactQuery=normalizeFoodName(query);
  all.sort((a,b)=>{const score=f=>{const name=normalizeFoodName(f.name);return (name===exactQuery?100:0)+(name.startsWith(exactQuery)?30:0)+foodSimilarity(exactQuery,name)*20+(f.brand?2:0);};return score(b)-score(a);});
  const start=(page-1)*pageSize; const foods=all.slice(start,start+pageSize);
  res.json({foods,totalHits:all.length,page,pageSize,totalPages:Math.max(1,Math.ceil(all.length/pageSize)),sources:Object.fromEntries(labels.map(l=>[l,{available:sources[l].available!==false,totalHits:Number(sources[l].totalHits||0)}]))});
});

app.get('/api/foods/details-openfoodfacts/:id', rateLimit(45, 60_000), async (req,res)=>{
  const id=String(req.params.id||'').trim();
  if(!id) return res.status(400).json({error:'Invalid Open Food Facts product code.'});
  try{
    const url=`${OPEN_FOOD_FACTS_BASE}/api/v2/product/${encodeURIComponent(id)}.json?fields=product_name,serving_size,serving_quantity,nutriments,brands`;
    const response=await fetchOpenFoodFacts(new URL(url));
    if(!response.ok) return res.status(502).json({error:'Open Food Facts product lookup failed.'});
    const data=await response.json(); const product=data.product||{}; const measures=[];
    const servingQuantity=Number(product.serving_quantity);
    const text=String(product.serving_size||'');
    if(Number.isFinite(servingQuantity)&&servingQuantity>0) measures.push({amount:1,unit:text||'serving',grams:servingQuantity});
    const regex=/([0-9]+(?:\.[0-9]+)?)\s*(scoop|cup|cups|slice|slices|piece|pieces|tbsp|tsp|tablespoon|teaspoon|bar|bars|egg|eggs|tortilla|tortillas|packet|packets|serving|servings)\s*\((?:about\s*)?([0-9]+(?:\.[0-9]+)?)\s*g\)/ig;
    let match; while((match=regex.exec(text))){measures.push({amount:Number(match[1]),unit:match[2],grams:Number(match[3])});}
    res.json({measures});
  }catch(error){console.error('Open Food Facts detail request failed:',error);res.status(502).json({error:'Unable to reach Open Food Facts right now.'});}
});

app.get("/api/foods/search", rateLimit(60, 60_000), async (req, res) => {
  const query = String(req.query.q || "").trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(15, Math.max(1, Number(req.query.pageSize) || 15));
  if (query.length < 2) return res.json({ foods: [], totalHits: 0, page, pageSize, totalPages: 0 });
  if (!USDA_API_KEY) return res.status(500).json({ error: "USDA API key is not configured." });

  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("api_key", USDA_API_KEY);
    url.searchParams.set("query", query);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("pageNumber", String(page));

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

    res.json({ foods, totalHits: Number(data.totalHits) || 0, page, pageSize, totalPages: Math.max(1, Math.ceil((Number(data.totalHits) || 0) / pageSize)), verification: { rejectedInvalidRecords: (Array.isArray(data.foods) ? data.foods.length : 0) - foods.length } });
  } catch (error) {
    console.error("USDA request failed:", error);
    res.status(502).json({ error: "Unable to reach the USDA food database right now." });
  }
});


app.get("/api/foods/search-openfoodfacts", rateLimit(45, 60_000), async (req, res) => {
  const query = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(15, Math.max(1, Number(req.query.pageSize) || 15));
  if (query.length < 2) return res.json({ foods: [], totalHits: 0, available: true, page, pageSize, totalPages: 0 });
  try {
    const result = await searchOpenFoodFacts(query, page, pageSize);
    res.json(result);
  } catch (error) {
    console.error('Open Food Facts request failed:', error);
    res.status(200).json({
      foods: [],
      totalHits: 0,
      available: false,
      error: 'Open Food Facts is temporarily unavailable. Other food databases are still available.'
    });
  }
});

app.get('/api/foods/details-usda/:id', rateLimit(45, 60_000), async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid USDA food id.' });
  if (!USDA_API_KEY) return res.status(503).json({ error: 'USDA API key is not configured.' });
  try {
    const response = await fetch(`https://api.nal.usda.gov/fdc/v1/food/${encodeURIComponent(id)}?api_key=${encodeURIComponent(USDA_API_KEY)}`, { headers: { Accept: 'application/json', 'User-Agent': 'MacroSync-Alpha/0.1' } });
    if (!response.ok) return res.status(response.status === 404 ? 404 : 502).json({ error: `USDA API returned HTTP ${response.status}.` });
    const food = await response.json();
    const measures = Array.isArray(food.foodMeasures) ? food.foodMeasures.map(m => ({ label: m.dissectedDescription || m.householdUnit || `${m.amount || 1} ${m.measureUnit?.name || 'serving'}`, grams: Number(m.gramWeight), amount: Number(m.amount || 1), unit: m.measureUnit?.name || m.householdUnit || 'serving' })).filter(m => Number.isFinite(m.grams) && m.grams > 0) : [];
    res.json({ measures });
  } catch (error) { console.error('USDA detail request failed:', error); res.status(502).json({ error: 'Unable to reach the USDA food database right now.' }); }
});

app.get('/api/foods/search-cnf', rateLimit(45, 60_000), async (req, res) => {
  const query = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(15, Math.max(1, Number(req.query.pageSize) || 15));
  if (query.length < 2) return res.json({ foods: [], totalHits: 0, configured: true, page, pageSize, totalPages: 0 });
  try { res.json(await searchCanadianNutrientFile(query, page, pageSize)); }
  catch (error) { console.error('CNF request failed:', error); res.status(502).json({ error: 'Unable to reach the Canadian Nutrient File right now.' }); }
});

app.get('/api/foods/search-cofid', rateLimit(30, 60_000), async (req, res) => {
  const query = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(15, Math.max(1, Number(req.query.pageSize) || 15));
  if (query.length < 2) return res.json({ foods: [], totalHits: 0, configured: cofidConfigured(), page, pageSize, totalPages: 0 });
  try { res.json(await searchCofid(query, page, pageSize)); }
  catch (error) { console.error('CoFID request failed:', error); res.status(502).json({ error: 'Unable to reach the configured CoFID source right now.' }); }
});

app.get("/api/foods/cross-reference", rateLimit(30, 60_000), async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ query, sources: {}, comparison: null });
  if (!USDA_API_KEY) return res.status(500).json({ error: 'USDA API key is not configured.' });
  try {
    const usdaUrl = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
    usdaUrl.searchParams.set('api_key', USDA_API_KEY); usdaUrl.searchParams.set('query', query); usdaUrl.searchParams.set('pageSize', '8');
    const [usdaResponse, offSettled, cnfSettled, cofidSettled] = await Promise.all([
      fetch(usdaUrl, { headers: { Accept: 'application/json', 'User-Agent': 'MacroSync/0.1' } }),
      searchOpenFoodFacts(query).then(value => ({ status: 'fulfilled', value })).catch(reason => ({ status: 'rejected', reason })),
      searchCanadianNutrientFile(query).then(value => ({ status: 'fulfilled', value })).catch(reason => ({ status: 'rejected', reason })),
      searchCofid(query).then(value => ({ status: 'fulfilled', value })).catch(reason => ({ status: 'rejected', reason }))
    ]);
    if (!usdaResponse.ok) throw new Error(`USDA returned HTTP ${usdaResponse.status}.`);
    const usdaData = JSON.parse(await usdaResponse.text());
    const offResult = offSettled.status === 'fulfilled' ? offSettled.value : { foods: [], totalHits: 0, available: false };
    const cnfResult = cnfSettled.status === 'fulfilled' ? cnfSettled.value : { foods: [], totalHits: 0, configured: false };
    const cofidResult = cofidSettled.status === 'fulfilled' ? cofidSettled.value : { foods: [], totalHits: 0, configured: false };
    const usdaFoods = (Array.isArray(usdaData.foods) ? usdaData.foods : []).map(food => {
      const nutrients = nutrientMap(food); return { id:food.fdcId, name:food.description||'Unknown food', brand:food.brandOwner||food.brandName||'', dataType:food.dataType||'USDA FoodData Central', servingSize:food.servingSize||null, servingUnit:food.servingSizeUnit||'', nutrients, nutritionVerification:verifyNutrition(nutrients), source:'usda' };
    }).filter(food=>food.nutritionVerification.verified);
    const sources = { usda:usdaFoods, openfoodfacts:offResult.foods||[], cnf:cnfResult.foods||[], cofid:cofidResult.foods||[] };
    res.json({ query, sources, configured: { usda:true, openfoodfacts:offResult.available !== false, cnf:true, cofid:cofidResult.configured }, comparison:buildCrossSourceComparison(sources) });
  } catch (error) { console.error('Cross-reference request failed:', error); res.status(502).json({ error:'Unable to cross-reference the food databases right now.' }); }
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
  console.log("       MacroSync Beta Server");
  console.log("========================================");
  console.log(`Server: http://localhost:${port}`);
  console.log(`USDA API key: ${USDA_API_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log(`Supabase: ${SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY ? "CONFIGURED" : "MISSING"}`);
  console.log(`CoFID local data: ${fs.existsSync(COFID_DATA_PATH) ? "FOUND" : "MISSING"} (${COFID_DATA_PATH})`);
  console.log(`Open Food Facts: ${OPEN_FOOD_FACTS_BASE}`);
  console.log("========================================");
});


process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
