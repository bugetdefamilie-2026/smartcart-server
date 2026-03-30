// ============================================================
//  kaufland.js  —  Kaufland Romania Catalog Price Extractor
//  v1.0.0
//
//  HOW IT WORKS (in plain language):
//    Step 1 → Fetch the Kaufland catalog page (HTML)
//    Step 2 → Hunt for PDF links hidden anywhere in that HTML
//    Step 3 → Download the PDF binary
//    Step 4 → Extract the text layer with pdf-parse
//    Step 5 → Walk every line; when we see a price, grab the
//              product name from the lines above it
//
//  WHAT CAN GO WRONG:
//    A) The page is JavaScript-rendered → our fetch gets an empty
//       shell with no PDF links. The debug endpoint will tell you.
//    B) The PDF contains only images (scanned flyer) → pdf-parse
//       returns almost no text. We return a clear warning.
//
//  In both cases the module returns { products: [], warning: "..." }
//  so the server never crashes — it just reports the problem.
// ============================================================

'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const pdf     = require('pdf-parse');

// ── URLs & browser-like headers ─────────────────────────────
const CATALOG_PAGE = 'https://www.kaufland.ro/cataloage-cu-reduceri.html';
const BASE_URL     = 'https://www.kaufland.ro';

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Referer'        : 'https://www.kaufland.ro/',
};

// ── Helper: make any href absolute ──────────────────────────
function absoluteUrl(href) {
  if (!href) return '';
  href = href.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//'))      return 'https:' + href;
  if (href.startsWith('/'))       return BASE_URL + href;
  return BASE_URL + '/' + href;
}

// ── Helper: diacritics normaliser ───────────────────────────
const normalize = s => (s || '').toLowerCase()
  .replace(/[ăâ]/g, 'a').replace(/î/g, 'i')
  .replace(/[șş]/g, 's').replace(/[țţ]/g, 't');

