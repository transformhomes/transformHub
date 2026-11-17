// Morning Brief reader (read-only, experimental).
//
// Reads today's "Morning Brief" email from Outlook on the web, using the Microsoft session the app is already
// signed in to (the same hidden window the To Do reader uses). It opens the Inbox, finds the newest message whose
// subject contains "Morning Brief" (searching for it if it is not in the visible list), opens it, and keeps the
// message body. Nothing is sent, deleted or moved. Opening a message in Outlook marks it as read.
//
// If Microsoft changes the page, the reader may find nothing: the Home card then says so, and keeps showing the
// last brief it read.
const fs = require('fs');

const WORD = 'Morning Brief';
const MAX_HTML = 1500 * 1024;
const FORMAT = 2; // 2 = the email's own look is kept (styles written onto each element)

// "Morning Brief - 12 November 2026" -> "2026-11-12"
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseBriefDate(text) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(String(text || ''));
  if (!m) return '';
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return '';
  return m[3] + '-' + String(mon + 1).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0');
}

// ---- snippets that run inside the Outlook page; each returns plain JSON ----
const STATE_SOURCE = `(() => {
  if (/login\\.microsoftonline|login\\.live|login\\.microsoft/i.test(location.hostname) ||
      document.querySelector('input[type=password],input[name=loginfmt]')) return { signin: true, items: 0 };
  const items = document.querySelectorAll('[role=option],[data-convid],[role=listitem]').length;
  return { signin: false, items, host: location.hostname };
})()`;

// Finds the newest message in the visible list whose text mentions the word, and opens it.
function pickSource(word) {
  return `(() => {
  const WORD = ${JSON.stringify(word)}.toLowerCase();
  const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const dateOf = (t) => { const m = /(\\d{1,2})\\s+([A-Za-z]{3})[a-z]*\\.?,?\\s+(\\d{4})/.exec(t); const mo = m ? MON.indexOf(m[2].toLowerCase()) : -1; return m && mo >= 0 ? +m[3] * 10000 + (mo + 1) * 100 + (+m[1]) : 0; };
  const all = [...document.querySelectorAll('[role=option],[data-convid],[role=listitem]')];
  const hits = all.filter((el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).toLowerCase().includes(WORD));
  const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  if (!inner.length) return { found: false, listed: all.length };
  inner.sort((a, b) => dateOf((b.getAttribute('aria-label') || '') + ' ' + b.innerText) - dateOf((a.getAttribute('aria-label') || '') + ' ' + a.innerText));
  const el = inner[0];
  const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).replace(/\\s+/g, ' ').trim().slice(0, 400);
  el.scrollIntoView({ block: 'center' });
  for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  return { found: true, label, listed: all.length, matches: inner.length };
})()`;
}

const FOCUS_SEARCH_SOURCE = `(() => {
  const sel = '#topSearchInput, input[aria-label^="Search" i], input[placeholder^="Search" i], [role=search] input';
  let box = document.querySelector(sel);
  if (!box) {
    const b = document.querySelector('button[aria-label^="Search" i], [role=search] button, [aria-label="Search" i]');
    if (b) { b.click(); }
    return { focused: false, clicked: !!b };
  }
  box.focus(); box.select && box.select();
  return { focused: true };
})()`;

