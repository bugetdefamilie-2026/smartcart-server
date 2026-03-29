// ============================================================
//  SmartCart – LIDL Price Proxy Server
//  Fetches the daily LIDL .xlsb file, parses it, caches 4 hrs
// ============================================================

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const XLSX    = require('xlsx');

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow your HTML prototype (or any origin) to call this server
app.use(cors());

// ── Cache ────────────────────────────────────────────────────
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
let cachedProducts  = null;
let cacheTimestamp  = null;

const LIDL_FILE_URL =
  'https://www.lidl.ro/explore/assets-test/webPriceData/ro/preturiZilniceLidl.xlsb';

// ── Download + parse the .xlsb file ─────────────────────────
async function fetchLidlProducts() {
  console.log('[LIDL] Downloading price file…');

  const response = await fetch(LIDL_FILE_URL, {
    headers: {
      // Mimic a real browser so the server doesn't block us
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://www.lidl.ro/',
    },
  });

  if (!response.ok) {
    throw new Error(`LIDL returned HTTP ${response.status}`);
  }

  // Read the whole file into memory as a Buffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer      = Buffer.from(arrayBuffer);

  console.log(`[LIDL] File downloaded (${(buffer.length / 1024).toFixed(0)} KB). Parsing…`);

  // Parse with SheetJS – works with .xlsb, .xlsx, .xls
  const workbook  = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];          // take the first sheet
  const sheet     = workbook.Sheets[sheetName];

  // Convert to an array of plain objects (row = object, key = column header)
  // defval: '' means empty cells become empty string instead of undefined
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  console.log(`[LIDL] Parsed ${rows.length} rows. Inspecting first row…`);
  if (rows.length > 0) console.log('[LIDL] Columns found:', Object.keys(rows[0]));

  // ── Normalise rows ──────────────────────────────────────────
  // We don't know the exact column names until we see the file live.
  // The logic below tries several common Romanian / English header names.
  // Adjust if the actual file uses different names.
  const products = rows
    .map((row, i) => {
      // Helper: case-insensitive column finder
      const get = (...candidates) => {
        for (const key of Object.keys(row)) {
          const k = key.toLowerCase().replace(/\s+/g, '');
          for (const c of candidates) {
            if (k.includes(c.toLowerCase())) return row[key];
          }
        }
        return '';
      };

      const name     = get('denumire', 'name', 'produs', 'articol', 'description') || `Produs #${i + 1}`;
      const price    = parseFloat(String(get('pret', 'price', 'valoare', 'tarif')).replace(',', '.')) || 0;
      // 'Gramaj' is column B in the LIDL file — the weight/volume string e.g. "500 g", "1 l"
      const gramaj   = String(get('gramaj', 'greutate', 'cantitate', 'unitate', 'unit', 'um') || '').trim();
      const category = get('categorie', 'category', 'grupa', 'departament') || '';
      const barcode  = get('cod', 'ean', 'barcode', 'codbare') || '';

      return { id: i + 1, name, price, gramaj, category, barcode };
    })
    .filter(p => p.name && p.price > 0);    // remove rows with no name or zero price

  console.log(`[LIDL] ${products.length} valid products ready.`);
  return products;
}

// ── Cache manager ─────────────────────────────────────────────
async function getProducts() {
  const now = Date.now();
  if (cachedProducts && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION_MS) {
    console.log('[Cache] Serving from cache.');
    return cachedProducts;
  }
  cachedProducts  = await fetchLidlProducts();
  cacheTimestamp  = now;
  return cachedProducts;
}

// ── Routes ────────────────────────────────────────────────────

// GET /api/health  – quick check that the server is alive
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    cachedProducts: cachedProducts ? cachedProducts.length : 0,
    cacheAge: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) + ' min' : 'no cache',
    nextRefresh: cacheTimestamp
      ? new Date(cacheTimestamp + CACHE_DURATION_MS).toISOString()
      : 'on first request',
  });
});

// GET /api/search?q=pui&limit=20
// Returns products whose name contains the search term (case-insensitive, diacritics-tolerant)
app.get('/api/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    if (!query) return res.json({ results: [], query, total: 0 });

    const products = await getProducts();

    // Simple diacritics normaliser so "pui" also matches "Pui" or "PUI"
    const normalize = s => s.toLowerCase()
      .replace(/ă/g,'a').replace(/â/g,'a').replace(/î/g,'i')
      .replace(/ș/g,'s').replace(/ş/g,'s')
      .replace(/ț/g,'t').replace(/ţ/g,'t');

    const nq = normalize(query);

    const results = products
      .filter(p => normalize(p.name).includes(nq))
      .slice(0, limit)
      .map(p => ({
        ...p,
        store: 'LIDL',
        storeColor: '#FFD700',
        priceLabel: p.price.toFixed(2).replace('.', ',') + ' lei',
      }));

    res.json({ results, query, total: results.length });
  } catch (err) {
    console.error('[/api/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/offers?limit=10
// Returns the N cheapest products (or you can later add discount info here)
app.get('/api/offers', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const products = await getProducts();

    // Sort by price ascending and take the first N as "deals"
    // You can later enrich this with actual promotional data
    const offers = [...products]
      .sort((a, b) => a.price - b.price)
      .slice(0, limit)
      .map(p => ({
        ...p,
        store: 'LIDL',
        priceLabel: p.price.toFixed(2).replace('.', ',') + ' lei',
      }));

    res.json({ offers, total: offers.length, source: 'LIDL', cachedAt: new Date(cacheTimestamp).toISOString() });
  } catch (err) {
    console.error('[/api/offers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/refresh  – force a cache refresh (useful for testing)
app.get('/api/refresh', async (req, res) => {
  try {
    cacheTimestamp = null;   // invalidate cache
    const products = await getProducts();
    res.json({ ok: true, count: products.length, refreshedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  SmartCart LIDL Proxy running on port ${PORT}`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/search?q=pui`);
  console.log(`   GET /api/offers?limit=10`);
  console.log(`   GET /api/refresh\n`);

  // Pre-warm the cache on startup so the first user request is instant
  getProducts().catch(err => console.error('[Startup cache warm-up failed]', err.message));
});
