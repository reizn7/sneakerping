// SneakPing API — one serverless function, routed via vercel.json rewrite (/api/x -> /api/app?r=x)
const crypto = require('crypto');
const webpush = require('web-push');
const E = process.env;
const RU = E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL, RT = E.UPSTASH_REDIS_REST_TOKEN || E.KV_REST_API_TOKEN;
const mem = global.__sp || (global.__sp = { k: new Map(), s: new Map() }); // dev-only fallback when no Redis is set

async function r(...a) {
  if (!RU) {
    const [c, k, v] = a, st = () => mem.s.get(k) || mem.s.set(k, new Set()).get(k);
    if (c === 'GET') return mem.k.get(k) ?? null;
    if (c === 'SET') { mem.k.set(k, v); return 'OK'; }
    if (c === 'DEL') { mem.k.delete(k); return 1; }
    if (c === 'SADD') { st().add(v); return 1; }
    if (c === 'SREM') { st().delete(v); return 1; }
    if (c === 'SMEMBERS') return [...st()];
  }
  const res = await fetch(RU, { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(a) });
  return (await res.json()).result;
}
const get = async k => { const v = await r('GET', k); return v ? JSON.parse(v) : null; };
const put = (k, v) => r('SET', k, JSON.stringify(v));
const h = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const norm = s => String(s).toLowerCase().replace(/uk|us|eu|size|[^a-z0-9.]/g, '');

