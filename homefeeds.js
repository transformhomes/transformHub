// Weather and news for the Home page. Weather comes from Open-Meteo (free, no sign-up); news from the RSS links in the settings file.
// Only the Home page can ask for these; the app only reads the results and never runs anything from them.
const DEFAULT_LOCATION = { name: 'Thomastown 3074', lat: -37.6833, lon: 145.0167 }; // approximate centre of Thomastown, Victoria
// ABC feed numbers are from a third-party list of ABC's feeds (not checked from here): VIC top stories and Business.
const DEFAULT_FEEDS = [
  { name: 'ABC News (Vic)', url: 'https://www.abc.net.au/news/feed/5470430/rss.xml' },
  { name: 'The Guardian Australia', url: 'https://www.theguardian.com/australia-news/rss' },
];
const DEFAULT_FINANCE = [
  { name: 'ABC Business', url: 'https://www.abc.net.au/news/feed/104217374/rss.xml' },
  { name: 'The Guardian Business', url: 'https://www.theguardian.com/business/rss' },
];
const GIG_GUIDE_URL = 'https://beat.com.au/gig-guide/';
// Music news and Melbourne gigs. Beat Magazine's feed was checked and works; it has no pictures. The Guardian feed is unchecked (the checker could not reach it).
const DEFAULT_MUSIC = [
  { name: 'Beat Magazine', url: 'https://beat.com.au/feed/' },
  { name: 'The Guardian Music', url: 'https://www.theguardian.com/music/rss' },
];
// Beat's feed has a "Gig Guide" category; those stories are shown here. It is a feed of stories, not a full listing of every gig.
const DEFAULT_GIGS = [{ name: 'Beat Gig Guide', url: 'https://beat.com.au/feed/', category: 'gig' }];
const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 15 * 60 * 1000;