// Reads the message body that is open in the reading pane.
// The email's look comes from Outlook's page styles, so each element's finished style (colours, fonts, spacing,
// borders) is written onto a copy of it. The copy then looks the same wherever it is shown.
function bodySource(word) {
  return `(() => {
  const WORD = ${JSON.stringify(word)}.toLowerCase();
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const cands = [...document.querySelectorAll('[id^=UniqueMessageBody],[aria-label="Message body" i],[role=document],[class*=ReadingPaneContent i]')];
  let best = null, bestLen = 0;
  for (const el of cands) { const n = clean(el.innerText).length; if (n > bestLen) { best = el; bestLen = n; } }
  if (!best || bestLen < 150) return { ready: false, len: bestLen, cands: cands.length };
  const text = clean(best.innerText);
  const head = [...document.querySelectorAll('[role=heading],[data-testid*=subject i],[class*=subject i]')].map((n) => clean(n.innerText)).find((t) => t && t.toLowerCase().includes(WORD)) || '';
  const INHERIT = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align', 'letter-spacing', 'text-transform', 'white-space', 'list-style-type', 'border-collapse'];
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const BLOCK = /^(div|p|h[1-6]|ul|ol|blockquote|pre|hr|section|article|center|header|footer|main|nav|aside|figure|address|dl|dt|dd|form|fieldset)$/;
  const TABLE = { table: 'table', tbody: 'table-row-group', thead: 'table-header-group', tfoot: 'table-footer-group', tr: 'table-row', td: 'table-cell', th: 'table-cell', col: 'table-column', colgroup: 'table-column-group', caption: 'table-caption', li: 'list-item' };
  const styleOf = (el, isRoot) => {
    const cs = getComputedStyle(el);
    const ps = !isRoot && el.parentElement ? getComputedStyle(el.parentElement) : null;
    const out = [];
    for (const p of INHERIT) { const v = cs.getPropertyValue(p); if (v && (!ps || ps.getPropertyValue(p) !== v)) out.push(p + ':' + v); }
    const bg = cs.backgroundColor; if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') out.push('background-color:' + bg);
    const bi = cs.backgroundImage; if (bi && /gradient\\(/.test(bi) && !/url\\(/.test(bi)) out.push('background-image:' + bi);
    out.push('margin:' + SIDES.map((s) => cs.getPropertyValue('margin-' + s)).join(' '));
    out.push('padding:' + SIDES.map((s) => cs.getPropertyValue('padding-' + s)).join(' '));
    for (const s of SIDES) { const w = cs.getPropertyValue('border-' + s + '-width'), st = cs.getPropertyValue('border-' + s + '-style'); if (st && st !== 'none' && parseFloat(w) > 0) out.push('border-' + s + ':' + w + ' ' + st + ' ' + cs.getPropertyValue('border-' + s + '-color')); }
    const br = cs.borderRadius; if (br && br !== '0px') out.push('border-radius:' + br);
    const td = cs.textDecorationLine; if (td && td !== 'none') out.push('text-decoration:' + td);
    const va = cs.verticalAlign; if (va && va !== 'baseline') out.push('vertical-align:' + va);
    const bs = cs.boxShadow; if (bs && bs !== 'none') out.push('box-shadow:' + bs);
    const op = cs.opacity; if (op && op !== '1') out.push('opacity:' + op);
    const mw = cs.maxWidth; if (mw && mw !== 'none') out.push('max-width:' + mw);
    const tag = el.tagName.toLowerCase();
    const d = cs.display, def = TABLE[tag] || (BLOCK.test(tag) ? 'block' : 'inline');
    if (d && d !== def) out.push('display:' + d);
    if (/flex/.test(d)) { for (const p of ['flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap']) out.push(p + ':' + cs.getPropertyValue(p)); }
    if (ps && /flex/.test(ps.display)) out.push('flex:' + cs.flexGrow + ' ' + cs.flexShrink + ' ' + cs.flexBasis);
    if (tag === 'table' && el.parentElement && el.offsetWidth >= el.parentElement.clientWidth - 2) out.push('width:100%');
    if (tag === 'table') out.push('border-spacing:' + cs.borderSpacing);
    if (tag === 'td' || tag === 'th') { const row = el.parentElement; if (row && row.offsetWidth > 0 && row.children.length > 1) out.push('width:' + Math.round(el.offsetWidth / row.offsetWidth * 1000) / 10 + '%'); }
    return out.join(';');
  };
  const copy = best.cloneNode(true);
  const live = [best, ...best.querySelectorAll('*')];
  const dup = [copy, ...copy.querySelectorAll('*')];
  let styled = 0;
  if (live.length === dup.length && live.length <= 8000) {
    for (let i = 0; i < live.length; i++) {
      const tag = live[i].tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') continue;
      try { dup[i].setAttribute('style', styleOf(live[i], i === 0)); styled++; } catch (e) { /* keep the element as it is */ }
    }
  }
  copy.removeAttribute('id');
  return { ready: true, len: bestLen, cands: cands.length, styled, mentions: text.toLowerCase().includes(WORD), subject: head.slice(0, 200), html: copy.outerHTML.slice(0, ${MAX_HTML}) };
})()`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Drives the hidden Outlook window. wc is the window's webContents.
async function drive(wc, url, opts = {}) {
  const word = opts.word || WORD;
  const t0 = Date.now();
  const left = (ms) => Math.max(0, ms - (Date.now() - t0));
  const diag = { steps: [] };
  const note = (s) => diag.steps.push(s + '@' + Math.round((Date.now() - t0) / 1000) + 's');

  await wc.loadURL(url);
  note('loaded');

  // 1. wait for the message list (or the sign-in page)
  let st = null;
  while (left(30000)) {
    await sleep(700);
    st = await wc.executeJavaScript(STATE_SOURCE);
    if (st && (st.signin || st.items > 0)) break;
  }
  if (!st || st.signin) return { state: st ? 'signin' : 'unreadable', diag };
  if (!st.items) { note('no list'); return { state: 'unreadable', diag }; }
  note('list ' + st.items);

  // 2. find the brief in the list; if it is not listed, search for it
  let pick = await wc.executeJavaScript(pickSource(word));
  if (!pick || !pick.found) {
    note('not in list, searching');
    let f = await wc.executeJavaScript(FOCUS_SEARCH_SOURCE);
    if (f && !f.focused && f.clicked) { await sleep(1200); f = await wc.executeJavaScript(FOCUS_SEARCH_SOURCE); }
    if (f && f.focused) {
      await wc.insertText(word);
      await sleep(400);
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        await sleep(700);
        pick = await wc.executeJavaScript(pickSource(word));
        if (pick && pick.found) break;
      }
    } else note('no search box');
  }
  if (!pick || !pick.found) { note('not found'); return { state: 'notfound', diag }; }
  note('opened (' + pick.matches + ' match' + (pick.matches === 1 ? '' : 'es') + ')');

  // 3. wait for the message body to appear in the reading pane
  let body = null;
  while (left(55000)) {
    await sleep(700);
    body = await wc.executeJavaScript(bodySource(word));
    if (body && body.ready && (body.mentions || /brief/i.test(body.subject || ''))) break;
  }
  if (!body || !body.ready) { note('no body'); return { state: 'unreadable', diag }; }
  if (!body.mentions && !/brief/i.test(body.subject || '')) { note('body does not look like the brief'); return { state: 'unreadable', diag }; }
  const subject = body.subject || pick.label || '';
  const dateText = (/Morning Brief[^\d]{0,6}(\d{1,2}\s+[A-Za-z]+\.?,?\s+\d{4})/i.exec(subject) || /Morning Brief[^\d]{0,6}(\d{1,2}\s+[A-Za-z]+\.?,?\s+\d{4})/i.exec(pick.label || '') || [])[1] || subject || pick.label || '';
  const m = /Morning Brief[^\n]{0,40}?\d{4}/i.exec(subject) || /Morning Brief[^\n]{0,40}?\d{4}/i.exec(pick.label || '');
  note('styled ' + (body.styled || 0));
  return { state: 'ok', subject: (m ? m[0] : 'Morning Brief').slice(0, 120), date: parseBriefDate(dateText), html: body.html, diag };
}

