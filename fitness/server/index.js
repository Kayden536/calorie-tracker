import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// Load environment variables
// --------------------------------------------------

const envPath = path.join(__dirname, '..', '.env');

dotenv.config({
  path: envPath
});

console.log(`Loading environment from: ${envPath}`);

// --------------------------------------------------
// Application
// --------------------------------------------------

const app = express();
const port = Number(process.env.PORT) || 3000;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(express.json({ limit: '1mb' }));

app.use(
  express.static(
    path.join(__dirname, '..', 'public')
  )
);

// --------------------------------------------------
// Environment variables
// --------------------------------------------------

const USDA_API_KEY = String(
  process.env.USDA_API_KEY || ''
).trim();

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ''
).trim();

const SUPABASE_PUBLISHABLE_KEY = String(
  process.env.SUPABASE_PUBLISHABLE_KEY || ''
).trim();

// --------------------------------------------------
// Environment status
// --------------------------------------------------

console.log(
  `USDA API key loaded: ${USDA_API_KEY ? 'YES' : 'NO'}`
);

console.log(
  `Supabase URL loaded: ${SUPABASE_URL ? 'YES' : 'NO'}`
);

console.log(
  `Supabase publishable key loaded: ${
    SUPABASE_PUBLISHABLE_KEY ? 'YES' : 'NO'
  }`
);

// --------------------------------------------------
// API CONFIG
// --------------------------------------------------

app.get('/api/config', (_req, res) => {
  if (
    !SUPABASE_URL ||
    !SUPABASE_PUBLISHABLE_KEY
  ) {
    return res.status(500).json({
      error: 'Supabase configuration is missing.'
    });
  }

  return res.json({
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey:
      SUPABASE_PUBLISHABLE_KEY
  });
});

// --------------------------------------------------
// USDA FOOD SEARCH
// --------------------------------------------------

app.get('/api/foods/search', async (req, res) => {
  const query = String(
    req.query.q || ''
  ).trim();

  // Don't search for extremely short queries.
  if (query.length < 2) {
    return res.json({
      foods: [],
      totalHits: 0
    });
  }

  // Make sure the server has the USDA key.
  if (!USDA_API_KEY) {
    console.error(
      'USDA_API_KEY is missing from environment variables.'
    );

    return res.status(500).json({
      error: 'USDA API key is not configured.'
    });
  }

  try {
    // ------------------------------------------------
    // Build USDA request URL
    // ------------------------------------------------

    const url = new URL(
      'https://api.nal.usda.gov/fdc/v1/foods/search'
    );

    url.searchParams.set(
      'query',
      query
    );

    url.searchParams.set(
      'pageSize',
      '25'
    );

    // USDA API key
    url.searchParams.set(
      'api_key',
      USDA_API_KEY
    );

    // ------------------------------------------------
    // Safe logging
    // ------------------------------------------------

    const logUrl = new URL(url);

    logUrl.searchParams.set(
      'api_key',
      'REDACTED'
    );

    console.log(
      `USDA request: ${logUrl.toString()}`
    );

    // ------------------------------------------------
    // Request USDA
    // ------------------------------------------------

    const response = await fetch(
      url.toString(),
      {
        method: 'GET',

        headers: {
          Accept: 'application/json',

          // Also provide the API key through the
          // header. This is harmless and can help
          // with debugging authentication.
          'X-Api-Key': USDA_API_KEY,

          'User-Agent':
            'PulsePlate-Alpha/0.1'
        }
      }
    );

    // ------------------------------------------------
    // Read response
    // ------------------------------------------------

    const responseText =
      await response.text();

    const contentType =
      response.headers.get(
        'content-type'
      ) || '';

    console.log(
      `USDA response status: ${response.status}`
    );

    console.log(
      `USDA response type: ${contentType}`
    );

    // ------------------------------------------------
    // USDA error handling
    // ------------------------------------------------

    if (!response.ok) {
      console.error(
        'USDA API returned an error.'
      );

      console.error(
        `Status: ${response.status}`
      );

      console.error(
        `Response: ${responseText.slice(0, 1000)}`
      );

      if (
        response.status === 401 ||
        response.status === 403
      ) {
        return res.status(502).json({
          error:
            'The USDA API rejected the API key.',
          details:
            'Check that USDA_API_KEY in .env contains your active FoodData Central API key.'
        });
      }

      if (response.status === 404) {
        return res.status(502).json({
          error:
            'The USDA FoodData Central search endpoint returned 404.',
          details:
            'The server reached the USDA service, but USDA returned a not-found response.'
        });
      }

      if (response.status === 429) {
        return res.status(502).json({
          error:
            'The USDA API rate limit was reached.',
          details:
            'Please wait before searching again.'
        });
      }

      return res.status(502).json({
        error:
          `USDA API returned HTTP ${response.status}.`,
        details:
          responseText.slice(0, 500)
      });
    }

    // ------------------------------------------------
    // Parse JSON
    // ------------------------------------------------

    let data;

    try {
      data = JSON.parse(responseText);
    } catch (error) {
      console.error(
        'USDA returned invalid JSON.'
      );

      console.error(
        responseText.slice(0, 1000)
      );

      return res.status(502).json({
        error:
          'USDA returned an invalid response.',
        details:
          'The USDA server did not return valid JSON.'
      });
    }

    // ------------------------------------------------
    // Extract foods
    // ------------------------------------------------

    const foods = Array.isArray(
      data.foods
    )
      ? data.foods.map(food => ({
          fdcId: food.fdcId,
          description: food.description,
          dataType: food.dataType,

          brandOwner:
            food.brandOwner || null,

          brandName:
            food.brandName || null,

          servingSize:
            food.servingSize || null,

          servingSizeUnit:
            food.servingSizeUnit || null,

          householdServingFullText:
            food.householdServingFullText ||
            null,

          foodNutrients:
            Array.isArray(
              food.foodNutrients
            )
              ? food.foodNutrients
              : []
        }))
      : [];

    console.log(
      `USDA returned ${foods.length} foods for "${query}".`
    );

    // ------------------------------------------------
    // Send results to frontend
    // ------------------------------------------------

    return res.json({
      foods,
      totalHits:
        Number(data.totalHits) || 0
    });

  } catch (error) {
    console.error(
      'USDA request failed completely:'
    );

    console.error(error);

    return res.status(502).json({
      error:
        'Unable to reach the USDA food database.',
      details:
        error instanceof Error
          ? error.message
          : String(error)
    });
  }
});

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    server: 'PulsePlate Alpha',

    usdaApiKeyConfigured:
      Boolean(USDA_API_KEY),

    supabaseConfigured:
      Boolean(
        SUPABASE_URL &&
        SUPABASE_PUBLISHABLE_KEY
      )
  });
});

// --------------------------------------------------
// Frontend fallback
// --------------------------------------------------

app.use((_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      '..',
      'public',
      'auth.html'
    )
  );
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(
  port,
  () => {
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '       PulsePlate Alpha Server'
    );
    console.log(
      '========================================'
    );

    console.log(
      `Server: http://localhost:${port}`
    );

    console.log(
      `USDA API key: ${
        USDA_API_KEY
          ? 'CONFIGURED'
          : 'MISSING'
      }`
    );

    console.log(
      `Supabase: ${
        SUPABASE_URL &&
        SUPABASE_PUBLISHABLE_KEY
          ? 'CONFIGURED'
          : 'MISSING'
      }`
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);