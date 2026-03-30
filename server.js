// ============================================================
//  SmartCart – LIDL + Auchan Proxy Server  v1.1.0
//  LIDL  : daily .xlsb file, cached 4h
//  Auchan: live search — tries 4 strategies in order
//         1. SAP/OCC REST API (most common for Auchan EU)
//         2. Algolia search (fallback — many RO e-comm sites)
//         3. Next.js _next/data JSON
//         4. __NEXT_DATA__ embedded in HTML
// ============================================================

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const XLSX    = require('xlsx');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// ═══════════════════════════════════════════════════════════
//  Browser-like headers — rotate UA to avoid blocks
// ═══════════════════════════════════════════════════════════
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];
function randomUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }

function browserHeaders(extra = {}) {
  return {
    'User-Agent'     : randomUA(),
    'Accept-Language': 'ro-RO,ro;q=0.9,en-GB;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Cache-Control'  : 'no-cache',
    'Pragma'         : 'no-cache',
    ...extra,
  };
}

function jsonHeaders(extra = {}) {
  return {
    ...browserHeaders(),
    'Accept' : 'application/json, text/plain, */*',
    'Referer': 'https://www.auchan.ro/',
    'Origin' : 'https://www.auchan.ro',
    ...extra,
  };
}

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
    headers: { ...browserHeaders(), 'Referer': 'https://www.lidl.ro/' },
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
      for (const c of candidates) {
        if (row[c] !== undefined && row[c] !== '') return row[c];
      }
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
//  AUCHAN — session-aware search
//  We first fetch the homepage to get a real session cookie,
//  then use that cookie in all subsequent API calls.
// ═══════════════════════════════════════════════════════════

// Simple in-memory session cache (refreshed every 30 min)
let auchanSession = null;          // { cookies: String, buildId: String|null, timestamp: Number }
const SESSION_TTL = 30 * 60 * 1000;