function createBrief({ scrape, cacheFile, onChange }) {
  let state = { updated: null, ok: null, status: 'idle', subject: '', date: '', html: '', fmt: 0, diag: [] };
  let running = null;
  try {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && typeof c.html === 'string') state = { updated: c.updated || null, ok: c.ok ?? null, status: c.status || 'idle', subject: String(c.subject || ''), date: String(c.date || ''), html: c.html.slice(0, MAX_HTML), fmt: c.fmt || 0, diag: Array.isArray(c.diag) ? c.diag : [] };
    }
  } catch { /* cache is optional */ }

  function persist() {
    if (!cacheFile) return;
    try { fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(state)); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch { /* best effort */ }
  }
  const publicState = () => ({ updated: state.updated, ok: state.ok, status: state.status, subject: state.subject, date: state.date, html: state.html, fmt: state.fmt || 0, diag: state.diag });

  async function refresh() {
    if (running) return running;
    running = (async () => {
      try {
        const r = await scrape();
        const diag = r && r.diag ? r.diag.steps : [];
        if (r && r.state === 'ok' && r.html) {
          // never replace a newer brief with an older one
          if (state.fmt === FORMAT && state.date && r.date && r.date < state.date) state = { ...state, ok: true, status: 'ok', updated: Date.now(), diag };
          else state = { updated: Date.now(), ok: true, status: 'ok', subject: r.subject, date: r.date, html: r.html, fmt: FORMAT, diag };
        } else state = { ...state, ok: false, status: (r && r.state) || 'error', diag }; // keep the last good brief
      } catch {
        state = { ...state, ok: false, status: 'error' };
      }
      persist();
      if (onChange) onChange(publicState());
      return publicState();
    })().finally(() => { running = null; });
    return running;
  }

  return { refresh, get: publicState };
}

module.exports = { createBrief, drive, parseBriefDate, WORD, FORMAT };
