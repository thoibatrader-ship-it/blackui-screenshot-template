// capture.mjs — scans an HTML app in headless Chromium and captures candidate screens for each device.
//
// Input : input/request.json  (+ the HTML app inside input/)
// Output: out/preview/manifest.json + out/preview/thumbs/*.jpg   (small, for the AI to look at)
//         out/full/*.png                                          (full resolution, opaque PNG)
//
// Three ways a screen list is produced (first match wins):
//   1. plan  — request.screens is given: [{ key, label?, steps:[{click:"#x"}, {wait:500}, ...] }]
//   2. hook  — the app exposes window.__shots = { screens:[...], show(key) }   (best for AI-built apps)
//   3. scan  — no hint at all: click through the UI, keep screens that look clearly different
//
// Nothing here is store-specific: the devices (width/height/scale) always come from request.json.

import { chromium } from 'playwright';
import sharp from 'sharp';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// One repo, many apps: with env JOB=<name> the app lives in <repo>/jobs/<name>/ (otherwise the legacy input/ folder).
const JOB = String(process.env.JOB || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const INPUT = JOB ? path.join(ROOT, '..', 'jobs', JOB) : path.join(ROOT, 'input');
const INPUT_LABEL = JOB ? `jobs/${JOB}` : 'input';
// Hard cap per run (resource guard). The dashboard enforces the same number.
export const MAX_SCREENS = 20;
const OUT = path.join(ROOT, 'out');
const OUT_PREVIEW = path.join(OUT, 'preview');
const OUT_THUMBS = path.join(OUT_PREVIEW, 'thumbs');
const OUT_FULL = path.join(OUT, 'full');

const TOTAL_BUDGET_MS = 11 * 60 * 1000;
const DEADLINE = Date.now() + TOTAL_BUDGET_MS;

const DEFAULT_BLOCKED =
  'delete|remove|reset|clear|log ?out|sign ?out|exit|quit|buy|purchase|pay|checkout|subscribe|upgrade|install|download|uninstall|erase|wipe|format|danger|deactivate|हटा|डिलीट|रीसेट|लॉग ?आउट|खरीद|इंस्टॉल';

/* ------------------------------------------------------------------ helpers */

export const slug = (s, fallback = 'screen') => {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || fallback;
};

const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function normalizeRequest(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];
  const req = {
    entry: typeof r.entry === 'string' && r.entry ? r.entry.replace(/^\/+/, '') : 'app.html',
    maxCandidates: Math.floor(clampNum(r.maxCandidates, 1, MAX_SCREENS, 16)),
    minChange: clampNum(r.minChange, 0.01, 0.9, 0.04),
    maxDepth: Math.floor(clampNum(r.maxDepth, 0, 4, 3)),
    maxTries: Math.floor(clampNum(r.maxTries, 5, 120, 70)),
    settleMs: Math.floor(clampNum(r.settleMs, 0, 5000, 800)),
    clickTimeoutMs: Math.floor(clampNum(r.clickTimeoutMs, 500, 8000, 1500)),
    animations: r.animations === 'allow' ? 'allow' : 'disabled',
    blocked: new RegExp(DEFAULT_BLOCKED + (Array.isArray(r.blockedWords) && r.blockedWords.length
      ? '|' + r.blockedWords.map(w => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : ''), 'i'),
    seedLocalStorage: r.seed && typeof r.seed.localStorage === 'object' ? r.seed.localStorage : null,
    screens: Array.isArray(r.screens) ? r.screens : null,
    devices: []
  };

  const list = Array.isArray(r.devices) && r.devices.length ? r.devices : [
    { id: 'phone', width: 360, height: 640, scale: 3, mobile: true },
    { id: 'tablet10', width: 800, height: 1280, scale: 2, mobile: true }
  ];
  const seen = new Set();
  for (const d of list.slice(0, 4)) {
    const width = Math.round(clampNum(d.width, 200, 2000, 360));
    const height = Math.round(clampNum(d.height, 200, 2000, 640));
    const scale = clampNum(d.scale, 1, 4, 2);
    const pw = Math.round(width * scale), ph = Math.round(height * scale);
    let id = slug(d.id, 'device');
    while (seen.has(id)) id += '-2';
    seen.add(id);
    if (pw > 7680 || ph > 7680) { warnings.push(`Device "${id}" skipped: ${pw}x${ph}px is too large.`); continue; }
    // Store-rule hints only (Play: each side 320-3840px, long side at most 2x the short side). Not enforced.
    if (Math.min(pw, ph) < 320 || Math.max(pw, ph) > 3840) warnings.push(`Device "${id}" is ${pw}x${ph}px; Google Play wants each side between 320 and 3840px.`);
    if (Math.max(pw, ph) > 2 * Math.min(pw, ph)) warnings.push(`Device "${id}" is ${pw}x${ph}px; Google Play wants the long side to be at most 2x the short side.`);
    req.devices.push({ id, width, height, scale, mobile: d.mobile !== false, pixelWidth: pw, pixelHeight: ph });
  }
  return { req, warnings };
}

// 32x32 greyscale fingerprint of a screenshot
export async function signature(buf) {
  return sharp(buf).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer();
}
// fraction of fingerprint cells that differ clearly
export function diffFrac(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) n++;
  return n / a.length;
}
export async function isBlank(buf) {
  const st = await sharp(buf).stats();
  return Math.max(...st.channels.map(c => c.stdev)) < 2.5;
}