function cleanUrl(u) {
  u = String(u || '').trim(); if (/^demo\d?$/.test(u)) return u;
  const x = new URL(u);
  if (!/^https?:$/.test(x.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(x.hostname)) throw new Error('Invalid link');
  x.hash = ''; return x.toString();
}

// ---------- scraping (best effort: JSON-LD + meta + embedded size JSON) ----------
const demo = (ms = Date.now(), v = 0) => {
  const t = ms / 6e4 + v * 11, sizes = [7, 8, 9, 10, 11].map((u, i) => ({ label: 'UK' + u, available: Math.sin(t / (9 + i * 4) + i) > 0.1 }));
  return { name: 'DEMO · Air Jordan 1 Low "Neon Nights"', image: null, price: 6495 + v * 150 - Math.round((Math.sin(t / 23) + 1) * 8) * 50, inStock: sizes.some(s => s.available), sizes };
};
const snapOf = (s, t = Date.now()) => ({ t, p: s.price, a: s.sizes.filter(x => x.available).map(x => x.label), i: s.inStock });
const backfill = v => Array.from({ length: 240 }, (_, i) => { const t = Date.now() - (240 - i) * 9e5; return snapOf(demo(t, v), t); });

const { parse, debug, looksSize, cleanLabel } = require('./_parse');
const fetchRes = u => fetch(E.FETCH_PROXY ? E.FETCH_PROXY.replace('{url}', encodeURIComponent(u)) : u, { redirect: 'follow', signal: AbortSignal.timeout(15000),
  headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36', 'accept': 'text/html,application/xhtml+xml,application/json', 'accept-language': 'en-IN,en;q=0.9' } });

async function shopify(url) { // Shopify stores expose clean variant stock at <product-url>.js
  const x = new URL(url); if (!/\/products\/[^/]+/.test(x.pathname)) return null;
  const r = await fetchRes(x.origin + x.pathname.replace(/\/$/, '') + '.js'); if (!r.ok) return null;
  const j = await r.json(); if (!j || !Array.isArray(j.variants) || !j.variants.length) return null;
  const m = new Map();
  for (const v of j.variants) {
    const l = [v.option1, v.option2, v.option3].map(cleanLabel).find(looksSize); if (!l) continue;
    m.set(l, m.get(l) || !!v.available);
  }
  const sizes = [...m].map(([label, available]) => ({ label, available }));
  let img = j.featured_image || (j.images && j.images[0]) || null; if (img && img.startsWith('//')) img = 'https:' + img;
  return { name: j.title, image: img, price: Math.min(...j.variants.map(v => v.price)) / 100, inStock: !!j.available, sizes, sizeSource: sizes.length ? 'shopify' : 'none' };
}
async function scrape(url) {
  if (/^demo\d?$/.test(url)) return demo(Date.now(), +url.slice(4) || 0);
  const sh = await shopify(url).catch(() => null); if (sh) return sh;
  const res = await fetchRes(url);
  if (!res.ok) throw new Error('Site returned ' + res.status + (res.status === 403 || res.status === 429 ? ' (blocked — set FETCH_PROXY)' : ''));
  return parse(await res.text());
}

// ---------- watch logic ----------
const avail = (w, s, z) => w.size === 'ANY' ? (z ? s.a.length > 0 : s.i !== false) : s.a.map(norm).includes(norm(w.size));
const ok = (w, s, z) => avail(w, s, z) && (!w.max || s.p <= w.max);

function record(prod, s) {
  const snap = snapOf(s), l = prod.h[prod.h.length - 1];
  if (!l || l.p !== snap.p || l.a.join() !== snap.a.join() || snap.t - l.t > 18e5) prod.h.push(snap);
  if (prod.h.length > 1500) prod.h = prod.h.slice(-1500);
  prod.sizes = s.sizes.map(x => x.label); prod.last = snap; return snap;
}

async function notify(a, ch, title, body, url) {
  const out = [];
  if (ch.push && a.push && E.VAPID_PUBLIC) {
    try { webpush.setVapidDetails(E.VAPID_SUBJECT || 'mailto:admin@example.com', E.VAPID_PUBLIC, E.VAPID_PRIVATE); await webpush.sendNotification(a.push, JSON.stringify({ title, body, url })); out.push('push'); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { a.push = null; await put('acct:' + a.id, a); } }
  }
  if (ch.tg && a.tg && E.TG_TOKEN) {
    try { await fetch(`https://api.telegram.org/bot${E.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: a.tg, text: `${title}\n${body}\n${url}` }) }); out.push('tg'); } catch {}
  }
  return out;
}

// ---------- multi-listing logic: one watch = one shoe, several retailer links ----------
const linksOf = w => w.links || [{ url: w.url, pid: w.pid }];
const hostOf = u => /^demo/.test(u) ? 'demo-store-' + (u.slice(4) || '1') : new URL(u).hostname.replace(/^www\./, '');

async function evalWatch(w, prods = {}) { // cheapest listing that satisfies the rule, or null
  const hit = [];
  for (const l of linksOf(w)) {
    const prod = prods[l.pid] || (prods[l.pid] = await get('prod:' + l.pid)); if (!prod || !prod.last) continue;
    if (ok(w, prod.last, prod.sizes.length > 0)) hit.push({ link: l, snap: prod.last });
  }
  hit.sort((x, y) => x.snap.p - y.snap.p);
  return hit.length ? { ...hit[0], n: hit.length - 1 } : null;
}

async function fire(w, best) {
  const a = await get('acct:' + w.acct), free = !(w.paidUntil > Date.now());
  const body = `${w.size === 'ANY' ? 'In stock' : 'Size ' + w.size + ' is in stock'} at ${inr(best.snap.p)} on ${hostOf(best.link.url)}`
    + (best.n ? `\n+${best.n} other retailer${best.n > 1 ? 's' : ''} also have it` : '')
    + (free ? '\nThat was your free alert. Pay ₹49 in your dashboard to keep watching.' : '');
  const sent = await notify(a, w.ch, '🔥 ' + w.name, body, best.link.url.startsWith('demo') ? (E.APP_URL || '') : best.link.url);
  w.sat = true; w.alerts++; w.lastAlert = Date.now();
  if (free) { w.freeUsed = true; w.status = 'locked'; }
  await put('watch:' + w.id, w); return sent.length;
}

async function cron() {
  const ids = await r('SMEMBERS', 'watches'), now = Date.now(), live = [];
  for (const w of (await Promise.all(ids.map(i => get('watch:' + i)))).filter(Boolean)) {
    if (w.status !== 'active') continue;
    if (w.paidUntil && w.paidUntil < now) { w.status = 'expired'; await put('watch:' + w.id, w); continue; }
    live.push(w);
  }
  const pids = [...new Set(live.flatMap(w => linksOf(w).map(l => l.pid)))], prods = {}, t0 = Date.now(); let checked = 0, sent = 0;
  for (let i = 0; i < pids.length && Date.now() - t0 < 45e3; i += 5) {
    await Promise.all(pids.slice(i, i + 5).map(async pid => { // each unique listing is fetched once, however many watchers
      const prod = await get('prod:' + pid); if (!prod) return; prods[pid] = prod;
      try { record(prod, await scrape(prod.url)); prod.err = null; checked++; } catch (e) { prod.err = e.message; }
      await put('prod:' + pid, prod);
    }));
  }
  for (const w of live) {
    const best = await evalWatch(w, prods);
    if (best && !w.sat) sent += await fire(w, best);
    else if (!!best !== !!w.sat) { w.sat = !!best; await put('watch:' + w.id, w); }
  }
  return { listings: pids.length, checked, alertsSent: sent };
}

// ---------- discovery: Gemini (with Google Search) proposes links, we only keep ones we can fetch and verify ----------
async function geminiLinks(s) {
  const q = `Find product pages on Indian online retailers (for example Myntra, Ajio, Nike India, Adidas India, Flipkart, Amazon.in, Superkicks, VegNonVeg, Crepdog Crew, Tata CLiQ) that sell this exact shoe: "${s.name}"${s.code ? ' (style code ' + s.code + ')' : ''}. Return ONLY a JSON array of up to 8 objects like {"retailer":"Myntra","url":"https://..."}. Use only direct product page URLs that appear in your search results. No search or category pages and no explanations.`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${E.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(40000), headers: { 'content-type': 'application/json', 'x-goog-api-key': E.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: q }] }], tools: [{ google_search: {} }] }) });
  const j = await res.json(); if (!res.ok) throw new Error('Gemini: ' + ((j.error && j.error.message) || res.status));
  const txt = ((j.candidates && j.candidates[0] && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
  let arr = []; try { arr = JSON.parse((txt.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch {}
  return arr.map(x => x && x.url).filter(u => typeof u === 'string').slice(0, 8);
}
const tok = t => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1));
function matchOf(a, b) {
  if (a.code && b.code) return a.code.toLowerCase() === b.code.toLowerCase() ? 'code' : 'no';
  const A = tok(a.name), B = tok(b.name), i = [...A].filter(x => B.has(x)).length / Math.max(1, Math.min(A.size, B.size));
  return i >= .75 ? 'likely' : i >= .5 ? 'check' : 'no';
}
async function verify(urls, s0, base) {
  const seen = new Set([base]), todo = [];
  for (const u of urls) { try { const c = cleanUrl(u); if (!seen.has(c)) { seen.add(c); todo.push(c); } } catch {} }
  const out = await Promise.allSettled(todo.map(async url => { const s = await scrape(url); return { url, host: hostOf(url), name: s.name, image: s.image, price: s.price, inStock: s.inStock, sizes: s.sizes, sizeSource: s.sizeSource, match: matchOf(s0, s) }; }));
  return out.filter(o => o.status === 'fulfilled' && o.value.match !== 'no').map(o => o.value);
}

// ---------- router ----------
module.exports = async (req, res) => {
  const route = String(req.query.r || '').replace(/\/$/, ''), body = req.body || {}, send = (c, o) => res.status(c).json(o);
  try {
    if (route === 'config') return send(200, { vapid: E.VAPID_PUBLIC || '', upi: E.UPI_ID || '', bot: E.TG_BOT || '', price: 49, disc: !!E.GEMINI_API_KEY });
    if (route === 'session') { const id = crypto.randomBytes(12).toString('hex'); await put('acct:' + id, { id, created: Date.now(), push: null, tg: null }); return send(200, { key: id }); }
    if (route === 'cron') {
      if (!E.CRON_SECRET || (req.headers.authorization !== 'Bearer ' + E.CRON_SECRET && req.query.key !== E.CRON_SECRET)) return send(401, { error: 'no' });
      return send(200, await cron());
    }
    if (route === 'telegram') { // Telegram bot webhook: "/start CODE" links the chat to an account
      if (E.TG_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== E.TG_SECRET) return send(401, {});
      const m = body.message, code = m && m.text && (m.text.match(/^\/start\s+(\w+)/) || [])[1];
      const say = t => fetch(`https://api.telegram.org/bot${E.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: m.chat.id, text: t }) });
      if (code) {
        const aid = await get('tgc:' + code), a = aid && await get('acct:' + aid);
        if (a) { a.tg = m.chat.id; await put('acct:' + a.id, a); await say('✅ SneakPing linked. Alerts will arrive here.'); } else await say('That link expired. Generate a new one in the app.');
      } else if (m) await say('Open SneakPing and tap "Connect Telegram" to link this chat.');
      return send(200, {});
    }
    if (route === 'admin') {
      if (!E.ADMIN_KEY || body.akey !== E.ADMIN_KEY) return send(401, { error: 'Wrong admin key' });
      if (body.op === 'debug') { const u = cleanUrl(body.url), rr = await fetchRes(u); return send(200, debug(await rr.text(), rr.status)); }
      if (body.op === 'list') {
        const ps = (await Promise.all((await r('SMEMBERS', 'pays')).map(i => get('pay:' + i)))).filter(p => p && p.status === 'pending');
        for (const p of ps) { const w = await get('watch:' + p.wid); p.name = w && w.name; p.size = w && w.size; }
        return send(200, { pays: ps });
      }
      const p = await get('pay:' + body.id), w = p && await get('watch:' + p.wid); if (!p || !w) return send(404, { error: 'Not found' });
      p.status = body.op === 'approve' ? 'approved' : 'rejected'; w.payPending = false;
      if (body.op === 'approve') {
        w.paidUntil = Math.max(Date.now(), w.paidUntil || 0) + 30 * 864e5; w.status = 'active';
        w.sat = !!(await evalWatch(w));
        await notify(await get('acct:' + w.acct), w.ch, '✅ Payment confirmed', `${w.name} is being watched for 30 days.`, E.APP_URL || '');
      }
      await put('pay:' + p.id, p); await put('watch:' + w.id, w); return send(200, { ok: true });
    }

    const a = req.headers['x-key'] && await get('acct:' + req.headers['x-key']); if (!a) return send(401, { error: 'Session expired' });
    const mine = async () => (await Promise.all((await r('SMEMBERS', 'aw:' + a.id)).map(i => get('watch:' + i)))).filter(Boolean);
    const own = async id => { const w = await get('watch:' + id); return w && w.acct === a.id ? w : null; };

    switch (route) {
      case 'me': return send(200, { push: !!a.push, tg: !!a.tg });
      case 'inspect': { const url = cleanUrl(body.url); return send(200, { url, ...(await scrape(url)) }); }
      case 'watch/new': {
        const urls = [...new Set([].concat(body.links || body.url || []).map(cleanUrl))].slice(0, 6);
        const size = String(body.size || 'ANY').slice(0, 12), max = Math.max(0, +body.max || 0), ws = await mine();
        if (!urls.length) return send(400, { error: 'Add at least one link.' });
        if (ws.filter(w => w.status === 'active' && !w.paidUntil).length >= 3) return send(400, { error: 'Free watch limit (3 live) reached. Pay for one or delete one.' });
        const links = []; let first;
        for (const url of urls) {
          try {
            const sc = await scrape(url), pid = h(url);
            const prod = (await get('prod:' + pid)) || { pid, url, name: sc.name, image: sc.image, h: /^demo/.test(url) ? backfill(+url.slice(4) || 0) : [], sizes: [] };
            record(prod, sc); await put('prod:' + pid, prod); links.push({ url, pid }); first = first || prod;
          } catch (e) { if (urls.length === 1) throw e; }
        }
        if (!links.length) return send(400, { error: "Couldn't read any of those links." });
        const w = { id: crypto.randomBytes(5).toString('hex'), acct: a.id, links, url: links[0].url, pid: links[0].pid, name: first.name, image: first.image, size, max, ch: { push: !!(body.ch && body.ch.push), tg: !!(body.ch && body.ch.tg) }, status: 'active', freeUsed: false, paidUntil: 0, alerts: 0, created: Date.now() };
        w.sat = !!(await evalWatch(w));
        await put('watch:' + w.id, w); await r('SADD', 'watches', w.id); await r('SADD', 'aw:' + a.id, w.id);
        return send(200, { id: w.id, alreadyOk: w.sat, listings: links.length });
      }
      case 'discover': {
        const base = cleanUrl(body.url), s0 = await scrape(base); let urls;
        if (/^demo/.test(base)) urls = ['demo', 'demo2', 'demo3']; // demo mode: no AI key or quota needed
        else {
          if (!E.GEMINI_API_KEY) return send(400, { error: 'Discovery is not configured on this server.' });
          const day = 'rl:' + a.id + ':' + new Date().toISOString().slice(0, 10), n = (await get(day)) || 0;
          if (n >= 5) return send(400, { error: 'Daily discovery limit reached (5). Try again tomorrow.' });
          const ck = 'disc:' + h(String(s0.code || s0.name).toLowerCase()), c = await get(ck);
          if (c && Date.now() - c.t < 864e5) urls = c.urls;
          else { await put(day, n + 1); urls = await geminiLinks(s0); await put(ck, { t: Date.now(), urls }); }
        }
        return send(200, { results: await verify(urls, s0, base) });
      }
      case 'watches': {
        const prods = {}, out = [];
        for (const w of await mine()) {
          const ls = [];
          for (const l of linksOf(w)) { const p = prods[l.pid] || (prods[l.pid] = await get('prod:' + l.pid)); ls.push({ url: l.url, last: p && p.last, err: p && p.err }); }
          out.push({ ...w, ls });
        }
        return send(200, { watches: out.sort((x, y) => y.created - x.created) });
      }
      case 'watch': {
        const w = await own(body.id); if (!w) return send(404, { error: 'Not found' });
        const prods = [];
        for (const l of linksOf(w)) { const p = await get('prod:' + l.pid); if (p) prods.push({ url: l.url, name: p.name, image: p.image, h: p.h, sizes: p.sizes, last: p.last, err: p.err }); }
        return send(200, { w, prods });
      }
      case 'watch/set': {
        const w = await own(body.id); if (!w) return send(404, { error: 'Not found' });
        if (body.op === 'delete') { await r('DEL', 'watch:' + w.id); await r('SREM', 'watches', w.id); await r('SREM', 'aw:' + a.id, w.id); return send(200, { ok: true }); }
        if (body.op === 'pause') w.status = 'paused';
        if (body.op === 'resume') { if (w.freeUsed && !(w.paidUntil > Date.now())) return send(400, { error: 'Pay ₹49 to resume this watch.' }); w.status = 'active'; }
        if (body.op === 'edit') { w.max = Math.max(0, +body.max || 0); w.ch = { push: !!body.ch.push, tg: !!body.ch.tg }; w.sat = !!(await evalWatch(w)); }
        await put('watch:' + w.id, w); return send(200, { ok: true });
      }
      case 'channel': {
        if (body.push !== undefined) a.push = body.push; if (body.unlinkTg) a.tg = null;
        await put('acct:' + a.id, a); return send(200, { ok: true });
      }
      case 'tgcode': { const code = crypto.randomBytes(5).toString('hex'); await put('tgc:' + code, a.id); return send(200, { code }); }
      case 'test': return send(200, { sent: await notify(a, { push: true, tg: true }, 'SneakPing test', 'Alerts are working ✅', E.APP_URL || '') });
      case 'pay': {
        const w = await own(body.id), utr = String(body.utr || '').replace(/\s/g, '');
        if (!w) return send(404, { error: 'Not found' }); if (!/^\w{8,24}$/.test(utr)) return send(400, { error: 'Enter the UPI transaction ID (UTR) from your payment app.' });
        const id = crypto.randomBytes(5).toString('hex'); await put('pay:' + id, { id, wid: w.id, acct: a.id, utr, t: Date.now(), status: 'pending' }); await r('SADD', 'pays', id);
        w.payPending = true; await put('watch:' + w.id, w); return send(200, { ok: true });
      }
    }
    return send(404, { error: 'Unknown route' });
  } catch (e) { return send(400, { error: e.message }); }
};