async function getAuchanSession() {
  if (auchanSession && (Date.now() - auchanSession.timestamp) < SESSION_TTL) {
    return auchanSession;
  }

  console.log('[Auchan] Fetching fresh session…');
  try {
    const res = await fetch('https://www.auchan.ro/', {
      headers: browserHeaders({ 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
    });

    // Collect Set-Cookie headers
    const rawCookies = res.headers.raw?.()?.['set-cookie'] || [];
    const cookies = rawCookies
      .map(c => c.split(';')[0])
      .join('; ');

    const html = await res.text();

    // Extract Next.js buildId if present
    const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    const buildId = buildIdMatch ? buildIdMatch[1] : null;

    // Try to find Algolia credentials embedded in the page
    const algoliaAppMatch  = html.match(/"applicationId"\s*:\s*"([^"]+)"/);
    const algoliaKeyMatch  = html.match(/"searchApiKey"\s*:\s*"([^"]+)"/);
    const algoliaApp  = algoliaAppMatch  ? algoliaAppMatch[1]  : null;
    const algoliaKey  = algoliaKeyMatch  ? algoliaKeyMatch[1]  : null;

    // Also try alternative Algolia key names
    const algoliaAppMatch2 = html.match(/ALGOLIA_APP_ID['":\s]+["']([A-Z0-9]{8,})['"]/i);
    const algoliaKeyMatch2 = html.match(/ALGOLIA_SEARCH_KEY['":\s]+["']([a-z0-9]{20,})['"]/i);
    const algoliaApp2 = algoliaApp  || (algoliaAppMatch2 ? algoliaAppMatch2[1] : null);
    const algoliaKey2 = algoliaKey  || (algoliaKeyMatch2 ? algoliaKeyMatch2[1] : null);

    auchanSession = {
      cookies,
      buildId,
      algoliaApp: algoliaApp2,
      algoliaKey: algoliaKey2,
      timestamp: Date.now(),
    };

    console.log(`[Auchan] Session ready. buildId=${buildId} algoliaApp=${algoliaApp2} cookies=${cookies.length > 0 ? 'yes' : 'none'}`);
    return auchanSession;
  } catch (e) {
    console.log('[Auchan] Session fetch failed:', e.message);
    return { cookies: '', buildId: null, algoliaApp: null, algoliaKey: null, timestamp: Date.now() };
  }
}

// ─────────────────────────────────────────────────────────
//  Normalize a raw Auchan hit into our standard shape
// ─────────────────────────────────────────────────────────
function normalizeAuchanHit(h) {
  if (!h) return null;
  const name  = h.name || h.title || h.label || h.productName || h.nom || '';
  const price = parseFloat(
    h.price ?? h.salePrice ?? h.currentPrice ?? h.priceValue ??
    h.discountedPrice ?? h.priceInformation?.formattedValue?.replace(/[^\d,.]/g, '').replace(',', '.') ?? 0
  );
  const gramaj = String(h.weight ?? h.quantity ?? h.gramaj ?? h.unitOfMeasure ?? h.packaging ?? '').trim();
  const category = h.categories?.[0]?.name || h.categoryName || h.category || '';

  if (!name || price <= 0) return null;
  return {
    name,
    price,
    gramaj,
    category,
    store     : 'Auchan',
    priceLabel: price.toFixed(2).replace('.', ',') + ' lei',
  };
}

// ─────────────────────────────────────────────────────────
//  Strategy 1 — SAP OCC / Hybris REST API
//  Many Auchan EU stores run on SAP Commerce
// ─────────────────────────────────────────────────────────
async function tryAuchanSAP(query, limit, session) {
  const enc = encodeURIComponent(query);
  const sapUrls = [
    `https://www.auchan.ro/api/v2/ro/products/search?query=${enc}&pageSize=${limit}&currentPage=0&fields=FULL`,
    `https://www.auchan.ro/rest/v2/ro/products/search?query=${enc}&pageSize=${limit}`,
    `https://www.auchan.ro/occ/v2/auchan-ro/products/search?query=${enc}&pageSize=${limit}`,
  ];

  for (const url of sapUrls) {
    try {
      const r = await fetch(url, {
        headers: jsonHeaders(session.cookies ? { 'Cookie': session.cookies } : {}),
      });
      if (!r.ok) { console.log(`[Auchan SAP] ${url} → ${r.status}`); continue; }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) continue;
      const json = await r.json();

      const hits = json?.products || json?.results || json?.data?.products;
      if (Array.isArray(hits) && hits.length > 0) {
        console.log(`[Auchan SAP] ✅ ${hits.length} hits via ${url}`);
        const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
        if (mapped.length > 0) return mapped;
      }
    } catch (e) { console.log(`[Auchan SAP] Error: ${e.message}`); }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
//  Strategy 2 — Algolia Search API
//  If we found Algolia credentials in the page, use them directly
// ─────────────────────────────────────────────────────────
async function tryAuchanAlgolia(query, limit, session) {
  const appId = session.algoliaApp;
  const apiKey = session.algoliaKey;

  if (!appId || !apiKey) {
    console.log('[Auchan Algolia] No credentials found in session');
    return null;
  }

  console.log(`[Auchan Algolia] Trying with appId=${appId}`);
  try {
    const r = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/*/queries`, {
      method : 'POST',
      headers: {
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key'       : apiKey,
        'Content-Type'            : 'application/json',
      },
      body: JSON.stringify({
        requests: [{
          indexName: 'auchan_ro_products',  // common index name pattern
          query,
          params: `hitsPerPage=${limit}&attributesToRetrieve=name,price,gramaj,category,weight`,
        }],
      }),
    });

    if (!r.ok) { console.log(`[Auchan Algolia] HTTP ${r.status}`); return null; }
    const json = await r.json();
    const hits = json?.results?.[0]?.hits;
    if (Array.isArray(hits) && hits.length > 0) {
      console.log(`[Auchan Algolia] ✅ ${hits.length} hits`);
      const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
      if (mapped.length > 0) return mapped;
    }
  } catch (e) { console.log(`[Auchan Algolia] Error: ${e.message}`); }
  return null;
}

// ─────────────────────────────────────────────────────────
//  Strategy 3 — Next.js _next/data (SSR JSON)
// ─────────────────────────────────────────────────────────
async function tryAuchanNextData(query, limit, session) {
  if (!session.buildId) {
    console.log('[Auchan Next] No buildId in session — skipping');
    return null;
  }

  const enc = encodeURIComponent(query);
  const dataUrl = `https://www.auchan.ro/_next/data/${session.buildId}/search.json?q=${enc}`;
  console.log(`[Auchan Next] ${dataUrl}`);

  try {
    const r = await fetch(dataUrl, {
      headers: jsonHeaders(session.cookies ? { 'Cookie': session.cookies } : {}),
    });
    if (!r.ok) { console.log(`[Auchan Next] HTTP ${r.status}`); return null; }
    const data = await r.json();
    const props = data?.pageProps;
    if (props) console.log('[Auchan Next] pageProps keys:', Object.keys(props));

    const hits =
      props?.hits || props?.products ||
      props?.searchResults?.hits || props?.data?.hits ||
      props?.initialData?.hits   || props?.serverState?.initialResults?.['']?.hits;

    if (Array.isArray(hits) && hits.length > 0) {
      console.log(`[Auchan Next] ✅ ${hits.length} hits`);
      const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
      if (mapped.length > 0) return mapped;
    }
  } catch (e) { console.log(`[Auchan Next] Error: ${e.message}`); }
  return null;
}

// ─────────────────────────────────────────────────────────
//  Strategy 4 — Fetch search page with session cookies + parse __NEXT_DATA__
// ─────────────────────────────────────────────────────────
async function tryAuchanHTMLWithSession(query, limit, session) {
  const enc = encodeURIComponent(query);
  console.log(`[Auchan HTML] Fetching search page with session cookie…`);

  try {
    const r = await fetch(`https://www.auchan.ro/search?q=${enc}`, {
      headers: {
        ...browserHeaders({ 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }),
        ...(session.cookies ? { 'Cookie': session.cookies } : {}),
      },
    });

    const html = await r.text();

    // Update buildId from fresh page if changed
    const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (buildIdMatch && buildIdMatch[1] !== session.buildId) {
      console.log(`[Auchan HTML] buildId updated: ${buildIdMatch[1]}`);
      session.buildId = buildIdMatch[1];
    }

    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!nextMatch) { console.log('[Auchan HTML] No __NEXT_DATA__ found'); return null; }

    const pageData = JSON.parse(nextMatch[1]);
    const props = pageData?.props?.pageProps;
    if (props) console.log('[Auchan HTML] __NEXT_DATA__ pageProps keys:', Object.keys(props));

    const hits =
      props?.hits || props?.products ||
      props?.searchResults?.hits || props?.data?.hits ||
      props?.serverState?.initialResults?.['']?.hits;

    if (Array.isArray(hits) && hits.length > 0) {
      console.log(`[Auchan HTML] ✅ ${hits.length} hits`);
      const mapped = hits.slice(0, limit).map(normalizeAuchanHit).filter(Boolean);
      if (mapped.length > 0) return mapped;
    }

    // Also log raw props for debugging
    console.log('[Auchan HTML] Raw pageProps (first 500 chars):', JSON.stringify(props || {}).slice(0, 500));
  } catch (e) { console.log(`[Auchan HTML] Error: ${e.message}`); }
  return null;
}

// ─────────────────────────────────────────────────────────
//  Main Auchan search — runs all strategies in order
// ─────────────────────────────────────────────────────────
async function searchAuchan(query, limit = 10) {
  console.log(`\n[Auchan] ═══ Searching: "${query}" ═══`);
  const session = await getAuchanSession();

  let results;

  results = await tryAuchanSAP(query, limit, session);
  if (results) return results;

  results = await tryAuchanAlgolia(query, limit, session);
  if (results) return results;

  results = await tryAuchanNextData(query, limit, session);
  if (results) return results;

  results = await tryAuchanHTMLWithSession(query, limit, session);
  if (results) return results;

  console.log('[Auchan] ⚠️ All strategies failed — returning empty');
  return [];
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
    auchanSession: auchanSession ? {
      hasCookies: !!auchanSession.cookies,
      buildId: auchanSession.buildId,
      algoliaApp: auchanSession.algoliaApp,
      ageMin: Math.round((Date.now() - auchanSession.timestamp) / 60000),
    } : null,
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
    auchanSession  = null;   // also reset Auchan session
    const products = await getLidlProducts();
    res.json({ ok: true, count: products.length, refreshedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: test Auchan session info
app.get('/api/auchan-debug', async (req, res) => {
  const session = await getAuchanSession();
  res.json({
    cookies   : session.cookies ? session.cookies.slice(0, 200) + '…' : 'none',
    buildId   : session.buildId,
    algoliaApp: session.algoliaApp,
    algoliaKey: session.algoliaKey ? session.algoliaKey.slice(0, 10) + '…' : 'none',
    ageMin    : Math.round((Date.now() - session.timestamp) / 60000),
  });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  SmartCart v1.1.0 (LIDL + Auchan) running on port ${PORT}`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/search?q=pui           ← LIDL (cache)`);
  console.log(`   GET /api/auchan-search?q=pui    ← Auchan (live, 4 strategies)`);
  console.log(`   GET /api/auchan-debug           ← inspect session`);
  console.log(`   GET /api/offers?limit=10`);
  console.log(`   GET /api/refresh\n`);

  // Warm up both caches at startup
  getLidlProducts().catch(err => console.error('[Startup LIDL warm-up]', err.message));
  getAuchanSession().catch(err => console.error('[Startup Auchan session]', err.message));
});
