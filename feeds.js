// Read-only calendar feeds (ICS links, for example a published Outlook calendar).
//
// Privacy rules for this file:
//  - the feed URL is a secret; it is never logged, never sent to the pages, never written to the cache
//  - only title, date and time are kept from each event (no attendees, notes or locations)
//  - error messages have any link stripped out before they are shown
const fs = require('fs');
const path = require('path');
const ICAL = require('ical.js');

const MAX_EVENTS = 5000;
const MAX_OCCURRENCES_PER_SERIES = 2000;
const MAX_ALLDAY_SPAN_DAYS = 31;
const MAX_FEED_BYTES = 15 * 1024 * 1024;

const pad2 = (n) => String(n).padStart(2, '0');
const localYmd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const localHm = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
const timeYmd = (t) => t.year + '-' + pad2(t.month) + '-' + pad2(t.day);

function addDaysYmd(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return localYmd(dt);
}

function cleanTitle(item) {
  const t = String(item.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return t || '(No title)';
}

function isCancelled(item) {
  const st = item.component.getFirstPropertyValue('status');
  return typeof st === 'string' && st.toUpperCase() === 'CANCELLED';
}

// Turn one occurrence into one or more simple events (all-day events spanning days become one per day).
function occurrenceEvents(item, startT, endT, key) {
  if (!startT) return [];
  const title = cleanTitle(item);
  const out = [];
  if (startT.isDate) {
    const first = timeYmd(startT);
    const endExclusive = endT ? timeYmd(endT) : addDaysYmd(first, 1);
    let day = first;
    for (let i = 0; i < MAX_ALLDAY_SPAN_DAYS && day < endExclusive; i++) {
      out.push({ id: key + ':' + day, title, date: day, allDay: true, start: '', end: '' });
      day = addDaysYmd(day, 1);
    }
    if (!out.length) out.push({ id: key + ':' + first, title, date: first, allDay: true, start: '', end: '' });
    return out;
  }
  const s = startT.toJSDate();
  const e = endT ? endT.toJSDate() : null;
  const date = localYmd(s);
  const sameDay = e && localYmd(e) === date && e > s;
  out.push({ id: key + ':' + date + ':' + localHm(s), title, date, allDay: false, start: localHm(s), end: sameDay ? localHm(e) : '' });
  return out;
}

// Parse ICS text into simple events that start between `from` and `to` (JS Dates).
function parseIcs(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(String(text)));

  // Use the timezone definitions inside the file so Outlook's Windows zone names resolve correctly.
  ICAL.TimezoneService.reset();
  root.getAllSubcomponents('vtimezone').forEach((tz) => {
    try { ICAL.TimezoneService.register(tz); } catch { /* unknown zone: falls back to floating time */ }
  });

  const masters = new Map();
  const standalone = [];
  const exceptions = [];
  for (const v of root.getAllSubcomponents('vevent')) {
    let ev;
    try { ev = new ICAL.Event(v); } catch { continue; }
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else if (ev.isRecurring()) masters.set(ev.uid, ev);
    else standalone.push(ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else standalone.push(ex); // exception whose series is not in the feed: show it on its own
  }

  const events = [];
  const push = (list) => { for (const e of list) { if (events.length < MAX_EVENTS) events.push(e); } };

  for (const ev of standalone) {
    if (isCancelled(ev)) continue;
    const s = ev.startDate;
    if (!s) continue;
    const jsStart = s.toJSDate();
    // an all-day or multi-day event that began earlier can still overlap the window; keep it simple and include if it ends in or after the window
    const jsEnd = ev.endDate ? ev.endDate.toJSDate() : jsStart;
    if (jsEnd < from || jsStart > to) continue;
    push(occurrenceEvents(ev, s, ev.endDate, ev.uid));
  }

  for (const master of masters.values()) {
    let it;
    try { it = master.iterator(); } catch { continue; }
    let next;
    let n = 0;
    try {
      while ((next = it.next()) && n++ < MAX_OCCURRENCES_PER_SERIES) {
        const jsStart = next.toJSDate();
        if (jsStart > to) break;
        const d = master.getOccurrenceDetails(next);
        const item = d.item || master;
        if (isCancelled(item)) continue;
        const jsEnd = d.endDate ? d.endDate.toJSDate() : jsStart;
        if (jsEnd < from) continue;
        push(occurrenceEvents(item, d.startDate, d.endDate, master.uid));
      }
    } catch { /* a broken series should not stop the rest of the feed */ }
  }

  // de-duplicate on id, keep a stable order
  const seen = new Set();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function safeMessage(err) {
  const m = String((err && err.message) || err || 'Unknown error');
  return m.replace(/https?:\/\/\S+/gi, '[link]').slice(0, 160);
}

function validFeeds(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.url === 'string' && typeof f.name === 'string')
    .map((f) => ({ name: f.name.trim().slice(0, 40) || 'Calendar', url: f.url.trim() }))
    .filter((f) => {
      try { return new URL(f.url).protocol === 'https:'; } catch { return false; }
    })
    .slice(0, 5);
}

function createFeedService({ getFeeds, fetchText, cacheFile, onChange, daysBack = 60, daysForward = 400 }) {
  let doFetch = fetchText;
  // per feed index: { name, ok, updated, count, error, events }
  let state = { feeds: [] };
  let refreshing = null;

  try {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && Array.isArray(c.feeds)) state = { feeds: c.feeds.slice(0, 5) };
    }
  } catch { /* cache is optional */ }

  function publicState() {
    const feeds = getFeeds();
    const events = [];
    const status = feeds.map((f, i) => {
      const s = state.feeds[i] && state.feeds[i].name === f.name ? state.feeds[i] : null;
      if (s && Array.isArray(s.events)) s.events.forEach((e) => events.push({ ...e, source: f.name, readonly: true }));
      return { name: f.name, ok: s ? s.ok : null, updated: s ? s.updated : null, count: s ? s.count : 0, error: s ? s.error || '' : '' };
    });
    return { events, status, configured: feeds.length };
  }

  function saveCache() {
    if (!cacheFile) return;
    try {
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ feeds: state.feeds }));
      fs.renameSync(tmp, cacheFile);
    } catch { /* best effort */ }
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const feeds = getFeeds();
      const from = new Date(Date.now() - daysBack * 86400000);
      const to = new Date(Date.now() + daysForward * 86400000);
      const next = [];
      await Promise.all(feeds.map(async (f, i) => {
        const prev = state.feeds[i] && state.feeds[i].name === f.name ? state.feeds[i] : null;
        try {
          const text = await doFetch(f.url);
          if (typeof text !== 'string' || text.length > MAX_FEED_BYTES) throw new Error('Feed was empty or too large');
          if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar');
          const events = parseIcs(text, from, to);
          next[i] = { name: f.name, ok: true, updated: Date.now(), count: events.length, error: '', events };
        } catch (err) {
          next[i] = { name: f.name, ok: false, updated: prev ? prev.updated : null, count: prev ? prev.count : 0, error: safeMessage(err), events: prev ? prev.events : [] };
        }
      }));
      state = { feeds: next };
      saveCache();
      const pub = publicState();
      if (onChange) onChange(pub);
      return pub;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  return { refresh, get: publicState, setFetch(fn) { doFetch = fn; } };
}

module.exports = { createFeedService, parseIcs, validFeeds, safeMessage };