function validLocation(v) {
  if (!v || typeof v !== 'object') return DEFAULT_LOCATION;
  const lat = Number(v.lat), lon = Number(v.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return DEFAULT_LOCATION;
  return { name: String(v.name || 'Home').slice(0, 40), lat, lon };
}
function validFeeds(v, defaults = DEFAULT_FEEDS) {
  if (!Array.isArray(v)) return defaults;
  const out = [];
  for (const f of v.slice(0, 8)) {
    try {
      if (f && typeof f.url === 'string' && new URL(f.url).protocol === 'https:') out.push({ name: String(f.name || new URL(f.url).hostname).slice(0, 40), url: f.url, category: typeof f.category === 'string' ? f.category.slice(0, 30).toLowerCase() : '' });
    } catch { /* skipped */ }
  }
  return out.length ? out : (v.length ? defaults : []);
}

// WMO weather codes (as used by Open-Meteo) in plain words
function describe(code) {
  const c = Number(code);
  if (c === 0) return ['Clear sky', 'sun'];
  if (c === 1) return ['Mostly clear', 'sun'];
  if (c === 2) return ['Partly cloudy', 'partly'];
  if (c === 3) return ['Overcast', 'cloud'];
  if (c === 45 || c === 48) return ['Fog', 'fog'];
  if (c >= 51 && c <= 57) return ['Drizzle', 'rain'];
  if (c >= 61 && c <= 67) return ['Rain', 'rain'];
  if (c >= 71 && c <= 77) return ['Snow', 'snow'];
  if (c >= 80 && c <= 82) return ['Showers', 'rain'];
  if (c === 85 || c === 86) return ['Snow showers', 'snow'];
  if (c >= 95) return ['Thunderstorm', 'storm'];
  return ['Unknown', 'cloud'];
}

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function parseFeed(xml, source) {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const b of blocks.slice(0, 20)) {
    const pick = (tag) => { const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i')); return m ? decode(m[1]) : ''; };
    let link = pick('link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    const title = pick('title');
    // a picture for the headline, if the feed gives one (media:content, media:thumbnail, enclosure, or the first <img>)
    let image = '';
    const im = b.match(/<media:(?:content|thumbnail)[^>]*\burl="([^"]+)"/i) || b.match(/<enclosure[^>]*\burl="([^"]+)"[^>]*type="image\//i) || b.match(/<enclosure[^>]*type="image\/[^"]*"[^>]*\burl="([^"]+)"/i) || b.match(/&lt;img[^>]*\bsrc=(?:&quot;|")([^"&]+)/i) || b.match(/<img[^>]*\bsrc="([^"]+)"/i);
    if (im) { image = im[1].replace(/&amp;/g, '&'); try { if (new URL(image).protocol !== 'https:') image = ''; } catch { image = ''; } }
    const when = Date.parse(pick('pubDate') || pick('published') || pick('updated') || '');
    try { if (!title || new URL(link).protocol !== 'https:') continue; } catch { continue; }
    const cats = (b.match(/<category[^>]*>([\s\S]*?)<\/category>/gi) || []).map((c) => decode(c).toLowerCase()).slice(0, 12);
    items.push({ title: title.slice(0, 200), link, source, image, cats, when: Number.isFinite(when) ? when : 0 });
  }
  return items;
}

function createHomeFeeds({ net }) {
  const cache = new Map(); // key -> { at, value }
  let lastLinks = new Set();
  const lastImages = new Set();
  const imgCache = new Map();
  async function getText(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await net.fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'TransformWorkstation/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('Too large');
      return buf.toString('utf8');
    } finally { clearTimeout(timer); }
  }
  const cached = async (key, force, make) => {
    const hit = cache.get(key);
    if (hit && !force && Date.now() - hit.at < TTL) return hit.value;
    try {
      const value = await make();
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      if (hit) return { ...hit.value, stale: true };
      throw err;
    }
  };

  async function weather(locationCfg, force) {
    const loc = validLocation(locationCfg);
    try {
      return await cached('w:' + loc.lat + ',' + loc.lon, force, async () => {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon
          + '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=5';
        const j = JSON.parse(await getText(url));
        const d = j && j.daily;
        if (!j || !j.current || !d || !Array.isArray(d.time)) throw new Error('Unexpected reply');
        const [text, icon] = describe(j.current.weather_code);
        return {
          ok: true, place: loc.name, now: { temp: Math.round(j.current.temperature_2m), text, icon },
          days: d.time.slice(0, 5).map((date, i) => ({ date, max: Math.round(d.temperature_2m_max[i]), min: Math.round(d.temperature_2m_min[i]), icon: describe(d.weather_code[i])[1], text: describe(d.weather_code[i])[0] })),
        };
      });
    } catch (err) { return { ok: false, place: loc.name, error: 'Could not get the weather just now.' }; }
  }

  async function news(feedsCfg, force, defaults) {
    const feeds = validFeeds(feedsCfg, defaults || DEFAULT_FEEDS);
    if (!feeds.length) return { ok: true, off: true, items: [] };
    const all = [];
    let failed = 0;
    await Promise.all(feeds.map(async (f) => {
      try {
        const got = await cached('n:' + f.url, force, async () => ({ items: parseFeed(await getText(f.url), f.name) })).then((v) => v.items);
        const tagged = f.category ? got.filter((i) => (i.cats || []).some((c) => c.includes(f.category))) : got;
        all.push(...(f.category && !tagged.length ? got : tagged).map((i) => ({ ...i, source: f.name })));
      }
      catch { failed++; }
    }));
    // newest first, a few from each source so one feed does not crowd out the others
    all.sort((a, b) => b.when - a.when);
    const per = new Map(), items = [];
    for (const it of all) {
      const n = per.get(it.source) || 0;
      if (n >= 5) continue;
      per.set(it.source, n + 1);
      items.push(it);
    }
    items.sort((a, b) => b.when - a.when);
    items.forEach((i) => { lastLinks.add(i.link); if (i.image) lastImages.add(i.image); });
    return { ok: items.length > 0 || failed < feeds.length, items: items.slice(0, 12), failed };
  }
  const knownLink = (u) => lastLinks.has(u) || u === GIG_GUIDE_URL;

  // A headline picture, handed to the page as a small data: image (the page itself cannot reach the internet)
  async function image(url) {
    if (typeof url !== 'string' || !lastImages.has(url)) return null;
    if (imgCache.has(url)) return imgCache.get(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await net.fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'TransformWorkstation/1.0' } });
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 700 * 1024) return null;
      const out = 'data:' + type + ';base64,' + buf.toString('base64');
      if (imgCache.size >= 80) imgCache.delete(imgCache.keys().next().value);
      imgCache.set(url, out);
      return out;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  return { weather, news, knownLink, image };
}

// ---- Latest update from each project's own memory / log file ----
// Looks only in a few fixed places inside each project folder and shows the newest entry as written (nothing is made up).
const fs = require('fs');
const path = require('path');
const MEMORY_DIRS = ['08_Memory', 'Memory', 'memory', '.claude/memory'];
const MEMORY_FILES = ['persistent_memory_log.md', 'MEMORY.md', 'memory.md', 'CLAUDE.md'];
function stripMd(t) { return String(t).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>#]/g, '').replace(/^\s*[-+]\s+/, '').replace(/\s+/g, ' ').trim(); }
function latestEntry(text) {
  const lines = String(text).split(/\r?\n/);
  const isEntry = (l) => /^#{1,4}\s+\S/.test(l) || /^\s*[-*]\s+\**\[?\d{4}-\d{2}-\d{2}/.test(l) || /^\s*\d{4}-\d{2}-\d{2}/.test(l);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isEntry(lines[i])) continue;
    let out = stripMd(lines[i]);
    if (/^#{1,4}\s/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && j < i + 6; j++) { if (lines[j].trim() && !/^#{1,4}\s/.test(lines[j])) { out += ' — ' + stripMd(lines[j]); break; } }
    }
    if (out.length > 3) return out.slice(0, 180);
  }
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return stripMd(lines[i]).slice(0, 180);
  return '';
}
const updCache = new Map();
function projectUpdates(projects) {
  const out = [];
  for (const p of projects || []) {
    if (!p || !p.id || !p.path) continue;
    const hit = updCache.get(p.id);
    if (hit && Date.now() - hit.at < 60000) { if (hit.value) out.push(hit.value); continue; }
    let best = null;
    const consider = (file) => {
      try { const st = fs.statSync(file); if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs, size: st.size }; } catch { /* not there */ }
    };
    for (const f of MEMORY_FILES) consider(path.join(p.path, f));
    for (const d of MEMORY_DIRS) {
      try { for (const n of fs.readdirSync(path.join(p.path, d)).slice(0, 60)) if (/\.md$/i.test(n)) consider(path.join(p.path, d, n)); } catch { /* no such folder */ }
    }
    let value = null;
    if (best) {
      try {
        const fd = fs.openSync(best.file, 'r');
        const len = Math.min(best.size, 48 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, best.size - len);
        fs.closeSync(fd);
        value = { id: p.id, file: path.basename(best.file), mtime: best.mtime, text: latestEntry(buf.toString('utf8')) };
      } catch { value = null; }
    }
    updCache.set(p.id, { at: Date.now(), value });
    if (value) out.push(value);
  }
  return out;
}

module.exports = { DEFAULT_MUSIC, DEFAULT_GIGS, GIG_GUIDE_URL, projectUpdates, latestEntry, DEFAULT_FINANCE, createHomeFeeds, parseFeed, describe, validFeeds, validLocation };
