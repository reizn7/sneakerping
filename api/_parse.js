// Product page parsing: JSON-LD + embedded JSON state (window.__x = {...}, __NEXT_DATA__, ...) + HTML fallback.
// The file name starts with "_" so Vercel does not expose it as its own endpoint.
const SIZE_RE = /^(?:(?:uk|us|eu|in)\s?-?\s?)?\d{1,2}(?:\.5)?$|^(?:xxs|xs|s|m|l|xl|xxl|xxxl)$/i;
const cleanLabel = v => String(v ?? '').split('/')[0].replace(/\s+/g, ' ').trim();
const looksSize = l => l.length > 0 && l.length <= 10 && SIZE_RE.test(l);

const LBL = ['label', 'sizeLabel', 'sizeName', 'displaySize', 'size', 'value', 'title', 'name', 'option1', 'text'];
function labelOf(o, depth = 0) {
  for (const k of LBL) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') { const l = cleanLabel(v); if (looksSize(l)) return l; }
    else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1) { const l = labelOf(v, depth + 1); if (l) return l; }
  }
}
function availOf(o) {
  for (const k of ['available', 'inStock', 'isAvailable', 'in_stock', 'isInStock', 'sizeAvailable']) if (typeof o[k] === 'boolean') return o[k];
  for (const k of ['soldOut', 'isSoldOut', 'outOfStock', 'isOutOfStock', 'sold_out']) if (typeof o[k] === 'boolean') return !o[k];
  for (const k of ['inventory_quantity', 'stock', 'quantity', 'inventory', 'sellableStock', 'inventoryCount']) if (typeof o[k] === 'number') return o[k] > 0;
  if (typeof o.availability === 'string') return /in\s?stock/i.test(o.availability);
  if (o.offers) { const arr = [].concat(o.offers).filter(x => x && typeof x.availability === 'string'); if (arr.length) return arr.some(x => /InStock/i.test(x.availability)); }
}

// Find arrays of objects that look like "size + availability" lists anywhere in a JSON tree.
function candidates(root) {
  const out = []; let n = 0;
  (function walk(o, path) {
    if (!o || typeof o !== 'object' || ++n > 300000) return;
    if (Array.isArray(o)) {
      const items = o.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (items.length >= 2) {
        const m = new Map(); let hits = 0;
        for (const it of items) { const l = labelOf(it), a = availOf(it); if (l !== undefined && a !== undefined) { hits++; m.set(l, m.get(l) || a); } }
        if (m.size >= 2 && hits >= items.length * 0.5) out.push({ path, sizes: [...m].map(([label, available]) => ({ label, available })) });
      }
    }
    for (const k in o) walk(o[k], path + '.' + k);
  })(root, '$');
  return out;
}