// ============================================================
//  STEP 1  —  Discover PDF URLs on the catalog page
//
//  We search for PDFs in 6 different ways because Kaufland may
//  hide the URL in different places depending on their platform.
// ============================================================
async function discoverPdfUrls() {
  console.log('[Kaufland] Fetching catalog page:', CATALOG_PAGE);

  const res  = await fetch(CATALOG_PAGE, { headers: HEADERS, timeout: 20000 });
  const html = await res.text();
  const $    = cheerio.load(html);

  const found   = new Set();  // PDF URLs
  const viewers = [];          // embedded catalog viewer URLs (iframe, etc.)

  // ── A: standard <a href="something.pdf"> links ────────────
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (/\.pdf/i.test(h)) found.add(absoluteUrl(h));
  });

  // ── B: data-* attributes (lazy-loaded links) ──────────────
  $('[data-src],[data-href],[data-url],[data-link],[data-pdf]').each((_, el) => {
    ['data-src','data-href','data-url','data-link','data-pdf'].forEach(attr => {
      const v = $(el).attr(attr) || '';
      if (/\.pdf/i.test(v)) found.add(absoluteUrl(v));
    });
  });

  // ── C: grep the raw HTML for https://...pdf patterns ──────
  (html.match(/https?:\/\/[^\s"'<>]*\.pdf[^\s"'<>]*/gi) || [])
    .forEach(u => found.add(u));

  // ── D: JSON blobs embedded in <script> tags ───────────────
  //  Matches:  "url":"https://cdn.kaufland.ro/catalog.pdf"
  (html.match(/"(?:url|src|href|link|pdf|file)"\s*:\s*"([^"]*\.pdf[^"]*)"/gi) || [])
    .forEach(m => {
      const u = m.match(/"([^"]*\.pdf[^"]*)"/)?.[1];
      if (u) found.add(absoluteUrl(u));
    });

  // ── E: iframe / embed / object sources ────────────────────
  $('iframe, embed, object').each((_, el) => {
    const s = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data') || '';
    if (s) viewers.push(s);
  });

  // ── F: Known catalog-viewer platforms ─────────────────────
  //  If Kaufland uses Publitas, FlipHTML5, Issuu etc. we log
  //  the embed URL so you can investigate their own API later.
  [
    /publitas\.com\/[^\s"'<>]+/gi,
    /fliphtml5\.com\/[^\s"'<>]+/gi,
    /issuu\.com\/[^\s"'<>]+/gi,
    /e-katalog\.ro\/[^\s"'<>]+/gi,
    /calameo\.com\/[^\s"'<>]+/gi,
    /yumpu\.com\/[^\s"'<>]+/gi,
    /heyzine\.com\/[^\s"'<>]+/gi,
  ].forEach(re => {
    (html.match(re) || []).forEach(u =>
      viewers.push(u.startsWith('http') ? u : 'https://' + u)
    );
  });

  const pdfUrls = [...found];
  console.log(`[Kaufland] ✅ PDF links found   : ${pdfUrls.length}`, pdfUrls);
  console.log(`[Kaufland] 🖼  Viewer embeds found: ${viewers.length}`, viewers);
  console.log(`[Kaufland] 📄 Raw HTML length    : ${html.length} chars`);

  // If html is very short (<5 000 chars) the site is probably JS-rendered
  if (html.length < 5000) {
    console.warn('[Kaufland] ⚠ HTML too short — site likely requires JavaScript to render.');
  }

  return {
    pdfUrls,
    viewers : [...new Set(viewers)],
    htmlLength: html.length,
    isLikelyJsRendered: html.length < 5000,
  };
}

// ============================================================
//  STEP 2  —  Download a PDF, return a Buffer
// ============================================================
async function downloadPdf(url) {
  console.log(`[Kaufland] Downloading PDF: ${url}`);

  const res = await fetch(url, {
    headers : { ...HEADERS, Accept: 'application/pdf,*/*' },
    timeout : 90000,   // 90 s timeout — catalogs can be 20-40 MB
  });

  if (!res.ok) throw new Error(`PDF download failed: HTTP ${res.status} — ${url}`);

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[Kaufland] ✅ Downloaded: ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
  return buf;
}

// ============================================================
//  STEP 3  —  Extract text layer from the PDF buffer
//
//  pdf-parse reads the text layer that's embedded in the PDF.
//  If the catalog was made from scanned images, this layer
//  doesn't exist and we get back almost no text.
// ============================================================
async function extractText(buf) {
  try {
    const data = await pdf(buf);
    console.log(`[Kaufland] PDF pages: ${data.numpages} | chars extracted: ${data.text.length}`);

    if (data.text.length < 200) {
      console.warn('[Kaufland] ⚠ Very little text extracted.');
      console.warn('[Kaufland] ⚠ The catalog is probably image-based (scanned flyer).');
      console.warn('[Kaufland] ⚠ OCR would be needed to read it.');
    }

    return data.text;
  } catch (e) {
    console.error('[Kaufland] pdf-parse error:', e.message);
    return '';
  }
}

// ============================================================
//  STEP 4  —  Parse product names + prices from raw text
//
//  Romanian price formats we look for:
//    "9,99 lei"   "12.49 lei"   "24,99 lei/kg"   "3,49/buc"
//
//  Strategy:
//    • Split text into lines
//    • When a line contains a price → mark it as a price line
//    • Look up ≤4 lines above for the nearest non-price,
//      non-date, non-junk line → that is the product name
// ============================================================

// Matches Romanian price patterns like: 9,99 or 12.49 lei or /kg
const PRICE_RE = /(\d{1,4}[,\.]\d{2})\s*(lei|ron|\/kg|\/buc|\/l|\/pcs|\/100g|\/100ml)?/i;

// Lines that are NOT product names (skip them)
const SKIP_RE  = /^\d{1,2}[.\-\/]\d{1,2}|^pagina\s*\d|^\d+$|^valabil|^reducere|^promotie|^oferta|^pret|^total/i;

function parseProducts(rawText) {
  if (!rawText || rawText.length < 50) return [];

  const lines = rawText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length >= 2);

  const products = [];
  const seen     = new Set();   // deduplicate: name + price key

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pm   = line.match(PRICE_RE);
    if (!pm) continue;

    // Parse numeric price
    const price = parseFloat(pm[1].replace(',', '.'));
    if (!price || price <= 0 || price > 9999) continue;

    // ── Find the product name ────────────────────────────────
    let name = '';

    // Look at the preceding lines (up to 4 lines back)
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      const prev = lines[j];
      if (SKIP_RE.test(prev))    continue;  // date / junk → skip
      if (PRICE_RE.test(prev))   continue;  // another price → skip
      if (prev.length >= 3) { name = prev; break; }
    }

    // Fallback: strip price from the same line
    if (!name) {
      name = line
        .replace(PRICE_RE, '')
        .replace(/[|\-–—]+/g, '')
        .trim();
    }

    if (name.length < 3) continue;

    const key = name.toLowerCase() + '|' + price;
    if (seen.has(key)) continue;
    seen.add(key);

    // Unit string (kg, buc, l …)
    const unitRaw = (pm[2] || '').toLowerCase().replace('lei','').replace('ron','').trim();
    const gramaj  = unitRaw ? `1 ${unitRaw}` : '';

    products.push({
      id        : products.length + 1,
      name      : name.substring(0, 120),
      price,
      priceLabel: price.toFixed(2).replace('.', ',') + ' lei' + (unitRaw ? `/${unitRaw}` : ''),
      gramaj,
      store     : 'Kaufland',
      category  : '',
    });
  }

  console.log(`[Kaufland] ✅ Parsed ${products.length} products from PDF text`);
  return products;
}

// ============================================================
//  PUBLIC FUNCTIONS  —  these are used by server.js
// ============================================================

/**
 * debugCatalogPage()
 * Returns what we discover on the catalog page WITHOUT
 * downloading anything. Use this first to diagnose problems.
 * Called by GET /api/kaufland-debug
 */
async function debugCatalogPage() {
  return discoverPdfUrls();
}

/**
 * getKauflandProducts()
 * Full pipeline: discover → download → parse.
 * Returns { products: [...], warning: string|null, source: 'Kaufland' }
 * NEVER throws — always returns a valid object.
 */
async function getKauflandProducts() {
  let discovery;
  try {
    discovery = await discoverPdfUrls();
  } catch (e) {
    const warning = `Nu am putut accesa pagina Kaufland: ${e.message}`;
    console.error('[Kaufland]', warning);
    return { products: [], warning, source: 'Kaufland' };
  }

  const { pdfUrls, viewers, isLikelyJsRendered } = discovery;

  // No PDFs found at all
  if (pdfUrls.length === 0) {
    let warning = 'Nu am găsit niciun fișier PDF pe pagina Kaufland.';
    if (isLikelyJsRendered) {
      warning += ' Pagina este probabil redată cu JavaScript (SPA) — fetch simplu nu funcționează. Soluție: adăugăm Puppeteer.';
    }
    if (viewers.length > 0) {
      warning += ` Am găsit în schimb ${viewers.length} viewer(e) embedded: ${viewers.slice(0,3).join(', ')}`;
    }
    console.warn('[Kaufland]', warning);
    return { products: [], warning, source: 'Kaufland', viewers };
  }

  // Try each PDF URL until one gives us products
  for (const url of pdfUrls) {
    try {
      const buf      = await downloadPdf(url);
      const text     = await extractText(buf);
      const products = parseProducts(text);

      if (products.length > 0) {
        return { products, warning: null, source: 'Kaufland', pdfUrl: url };
      }

      // PDF downloaded but no text → image-based
      return {
        products : [],
        warning  : `PDF descărcat cu succes (${(buf.length / 1024 / 1024).toFixed(1)} MB, URL: ${url}) ` +
                   'dar nu conține un strat de text extragibil. ' +
                   'Catalogul este format din imagini — avem nevoie de OCR (Tesseract.js sau Google Vision API).',
        source   : 'Kaufland',
        pdfUrl   : url,
      };
    } catch (e) {
      console.error(`[Kaufland] Failed for ${url}:`, e.message);
    }
  }

  return {
    products: [],
    warning : 'Toate PDF-urile găsite au eșuat la descărcare sau parsare. Verifică log-urile serverului.',
    source  : 'Kaufland',
  };
}

/**
 * searchKauflandProducts(query, allProducts)
 * Filter already-loaded products by a search query.
 */
function searchKauflandProducts(query, allProducts) {
  if (!query) return allProducts;
  const nq = normalize(query);
  return allProducts.filter(p => normalize(p.name).includes(nq));
}

module.exports = { getKauflandProducts, debugCatalogPage, searchKauflandProducts };
