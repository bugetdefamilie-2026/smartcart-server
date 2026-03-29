// ============================================================
//  SmartCart – LIDL + Auchan Proxy Server
//  LIDL: daily .xlsb file, cached 4h
//  Auchan: live search scrape on every query
// ============================================================

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const XLSX    = require('xlsx');

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
    // ── Exact column names confirmed from live LIDL file ──────
    // "Denumire comerciala", "Gramaj", "Categorie", "Pret vanzare"
    // We still fall back to fuzzy search in case LIDL renames them
    const get = (...candidates) => {
      // Try exact match first (fastest)
      for (const c of candidates) {
        if (row[c] !== undefined && row[c] !== '') return row[c];
      }
      // Fallback: fuzzy substring match on lowercased key
      for (const key of Object.keys(row)) {
        const k = key.toLowerCase().replace(/\s+/g, '');
        for (const c of candidates) {
          if (k.includes(c.toLowerCase().replace(/\s+/g, ''))) return row[key];
        }
      }
      return '';
    };

    const rawName = String(
      get('Denumire comerciala', 'denumire', 'name', 'produs', 'articol', 'description') || `Produs #${i + 1}`
    );
    const name = rawName.replace(/^\s*-\s*BUC_\s*/i, '').replace(/^\s*-\s+/, '').trim();

    const price = parseFloat(
      String(get('Pret vanzare', 'pret', 'price', 'valoare', 'tarif')).replace(',', '.')
    ) || 0;

    const rawG   = String(get('Gramaj', 'gramaj', 'greutate', 'weight', 'volum') || '').trim();
    const gramaj = /^per\s*kg$/i.test(rawG) ? '1 kg' : rawG;

    const category = get('Categorie', 'categorie', 'category', 'grupa', 'departament') || '';

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
// ═══════════════════════════════════════════════════════════
//  AUCHAN — direct internal API (no HTML scraping)
//  Auchan.ro is a React SPA — cheerio only gets the shell.
//  We call their backend JSON endpoints directly instead.
// ═══════════════════════════════════════════════════════════
async function searchAuchan(query, limit = 10) {
  const enc = encodeURIComponent(query);
  console.log(`[Auchan] Searching for: "${query}"`);

  // ── Strategy A: Auchan internal REST search API ────────────
  // This is the XHR endpoint the browser calls after the page loads
  const apiUrls = [
    `https://www.auchan.ro/api/2.0/page/search?search=${enc}&size=${limit}&currentPage=0`,
    `https://api.auchan.ro/api/search?q=${enc}&limit=${limit}`,
    `https://www.auchan.ro/search-api/v1/search?q=${enc}&hitsPerPage=${limit}`,
  ];

  for (const url of apiUrls) {
    try {
      console.log(`[Auchan] Trying API: ${url}`);
      const r = await fetch(url, {
        headers: {
          ...BROWSER_HEADERS,
          'Accept'  : 'application/json, text/plain, */*',
          'Referer' : 'https://www.auchan.ro/',
          'Origin'  : 'https://www.auchan.ro',
        },
        timeout: 8000,
      });
      if (!r.ok) { console.log(`[Auchan] ${url} → HTTP ${r.status}`); continue; }
      const contentType = r.headers.get('content-type') || '';
      if (!contentType.includes('json')) { console.log(`[Auchan] ${url} → not JSON (${contentType})`); continue; }

      const json = await r.json();
      console.log(`[Auchan] API success at ${url}`);

      // Walk common response shapes
      const hits =
        json?.products || json?.hits || json?.results ||
        json?.data?.products || json?.data?.hits ||
        json?.response?.products || json?.searchResult?.products;

      if (Array.isArray(hits) && hits.length > 0) {
        console.log(`[Auchan] Found ${hits.length} products via API`);
        const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
        if (mapped.length > 0) {
          console.log('[Auchan] Sample:', JSON.stringify(mapped[0]));
          return mapped;
        }
      }
    } catch (e) {
      console.log(`[Auchan] API error at ${url}:`, e.message);
    }
  }

  // ── Strategy B: _next/data JSON (Next.js SSR data endpoint) ─
  // Next.js pre-renders page data at /_next/data/{buildId}/search.json
  // We first fetch the page to grab the buildId, then call the data endpoint
  try {
    console.log('[Auchan] Strategy B: Next.js _next/data');
    const pageRes = await fetch(`https://www.auchan.ro/search?q=${enc}`, {
      headers: { ...BROWSER_HEADERS, 'Referer': 'https://www.auchan.ro/' },
      timeout: 10000,
    });
    const html = await pageRes.text();

    // Extract buildId from _next/static/{buildId}/ path in the HTML
    const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (buildIdMatch) {
      const buildId = buildIdMatch[1];
      const dataUrl = `https://www.auchan.ro/_next/data/${buildId}/search.json?q=${enc}`;
      console.log(`[Auchan] Trying _next/data: ${dataUrl}`);

      const dataRes = await fetch(dataUrl, {
        headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' },
        timeout: 8000,
      });
      if (dataRes.ok) {
        const data = await dataRes.json();
        // Walk Next.js pageProps for product arrays
        const pageProps = data?.pageProps;
        const hits =
          pageProps?.hits || pageProps?.products ||
          pageProps?.searchResults?.hits || pageProps?.data?.hits ||
          pageProps?.initialData?.hits || pageProps?.serverState?.initialResults?.['']?.hits;

        if (Array.isArray(hits) && hits.length > 0) {
          console.log(`[Auchan] _next/data: found ${hits.length} products`);
          const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
          if (mapped.length > 0) {
            console.log('[Auchan] Sample:', JSON.stringify(mapped[0]));
            return mapped;
          }
        }

        // Also log the pageProps keys so we can debug
        if (pageProps) {
          console.log('[Auchan] _next/data pageProps keys:', Object.keys(pageProps));
        }
      }
    }

    // ── Strategy C: parse __NEXT_DATA__ from the HTML ─────────
    console.log('[Auchan] Strategy C: __NEXT_DATA__ in HTML');
    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextMatch) {
      const pageData = JSON.parse(nextMatch[1]);
      const props = pageData?.props?.pageProps;
      if (props) console.log('[Auchan] __NEXT_DATA__ pageProps keys:', Object.keys(props));

      const hits =
        props?.hits || props?.products ||
        props?.searchResults?.hits || props?.data?.hits ||
        props?.serverState?.initialResults?.['']?.hits;

      if (Array.isArray(hits) && hits.length > 0) {
        console.log(`[Auchan] __NEXT_DATA__: found ${hits.length} products`);
        const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
        if (mapped.length > 0) {
          console.log('[Auchan] Sample:', JSON.stringify(mapped[0]));
          return mapped;
        }
      }
    }
  } catch (e) {
    console.log('[Auchan] Strategy B/C error:', e.message);
  }

  console.log('[Auchan] All strategies failed — returning empty');
  return [];
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
