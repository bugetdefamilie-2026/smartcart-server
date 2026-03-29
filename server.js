// ============================================================
//  SmartCart – LIDL + Auchan Proxy Server
//  LIDL: daily .xlsb file, cached 4h
//  Auchan: live search scrape on every query
// ============================================================

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const XLSX    = require('xlsx');
const cheerio = require('cheerio');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ═══════════════════════════════════════════════════════════
//  SHARED: browser-like headers to avoid bot detection
// ═══════════════════════════════════════════════════════════
const BROWSER_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
};

// ═══════════════════════════════════════════════════════════
//  SHARED: diacritics normaliser
// ═══════════════════════════════════════════════════════════
const normalize = s => (s || '').toLowerCase()
  .replace(/ă/g,'a').replace(/â/g,'a').replace(/î/g,'i')
  .replace(/ș/g,'s').replace(/ş/g,'s')
  .replace(/ț/g,'t').replace(/ţ/g,'t');

// ═══════════════════════════════════════════════════════════
//  LIDL — daily .xlsb file, cached 4 hours
// ═══════════════════════════════════════════════════════════
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000;
const LIDL_FILE_URL     = 'https://www.lidl.ro/explore/assets-test/webPriceData/ro/preturiZilniceLidl.xlsb';
let cachedProducts  = null;
let cacheTimestamp  = null;

async function fetchLidlProducts() {
  console.log('[LIDL] Downloading price file…');
  const response = await fetch(LIDL_FILE_URL, {
    headers: { ...BROWSER_HEADERS, 'Referer': 'https://www.lidl.ro/' },
  });
  if (!response.ok) throw new Error(`LIDL HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[LIDL] Downloaded ${(buffer.length / 1024).toFixed(0)} KB. Parsing…`);

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const rows     = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });

  console.log(`[LIDL] ${rows.length} rows. Columns: ${rows.length ? Object.keys(rows[0]).join(', ') : 'none'}`);
  if (rows.length) console.log('[LIDL] Sample row:', JSON.stringify(rows[0]));

  const products = rows.map((row, i) => {
    const get = (...candidates) => {
      for (const key of Object.keys(row)) {
        const k = key.toLowerCase().replace(/\s+/g, '');
        for (const c of candidates) { if (k.includes(c.toLowerCase())) return row[key]; }
      }
      return '';
    };

    const rawName = String(get('denumire', 'name', 'produs', 'articol', 'description') || `Produs #${i + 1}`);
    const name    = rawName.replace(/^\s*-\s*BUC_\s*/i, '').replace(/^\s*-\s+/, '').trim();
    const price   = parseFloat(String(get('pret', 'price', 'valoare', 'tarif')).replace(',', '.')) || 0;
    const rawG    = String(get('gramaj', 'greutate', 'weight', 'volum') || '').trim();
    const gramaj  = /^per\s*kg$/i.test(rawG) ? '1 kg' : rawG;
    const category = get('categorie', 'category', 'grupa', 'departament') || '';

    return { id: i + 1, name, price, gramaj, category };
  }).filter(p => p.name && p.price > 0);

  console.log(`[LIDL] ${products.length} valid products ready.`);
  return products;
}

async function getLidlProducts() {
  if (cachedProducts && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_DURATION_MS) {
    return cachedProducts;
  }
  cachedProducts = await fetchLidlProducts();
  cacheTimestamp = Date.now();
  return cachedProducts;
}

function lidlPriceLabel(price) {
  return price.toFixed(2).replace('.', ',') + ' lei';
}

