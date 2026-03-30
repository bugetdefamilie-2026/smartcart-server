// ============================================================
//  INSTRUCȚIUNI: Ce trebuie adăugat în server.js
//  Copiază fiecare bloc la locul indicat.
// ============================================================


// ── BLOC 1: la începutul fișierului server.js ───────────────
//    Pune aceste linii imediat după celelalte linii require()
//    (adică după: const XLSX = require('xlsx');  )
//    ──────────────────────────────────────────────────────────

const { getKauflandProducts, debugCatalogPage, searchKauflandProducts } = require('./kaufland');

// Cache Kaufland — reîmprospătăm la fiecare 6 ore
// (catalogul săptămânal nu se schimbă mai des de atât)
let kauflandCache          = null;
let kauflandCacheTimestamp = null;
const KAUFLAND_CACHE_MS    = 6 * 60 * 60 * 1000;   // 6 ore în milisecunde

async function getKauflandCached() {
  const cacheValid = kauflandCache &&
                     kauflandCacheTimestamp &&
                     (Date.now() - kauflandCacheTimestamp) < KAUFLAND_CACHE_MS;
  if (cacheValid) {
    console.log('[Kaufland] Serving from cache.');
    return kauflandCache;
  }
  console.log('[Kaufland] Cache expired or empty — fetching fresh data…');
  kauflandCache          = await getKauflandProducts();
  kauflandCacheTimestamp = Date.now();
  return kauflandCache;
}


// ── BLOC 2: rute noi — pune-le înainte de app.listen() ─────
//    Imediat după ultimul app.get('/api/refresh', ...) bloc
//    ──────────────────────────────────────────────────────────

// ── Diagnostic: ce am găsit pe pagina Kaufland ───────────────
// Apelează PRIMUL pentru a vedea dacă găsim PDF-uri
// GET http://localhost:3000/api/kaufland-debug
app.get('/api/kaufland-debug', async (req, res) => {
  try {
    const info = await debugCatalogPage();
    res.json({
      message : 'Informații de diagnostic Kaufland',
      ...info,
      hint: info.pdfUrls.length === 0
        ? '⚠ Niciun PDF găsit. Dacă htmlLength < 5000 pagina e JS-rendered și avem nevoie de Puppeteer.'
        : `✅ Am găsit ${info.pdfUrls.length} PDF(uri). Apelează /api/kaufland-offers pentru a extrage produsele.`,
    });
  } catch (err) {
    console.error('[/api/kaufland-debug]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Kaufland: oferte pentru dashboard ────────────────────────
// GET http://localhost:3000/api/kaufland-offers
// GET http://localhost:3000/api/kaufland-offers?limit=50
app.get('/api/kaufland-offers', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 20, 200);
    const result = await getKauflandCached();

    res.json({
      offers    : result.products.slice(0, limit),
      total     : result.products.length,
      source    : 'Kaufland',
      warning   : result.warning || null,
      pdfUrl    : result.pdfUrl  || null,
      cachedAt  : kauflandCacheTimestamp ? new Date(kauflandCacheTimestamp).toISOString() : null,
    });
  } catch (err) {
    console.error('[/api/kaufland-offers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Kaufland: căutare produs ──────────────────────────────────
// GET http://localhost:3000/api/kaufland-search?q=piept+pui
// GET http://localhost:3000/api/kaufland-search?q=lapte&limit=10
app.get('/api/kaufland-search', async (req, res) => {
  try {
    const query  = (req.query.q || '').trim();
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await getKauflandCached();

    const filtered = searchKauflandProducts(query, result.products).slice(0, limit);

    res.json({
      results : filtered,
      query,
      total   : filtered.length,
      source  : 'Kaufland',
      warning : result.warning || null,
    });
  } catch (err) {
    console.error('[/api/kaufland-search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Kaufland: forțează reîmprospătarea cache-ului ────────────
// GET http://localhost:3000/api/kaufland-refresh
app.get('/api/kaufland-refresh', async (req, res) => {
  try {
    kauflandCacheTimestamp = null;   // invalidează cache-ul
    const result = await getKauflandCached();
    res.json({
      ok          : true,
      productsFound: result.products.length,
      warning     : result.warning || null,
      refreshedAt : new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