function balanced(s, i) {
  let d = 0, str = false, esc = false;
  for (let j = i; j < s.length && j - i < 3e6; j++) {
    const c = s[j];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if (c === '{' || c === '[') d++; else if (c === '}' || c === ']') { if (--d === 0) return s.slice(i, j + 1); }
  }
}
function blobs(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const body = m[2].trim(); if (body.length < 20) continue;
    if (/json/i.test(m[1])) { try { out.push({ ld: /ld\+json/i.test(m[1]), data: JSON.parse(body) }); } catch {} continue; }
    for (const a of body.matchAll(/(?:window(?:\.\w+|\[['"][^\]]+['"]\])+|(?:var|let|const)\s+[\w$]+)\s*=\s*(?=[{[])/g)) {
      const s = balanced(body, a.index + a[0].length);
      if (s) { try { out.push({ ld: false, data: JSON.parse(s) }); } catch {} }
    }
  }
  return out;
}
function htmlSizes(html) { // last resort: size-looking buttons/options, disabled/sold-out by class or attribute
  const m = new Map();
  for (const t of html.matchAll(/<(?:button|option|li|label|span|div|a)\b([^>]*)>\s*([^<>]{1,10}?)\s*</gi)) {
    const l = cleanLabel(t[2]); if (!looksSize(l) || !/\d/.test(l)) continue;
    m.set(l, m.get(l) || !/disabled|sold|unavail|out[-_ ]?of[-_ ]?stock|oos|inactive|strike|not-available/i.test(t[1]));
  }
  return m.size >= 4 ? [...m].map(([label, available]) => ({ label, available })) : [];
}

function parse(html) {
  const bl = blobs(html), nodes = [];
  const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { nodes.push(o); walk(o['@graph']); } };
  bl.filter(b => b.ld).forEach(b => walk(b.data));
  const meta = n => {
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
      const attrs = tag[0];
      const key = attrs.match(/\b(?:property|name)=["']([^"']+)["']/i);
      if (!key || key[1].toLowerCase() !== n.toLowerCase()) continue;
      const content = attrs.match(/\bcontent=["']([^"']*)["']/i);
      if (content) return content[1];
    }
  };
  let name, image, price, inStock = null;
  const p = nodes.find(n => [].concat(n['@type']).some(t => /^Product(Group)?$/.test(t)));
  if (p) {
    name = p.name; image = [].concat(p.image || [])[0]; if (image && image.url) image = image.url;
    const o = [].concat(p.offers || [], ...[].concat(p.hasVariant || []).map(v => v.offers || [])).flatMap(x => x.offers ? [].concat(x.offers) : x);
    const ps = o.map(x => +(x.price ?? x.lowPrice)).filter(Boolean); if (ps.length) price = Math.min(...ps);
    if (o.length) inStock = o.some(x => /InStock/i.test(x.availability || ''));
  }
  name = (name || meta('og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').replace(/&amp;/g, '&').replace(/&#39;|&quot;/g, "'").trim();
  image = image || meta('og:image');
  price = price || +meta('product:price:amount') || +meta('og:price:amount');

  if (!price) {
    const pm = html.match(/(?:₹|Rs\.?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (pm) price = +(pm[1].replace(/,/g, ''));
  }

  let sizes = [], sizeSource = 'none';
  const best = bl.flatMap(b => candidates(b.data)).sort((a, b) => b.sizes.length - a.sizes.length)[0];
  if (best) { sizes = best.sizes; sizeSource = 'json'; }
  else { const g = htmlSizes(html); if (g.length) { sizes = g; sizeSource = 'html-guess'; } }
  if (sizes.length) inStock = sizes.some(s => s.available);
  if (!name || !price) throw new Error("Couldn't read this product page (no name/price found).");
  const cm = t => (String(t || '').match(/\b[A-Z]{2}\d{4}-\d{3}\b/i) || [])[0];
  const code = cm(p && p.sku) || cm(p && p.mpn) || cm(name);
  return { name, image, price, inStock, sizes, sizeSource, code };
}

function debug(html, status) {
  const bl = blobs(html);
  const cands = bl.flatMap(b => candidates(b.data)).sort((a, b) => b.sizes.length - a.sizes.length).slice(0, 5).map(c => ({ path: c.path, count: c.sizes.length, sample: c.sizes.slice(0, 6) }));
  const markers = ['__myx', '__NEXT_DATA__', '__INITIAL_STATE__', '__PRELOADED_STATE__', 'ld+json', 'Shopify', 'sizeSellerData', 'og:price'].filter(m => html.includes(m));
  let parsed = null, error = null;
  try { const p = parse(html); parsed = { name: p.name, price: p.price, inStock: p.inStock, sizeSource: p.sizeSource, sizes: p.sizes }; } catch (e) { error = e.message; }
  return { status, length: html.length, jsonBlobs: bl.length, markers, candidates: cands, htmlGuess: htmlSizes(html).length, parsed, error,
    hint: html.length < 30000 && !bl.length ? 'Very little data: the page is probably JavaScript-rendered or blocked. Try FETCH_PROXY.' : undefined };
}
module.exports = { parse, debug, looksSize, cleanLabel };