// ═══════════════════════════════════════════════════════════
//  AUCHAN — live search scrape
//  Strategy A: extract embedded __NEXT_DATA__ JSON
//  Strategy B: parse HTML product cards with cheerio
// ═══════════════════════════════════════════════════════════
async function searchAuchan(query, limit = 15) {
  const url = `https://www.auchan.ro/search?q=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
  console.log(`[Auchan] Searching: ${url}`);

  const response = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      'Referer'       : 'https://www.auchan.ro/',
      'Cache-Control' : 'no-cache',
    },
    timeout: 10000,
  });

  if (!response.ok) throw new Error(`Auchan HTTP ${response.status}`);
  const html = await response.text();

  // ── Strategy A: Next.js embedded JSON ─────────────────────
  const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      // Walk common Next.js page-props paths where product lists live
      const hits =
        data?.props?.pageProps?.hits ||
        data?.props?.pageProps?.searchResults?.hits ||
        data?.props?.pageProps?.products ||
        data?.props?.pageProps?.data?.hits ||
        data?.props?.pageProps?.initialData?.hits;

      if (Array.isArray(hits) && hits.length > 0) {
        console.log(`[Auchan] Strategy A: found ${hits.length} hits in __NEXT_DATA__`);
        return hits.slice(0, limit).map(h => normalizeAuchanHit(h)).filter(Boolean);
      }
    } catch (e) {
      console.log('[Auchan] Strategy A parse failed:', e.message);
    }
  }

  // ── Strategy B: look for Algolia/API response embedded as JSON ────
  // Auchan often embeds search results in a window.__STATE__ or similar var
  const stateMatch = html.match(/window\.__(?:STATE|INITIAL_STATE|DATA)__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1]);
      const hits  = findDeepArray(state, 'hits') || findDeepArray(state, 'products');
      if (hits && hits.length > 0) {
        console.log(`[Auchan] Strategy B: found ${hits.length} products in window state`);
        return hits.slice(0, limit).map(h => normalizeAuchanHit(h)).filter(Boolean);
      }
    } catch (e) {
      console.log('[Auchan] Strategy B parse failed:', e.message);
    }
  }

  // ── Strategy C: cheerio HTML parsing ──────────────────────
  console.log('[Auchan] Strategy C: parsing HTML with cheerio');
  const $ = cheerio.load(html);
  const results = [];

  // Try multiple selector patterns — Auchan may use different class names
  const cardSelectors = [
    '[data-testid="product-card"]',
    '[class*="ProductCard"]',
    '[class*="product-card"]',
    '[class*="product-tile"]',
    '[class*="ProductTile"]',
    '.product-item',
    'article[class*="product"]',
    'li[class*="product"]',
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    cards = $(sel);
    if (cards.length > 0) {
      console.log(`[Auchan] Found ${cards.length} cards with selector: ${sel}`);
      break;
    }
  }

  if (cards.length === 0) {
    console.log('[Auchan] No product cards found. HTML snippet:', html.substring(0, 500));
    return [];
  }

  cards.slice(0, limit).each((i, el) => {
    const card = $(el);
    const name = (
      card.find('[class*="name"], [class*="title"], h2, h3').first().text() ||
      card.find('[data-testid*="name"], [data-testid*="title"]').first().text()
    ).trim();

    // Price: look for elements with "price" in class, prefer the sale price
    let priceText = (
      card.find('[class*="price"]:not([class*="old"]):not([class*="was"]):not([class*="strike"])').first().text() ||
      card.find('[data-testid*="price"]').first().text()
    ).trim();

    // Extract numeric price from string like "12,99 lei" or "12.99"
    const priceMatch = priceText.replace(/\s/g, '').replace(',', '.').match(/([\d.]+)/);
    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

    const gramaj = (
      card.find('[class*="weight"], [class*="gramaj"], [class*="quantity"], [class*="unit"]').first().text() ||
      card.find('[data-testid*="weight"], [data-testid*="unit"]').first().text()
    ).trim();

    if (name && price > 0) {
      results.push({
        name,
        price,
        gramaj : gramaj || '',
        store  : 'Auchan',
        priceLabel: price.toFixed(2).replace('.', ',') + ' lei',
      });
    }
  });

  console.log(`[Auchan] Strategy C extracted ${results.length} products`);
  return results;
}

// Normalize a raw Auchan API/Next.js hit object into our standard shape
function normalizeAuchanHit(h) {
  if (!h) return null;
  // Different Auchan API versions use different field names
  const name  = h.name || h.title || h.label || h.productName || '';
  const price = parseFloat(h.price || h.salePrice || h.currentPrice || h.priceValue || 0);
  const gramaj = h.weight || h.quantity || h.gramaj || h.unitOfMeasure || h.packaging || '';

  if (!name || price <= 0) return null;
  return {
    name,
    price,
    gramaj : String(gramaj).trim(),
    store  : 'Auchan',
    priceLabel: price.toFixed(2).replace('.', ',') + ' lei',
  };
}

// Recursively search an object for a key that holds an array of plausible products
function findDeepArray(obj, key, depth = 0) {
  if (depth > 6 || typeof obj !== 'object' || obj === null) return null;
  if (Array.isArray(obj[key]) && obj[key].length > 0 && obj[key][0]?.name) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findDeepArray(obj[k], key, depth + 1);
    if (found) return found;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    cachedProducts: cachedProducts ? cachedProducts.length : 0,
    cacheAge: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 60000) + ' min' : 'no cache',
    nextRefresh: cacheTimestamp ? new Date(cacheTimestamp + CACHE_DURATION_MS).toISOString() : 'on first request',
  });
});

// LIDL search
app.get('/api/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    if (!query) return res.json({ results: [], query, total: 0 });

    const products = await getLidlProducts();
    const nq = normalize(query);
    const results = products
      .filter(p => normalize(p.name).includes(nq))
      .slice(0, limit)
      .map(p => ({ ...p, store: 'LIDL', priceLabel: lidlPriceLabel(p.price) }));

    res.json({ results, query, total: results.length });
  } catch (err) {
    console.error('[/api/search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auchan live search
app.get('/api/auchan-search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    if (!query) return res.json({ results: [], query, total: 0 });

    const results = await searchAuchan(query, limit);
    res.json({ results, query, total: results.length, store: 'Auchan' });
  } catch (err) {
    console.error('[/api/auchan-search]', err.message);
    // Return empty results (not 500) so the frontend still shows LIDL data
    res.json({ results: [], query: req.query.q, total: 0, error: err.message });
  }
});

// LIDL offers (dashboard)
app.get('/api/offers', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 200);
    const products = await getLidlProducts();
    const offers = [...products]
      .sort((a, b) => a.price - b.price)
      .slice(0, limit)
      .map(p => ({ ...p, store: 'LIDL', priceLabel: lidlPriceLabel(p.price) }));

    res.json({ offers, total: offers.length, source: 'LIDL', cachedAt: new Date(cacheTimestamp).toISOString() });
  } catch (err) {
    console.error('[/api/offers]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Force cache refresh
app.get('/api/refresh', async (req, res) => {
  try {
    cacheTimestamp = null;
    const products = await getLidlProducts();
    res.json({ ok: true, count: products.length, refreshedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  SmartCart (LIDL + Auchan) running on port ${PORT}`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/search?q=pui          ← LIDL (cache)`);
  console.log(`   GET /api/auchan-search?q=pui   ← Auchan (live)`);
  console.log(`   GET /api/offers?limit=10`);
  console.log(`   GET /api/refresh\n`);
  getLidlProducts().catch(err => console.error('[Startup warm-up failed]', err.message));
});