// how different the visible words of two screens are (0 = same words, 1 = nothing in common)
export function textDist(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  if (union < 6) return 0;  // too little text to judge
  return 1 - inter / union;
}

function startServer(dir) {
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
  };
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.normalize(path.join(dir, p));
      if (!f.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
      const data = await fs.readFile(f);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/* ------------------------------------------------------------ page actions */

async function settle(page, ms) {
  try { await page.waitForLoadState('load', { timeout: 10000 }); } catch { /* ignore */ }
  try { await page.evaluate(() => (document.fonts && document.fonts.ready) || null); } catch { /* ignore */ }
  await page.waitForTimeout(ms);
}

async function makeContext(browser, dev, req) {
  const ctx = await browser.newContext({
    viewport: { width: dev.width, height: dev.height },
    deviceScaleFactor: dev.scale,
    isMobile: dev.mobile,
    hasTouch: dev.mobile,
    reducedMotion: 'no-preference'
  });
  if (req.seedLocalStorage) {
    await ctx.addInitScript(seed => {
      try { for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { /* ignore */ }
    }, req.seedLocalStorage);
  }
  const mains = new Set();
  ctx.on('page', p => { setTimeout(() => { if (!mains.has(p)) p.close().catch(() => {}); }, 250); });  // close popups / new tabs
  const page = await ctx.newPage();
  mains.add(page);
  page.on('dialog', d => d.dismiss().catch(() => {}));
  return { ctx, page };
}

async function runSteps(page, steps, req) {
  let stepNo = 0;
  for (const s of steps) {
    stepNo++;
    try { await runOneStep(page, s, req); }
    catch (e) { throw new Error(`step ${stepNo}: ${String(e.message).split('\n')[0]}`); }
  }
}

async function runOneStep(page, s, req) {
  {
    // verify the target exists BEFORE waiting on it (the AI may have guessed a button that is not there)
    const target = s.click || (Array.isArray(s.fill) ? s.fill[0] : null);
    if (target) {
      let n = 0;
      try { n = await page.locator(target).count(); } catch (e) { throw new Error(`bad selector ${target}`); }
      if (!n) { await page.waitForTimeout(400); n = await page.locator(target).count().catch(() => 0); }
      if (!n) throw new Error(`not found: ${target}`);
    }
    if (s.click) {
      try { await page.click(s.click, { timeout: req.clickTimeoutMs }); }
      catch (e) {
        // animated / pulsing buttons never become "stable"; retry once without that check
        if (!/stable|intercept/i.test(String(e.message))) throw e;
        await page.click(s.click, { timeout: req.clickTimeoutMs, force: true });
      }
    }
    else if (s.fill) await page.fill(s.fill[0], String(s.fill[1]), { timeout: req.clickTimeoutMs });
    else if (s.press) await page.keyboard.press(String(s.press));
    else if (Array.isArray(s.drag) && s.drag.length > 1) {
      const pts = s.drag;
      await page.mouse.move(pts[0][0], pts[0][1]);
      await page.mouse.down();
      for (const q of pts.slice(1)) await page.mouse.move(q[0], q[1], { steps: 8 });
      await page.mouse.up();
    }
    else if (s.hook !== undefined) await page.evaluate(k => window.__shots.show(k), s.hook);
    else if (s.wait) { await page.waitForTimeout(Math.min(Number(s.wait) || 0, 5000)); return; }
    await settle(page, req.settleMs);
  }
}

async function openAndRun(page, url, steps, req) {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await settle(page, req.settleMs);
  await runSteps(page, steps, req);
  if (new URL(page.url()).origin !== new URL(url).origin) throw new Error('navigated away from the app');
}

async function describePage(page) {
  return page.evaluate(() => {
    const vis = el => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 &&
        r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    let name = null, best = 0;
    document.querySelectorAll('[data-screen]').forEach(el => {
      if (!vis(el)) return;
      const r = el.getBoundingClientRect();
      const a = Math.min(r.width, innerWidth) * Math.min(r.height, innerHeight);
      if (a >= best) { best = a; name = el.getAttribute('data-screen'); }
    });
    let title = '';
    for (const el of document.querySelectorAll('h1,h2,[data-screen-title]')) { if (vis(el)) { title = (el.innerText || '').trim(); break; } }
    const hint = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const tokens = Array.from(new Set(((document.body && document.body.innerText) || '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])).slice(0, 300);
    return { name, title: title.slice(0, 80), hint, docTitle: document.title || '', tokens };
  });
}

async function listClickables(page, req) {
  return page.evaluate(({ blockedSrc }) => {
    const blocked = new RegExp(blockedSrc, 'i');
    const esc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    const vis = el => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 &&
        r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    // like vis(), but also accepts items below the fold (menus / lists scroll; the click scrolls them into view)
    const visList = el => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 &&
        r.bottom > 0 && r.right > 0 && r.top < innerHeight * 3 && r.left < innerWidth;
    };
    const uniq = id => document.querySelectorAll('#' + esc(id)).length === 1;
    const css = el => {
      if (el.id && uniq(el.id)) return '#' + esc(el.id);
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1 && n !== document.body) {
        if (n.id && uniq(n.id)) { parts.unshift('#' + esc(n.id)); break; }
        let i = 1, s = n;
        while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
        parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
        n = n.parentElement;
      }
      return (parts[0] && parts[0][0] === '#' ? '' : 'body > ') + parts.join(' > ');
    };
    const sel = 'button,a[href],[role="button"],[role="tab"],[onclick],summary,.tab,.nav-item,[data-nav],[data-go],[data-target],[data-tab]';
    const out = [], seen = new Set(), groups = new Map();
    const navRe = /menu|nav|tab|setting|more|drawer|sidebar|hamburger|options|profile|home|back|next|prev/i;
    for (const el of document.querySelectorAll(sel)) {
      if (!visList(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const label = (el.innerText || el.getAttribute('aria-label') || el.title || el.id || '').trim().slice(0, 40);
      const probe = [label, el.getAttribute('aria-label'), el.title, el.id, typeof el.className === 'string' ? el.className : ''].join(' ');
      if (blocked.test(probe)) continue;
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (el.target === '_blank' || el.hasAttribute('download') || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
        if (/^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin) continue;
      }
      const c = css(el);
      if (seen.has(c)) continue;
      // look-alikes (colour swatches, grid cells, list rows): keep only a few of each kind
      const isTab = el.hasAttribute('data-tab') || el.getAttribute('role') === 'tab';
      const gk = el.tagName + '|' + (typeof el.className === 'string' ? el.className : '') + '|' + (el.parentElement ? el.parentElement.tagName + (el.parentElement.id || (typeof el.parentElement.className === 'string' ? el.parentElement.className : '')) : '');
      const gn = (groups.get(gk) || 0) + 1;
      groups.set(gk, gn);
      if (!isTab && gn > 3) continue;
      seen.add(c);
      const nav = el.hasAttribute('aria-controls') || el.hasAttribute('aria-expanded') || navRe.test(probe);
      out.push({ sel: c, label, rank: nav ? 0 : isTab ? 1 : 2 });
      if (out.length >= 40) break;
    }
    if (out.length < 12) {
      // elements with only a JS click listener: the pointer cursor is the best visible hint (topmost element only)
      let scanned = 0;
      for (const el of document.body.querySelectorAll('*')) {
        if (++scanned > 800 || out.length >= 12) break;
        if (el.closest(sel) && el.matches(sel)) continue;
        const cs = getComputedStyle(el);
        if (cs.cursor !== 'pointer' || !vis(el)) continue;
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue;
        if (el.closest('button,a[href],[role="button"],[onclick]') && !el.matches('button,a[href],[role="button"],[onclick]')) continue;
        const label = (el.innerText || el.getAttribute('aria-label') || el.title || el.id || '').trim().slice(0, 40);
        const probe = [label, el.getAttribute('aria-label'), el.title, el.id, typeof el.className === 'string' ? el.className : ''].join(' ');
        if (blocked.test(probe)) continue;
        const c = css(el);
        if (seen.has(c)) continue;
        seen.add(c);
        out.push({ sel: c, label, rank: 3 });
      }
    }
    return out.map((o, i) => ({ ...o, i })).sort((a, b) => (a.rank - b.rank) || (a.i - b.i)).slice(0, 24).map(({ sel, label }) => ({ sel, label }));
  }, { blockedSrc: req.blocked.source });
}

/* --------------------------------------------------------------- discovery */

async function rootHook(page) {
  return page.evaluate(() => {
    const h = window.__shots;
    if (!h || typeof h.show !== 'function') return null;
    return (Array.isArray(h.screens) ? h.screens : []).map(s =>
      typeof s === 'string' ? { key: s, label: s } : { key: String(s.key), label: String(s.label || s.key) });
  });
}

async function discover(browser, url, req, dev, log) {
  const { ctx, page } = await makeContext(browser, { ...dev, scale: 1 }, req);  // scale 1: discovery only needs a rough look
  const warnings = [];
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    await settle(page, req.settleMs);

    // 1) explicit plan from the dashboard
    if (req.screens) {
      if (req.screens.length > MAX_SCREENS) warnings.push(`Plan has ${req.screens.length} screens; only the first ${MAX_SCREENS} are captured (per-run limit).`);
      const cands = req.screens.slice(0, MAX_SCREENS).map((s, i) => ({
        key: slug(s.key || s.label, 'screen-' + (i + 1)), label: String(s.label || s.key || ''), source: 'plan',
        steps: Array.isArray(s.steps) ? s.steps : [], depth: (Array.isArray(s.steps) ? s.steps.length : 0)
      }));
      return { mode: 'plan', candidates: cands, warnings };
    }

    // 2) hook exposed by the app
    const hook = await rootHook(page);
    if (hook && hook.length) {
      if (hook.length > MAX_SCREENS) warnings.push(`App lists ${hook.length} screens; only the first ${MAX_SCREENS} are captured (per-run limit).`);
      const cands = hook.slice(0, MAX_SCREENS).map(h => ({ key: slug(h.key), label: h.label, source: 'hook', steps: [{ hook: h.key }], depth: 1 }));
      return { mode: 'hook', candidates: cands, warnings };
    }

    // 3) scan: breadth-first click-through, keep screens that look clearly different
    const accepted = [];        // { sig, cand }
    const clicked = new Set();  // selectors already tried
    const queue = [{ steps: [], depth: 0, label: 'start' }];
    let tries = 0;
    while (queue.length && accepted.length < req.maxCandidates && tries < req.maxTries && Date.now() < DEADLINE - 4 * 60 * 1000) {
      const node = queue.shift();
      tries++;
      let sig, info, blank;
      try {
        await openAndRun(page, url, node.steps, req);
        const buf = await page.screenshot({ type: 'png', animations: req.animations });
        sig = await signature(buf);
        blank = await isBlank(buf);
        info = await describePage(page);
      } catch (e) { log(`  skip step path (${node.label}): ${String(e.message).split('\n')[0]}`); continue; }

      const novel = !blank && accepted.every(a => diffFrac(a.sig, sig) >= req.minChange || textDist(a.tokens, info.tokens) >= 0.5);
      if (node.depth === 0 && blank) warnings.push('The first screen looks blank. The app may need more time to load (raise settleMs) or it failed to start.');
      if (novel) {
        const cand = {
          key: slug(info.name || info.title || (info.hint || '').split(' ').slice(0, 3).join(' ') || info.docTitle, 'screen-' + (accepted.length + 1)),
          label: info.title || info.name || (info.hint || '').split(' ').slice(0, 4).join(' ') || info.docTitle || '', title: info.title, hint: info.hint,
          source: 'scan', steps: node.steps, depth: node.depth
        };
        accepted.push({ sig, cand, tokens: info.tokens });
        log(`  + screen "${cand.key}" (depth ${node.depth}, ${accepted.length} so far)`);
      }
      // expand from every reachable state, not only from "new-looking" screens: a tab or menu click
      // often changes little of the picture but reveals new buttons.
      if (node.depth < req.maxDepth) {
        for (const c of await listClickables(page, req)) {
          if (clicked.has(c.sel)) continue;
          clicked.add(c.sel);
          queue.push({ steps: [...node.steps, { click: c.sel }], depth: node.depth + 1, label: c.label || c.sel });
        }
      }
    }
    if (!accepted.length && !warnings.length) warnings.push('No usable screens were found by scanning.');
    return { mode: 'scan', candidates: accepted.map(a => a.cand), warnings };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ----------------------------------------------------------------- capture */

async function main() {
  const log = m => console.log(m);
  const startedAt = new Date().toISOString();
  const manifest = {
    version: 1, ok: false, error: null, job: JOB || null, startedAt, finishedAt: null, mode: null, entry: null,
    devices: [], screens: [], skipped: [], warnings: [], stats: {}
  };
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT_THUMBS, { recursive: true });
  await fs.mkdir(OUT_FULL, { recursive: true });

  let server, browser;
  try {
    let raw = {};
    try { raw = JSON.parse(await fs.readFile(path.join(INPUT, 'request.json'), 'utf8')); }
    catch (e) { manifest.warnings.push(`${INPUT_LABEL}/request.json missing or invalid: using defaults.`); }
    const { req, warnings } = normalizeRequest(raw);
    manifest.warnings.push(...warnings);
    manifest.entry = req.entry;
    manifest.devices = req.devices;
    if (!req.devices.length) throw new Error('No usable device sizes in request.json.');

    const entryFile = path.normalize(path.join(INPUT, req.entry));
    if (!entryFile.startsWith(INPUT + path.sep)) throw new Error('entry must stay inside the input folder.');
    await fs.access(entryFile).catch(() => { throw new Error(`HTML entry file not found: ${INPUT_LABEL}/${req.entry}`); });

    const srv = await startServer(INPUT);
    server = srv.server;
    const url = `http://127.0.0.1:${srv.port}/${req.entry.split('/').map(encodeURIComponent).join('/')}`;

    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

    log(`Discovering screens (${req.devices[0].id} ${req.devices[0].width}x${req.devices[0].height})...`);
    const found = await discover(browser, url, req, req.devices[0], log);
    manifest.mode = found.mode;
    manifest.warnings.push(...found.warnings);

    // unique keys
    const used = new Set();
    for (const c of found.candidates) {
      let k = c.key, n = 2;
      while (used.has(k)) k = `${c.key}-${n++}`;
      c.key = k; used.add(k);
    }
    log(`Mode: ${found.mode}. Candidates: ${found.candidates.length}`);

    const byKey = new Map();
    for (const c of found.candidates) byKey.set(c.key, { key: c.key, label: c.label, title: c.title || '', hint: c.hint || '', source: c.source, depth: c.depth, steps: c.steps, files: {} });

    for (const dev of req.devices) {
      log(`Capturing on ${dev.id} (${dev.width}x${dev.height} @${dev.scale}x -> ${dev.pixelWidth}x${dev.pixelHeight}px)`);
      const { ctx, page } = await makeContext(browser, dev, req);
      const sigs = [];
      try {
        for (const c of found.candidates) {
          if (Date.now() > DEADLINE) { manifest.skipped.push({ key: c.key, device: dev.id, reason: 'time budget reached' }); continue; }
          try {
            await openAndRun(page, url, c.steps, req);
            const shot = await page.screenshot({ type: 'png', animations: req.animations });
            if (await isBlank(shot)) { manifest.skipped.push({ key: c.key, device: dev.id, reason: 'blank screenshot' }); continue; }
            const png = await sharp(shot).flatten({ background: '#ffffff' }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();
            const meta = await sharp(png).metadata();
            const thumb = await sharp(png).resize({ width: 320 }).jpeg({ quality: 72 }).toBuffer();
            const name = `${c.key}__${dev.id}`;
            await fs.writeFile(path.join(OUT_FULL, name + '.png'), png);
            await fs.writeFile(path.join(OUT_THUMBS, name + '.jpg'), thumb);
            // what the AI can click from this screen (helps it repair a plan in round 2); first device only
            let buttons;
            if (dev === req.devices[0]) { try { buttons = await listClickables(page, req); } catch (e) { /* optional */ } }
            const sig = await signature(png);
            const twin = sigs.find(s => diffFrac(s.sig, sig) < 0.02);
            sigs.push({ key: c.key, sig });
            byKey.get(c.key).files[dev.id] = {
              full: name + '.png', thumb: 'thumbs/' + name + '.jpg', width: meta.width, height: meta.height, bytes: png.length,
              ...(twin ? { looksLike: twin.key } : {})
            };
            if (buttons) byKey.get(c.key).buttons = buttons;
          } catch (e) {
            manifest.skipped.push({ key: c.key, device: dev.id, reason: String(e.message).split('\n')[0].slice(0, 160) });
          }
        }
      } finally { await ctx.close().catch(() => {}); }
    }

    manifest.screens = [...byKey.values()].filter(s => Object.keys(s.files).length > 0);
    if (!manifest.screens.length) throw new Error('No screens could be captured.');
    manifest.ok = true;
    manifest.stats = {
      screens: manifest.screens.length,
      images: manifest.screens.reduce((n, s) => n + Object.keys(s.files).length, 0),
      skipped: manifest.skipped.length
    };
  } catch (e) {
    manifest.error = String(e && e.message || e).slice(0, 300);
    console.error('ERROR:', manifest.error);
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(OUT_PREVIEW, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
  console.log(manifest.ok ? `Done: ${manifest.stats.screens} screens, ${manifest.stats.images} images.` : 'Failed.');
  process.exit(manifest.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
