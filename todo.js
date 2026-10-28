// Read-only Microsoft To Do sync (experimental).
//
// There is no public "published link" for To Do like there is for Outlook calendars, so this reads the
// To Do web page that the app is already signed in to (the same Microsoft session as the Inbox tab).
// It keeps only task titles and done/not-done. If Microsoft changes the page, the reader may find nothing:
// the Tasks page then says so and offers a short diagnostic (no task text) to help fix it.
const fs = require('fs');

const ROUTES = [
  { url: 'https://to-do.office.com/tasks/inbox', list: 'Tasks' },
  { url: 'https://to-do.office.com/tasks/planned', list: 'Planned' },
];

// Runs inside the To Do page. Must return plain JSON.
const EXTRACT_SOURCE = `(() => {
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  if (/login\\.microsoftonline|login\\.live|login\\.microsoft/i.test(location.hostname) ||
      document.querySelector('input[type=password],input[name=loginfmt]')) return { state: 'signin', tasks: [], diag: { host: location.hostname } };
  const CB = '[role=checkbox],input[type=checkbox],[aria-label*="mark as" i],[aria-label^="complete" i],button[class*=checkBox i]';
  const cands = [...document.querySelectorAll('[role=listitem],[role=option],[role=row],[role=treeitem],li,[data-testid*="task" i],[class*=taskItem i]')];
  const withCb = cands.filter((el) => el.querySelector(CB));
  const inner = withCb.filter((el) => !withCb.some((o) => o !== el && el.contains(o)));
  const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const DUE_LEAF = /^(overdue|today$|tomorrow$|yesterday$|(sun|mon|tues?|wed(nes)?|thu(rs?)?|fri|sat(ur)?)(day)?(,\\s.*)?$|\\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.? \\d{1,2})/i;
  const parseDue = (raw) => {
    let t = clean(raw);
    const overdue = /^overdue/i.test(t);
    t = t.replace(/^overdue,?\\s*/i, '');
    const base = new Date(); base.setHours(12, 0, 0, 0);
    let d = null;
    if (/^today$/i.test(t)) d = new Date(base);
    else if (/^tomorrow$/i.test(t)) { d = new Date(base); d.setDate(d.getDate() + 1); }
    else if (/^yesterday$/i.test(t)) { d = new Date(base); d.setDate(d.getDate() - 1); }
    else {
      let m = /(\\d{1,2})\\s+([A-Za-z]{3})[a-z]*(?:,?\\s+(\\d{4}))?/.exec(t), day, mon, yr;
      if (m) { day = +m[1]; mon = MON.indexOf(m[2].toLowerCase()); yr = m[3] ? +m[3] : null; }
      else { m = /([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?/.exec(t); if (m) { mon = MON.indexOf(m[1].toLowerCase()); day = +m[2]; yr = m[3] ? +m[3] : null; } }
      if (m && mon >= 0) {
        const y = yr || base.getFullYear();
        d = new Date(y, mon, day, 12);
        if (!yr) { const diff = (d - base) / 86400000; if (overdue && diff > 7) d = new Date(y - 1, mon, day, 12); else if (!overdue && diff < -200) d = new Date(y + 1, mon, day, 12); }
      } else {
        const w = DOW.indexOf(t.slice(0, 3).toLowerCase());
        if (w >= 0 && /^[A-Za-z]{3,9}$/.test(t)) { d = new Date(base); let diff = (w - d.getDay() + 7) % 7; if (overdue) diff = diff === 0 ? -7 : diff - 7; d.setDate(d.getDate() + diff); }
      }
    }
    return d ? { due: ymd(d), overdue } : null;
  };
  const tasks = [];
  for (const el of inner) {
    const cb = el.querySelector(CB);
    const label = clean(cb.getAttribute('aria-label'));
    const UI = /^(mark as|completed|not completed|important|add to my day|my day|tasks|planned)/i;
    const leafEls = [...el.querySelectorAll('*')].filter((n) => !n.children.length && n !== cb && !cb.contains(n) && clean(n.textContent));
    const leaves = leafEls.map((n) => clean(n.textContent));
    const lines = String(el.innerText || el.textContent || '').split(/\\n+/).map(clean).filter(Boolean);
    // A title can be split into several inner pieces (words, links, highlights), so one piece is not always the whole title.
    // Start from the first piece that is not a button label and widen to the surrounding box while that box holds
    // nothing but title (no checkbox, button, or due-date/step/list labels).
    const META = /^(due |today$|tomorrow$|yesterday$|overdue|repeat|my day|important|add to my day|tasks$|planned$|step|\\d+ of \\d+|reminder)/i;
    const first = leafEls.find((n) => !UI.test(clean(n.textContent)));
    let box = first || null;
    while (box && box.parentElement && box.parentElement !== el) {
      const p = box.parentElement;
      if (p.contains(cb) || p.querySelector('button,[role=button],[role=checkbox],input')) break;
      const hasOther = [...p.querySelectorAll('*')].some((n) => { if (n.children.length || box.contains(n)) return false; const c = clean(n.textContent); return META.test(c) || / category$/i.test(c) || DUE_LEAF.test(c); });
      if (hasOther) break;
      box = p;
    }
    const boxText = box ? clean(box.innerText || box.textContent) : '';
    let title = clean(el.getAttribute('aria-label'));
    if (!title || /^mark as/i.test(title)) title = (boxText && !UI.test(boxText) ? boxText : '') || leaves.find((l) => !UI.test(l)) || lines.find((l) => !UI.test(l)) || '';
    if (!title) continue;
    const done = cb.getAttribute('aria-checked') === 'true' || cb.checked === true || /mark as not completed/i.test(label);
    let due = '';
    if (!done) {
      const dl = leaves.find((l) => l !== title && !title.includes(l) && !UI.test(l) && DUE_LEAF.test(l));
      const pd = dl ? parseDue(dl) : null;
      if (pd) due = pd.due;
    }
    tasks.push({ title: title.slice(0, 300), done, due });
  }
  const roles = {};
  for (const r of ['listitem', 'option', 'row', 'checkbox', 'list', 'listbox', 'grid', 'tree', 'treeitem']) roles[r] = document.querySelectorAll('[role=' + r + ']').length;
  const GENERIC = /^(mark as|mark task|complete|completed|not completed|add |delete|more|important|due |repeat|my day|planned|assigned|flagged|all$|tasks$|new task)/i;
  const outline = [];
  if (!tasks.length) {
    const root = document.querySelector('main,[role=main]') || document.body;
    const seen = new Set();
    for (const n of root.querySelectorAll('[role],[aria-label],[data-testid],button,input,li,[aria-checked],[aria-selected]')) {
      if (outline.length >= 160) break;
      let depth = 0; for (let p = n.parentElement; p && p !== root && depth < 12; p = p.parentElement) depth++;
      const lab = n.getAttribute('aria-label');
      const line = ' '.repeat(Math.min(depth, 12)) + n.tagName.toLowerCase()
        + (n.getAttribute('role') ? '[role=' + n.getAttribute('role') + ']' : '')
        + (n.getAttribute('data-testid') ? '[testid=' + n.getAttribute('data-testid').slice(0, 40) + ']' : '')
        + (typeof n.className === 'string' && n.className ? '.' + n.className.split(/\s+/).slice(0, 2).join('.').slice(0, 50) : '')
        + (n.hasAttribute('aria-checked') ? '[checked=' + n.getAttribute('aria-checked') + ']' : '')
        + (n.hasAttribute('aria-selected') ? '[selected=' + n.getAttribute('aria-selected') + ']' : '')
        + (lab ? (GENERIC.test(lab) ? '[label=' + lab.slice(0, 30) + ']' : '[label:len' + lab.length + ']') : '')
        + '[textlen=' + clean(n.textContent).length + ']';
      const key = line.trim();
      if (seen.has(key) && outline.length > 40) continue;
      seen.add(key);
      outline.push(line);
    }
  }
  return { state: tasks.length ? 'ok' : 'none', tasks, diag: { outline,  path: location.pathname, title: clean(document.title).slice(0, 60), candidates: cands.length, withCheckbox: withCb.length, innermost: inner.length, roles } };
})()`;

// Same reader, but also ticks the first open task whose title matches. Runs inside the To Do page.
function completeSource(title) {
  const a = '(() => {';
  const b = "    tasks.push({ title: title.slice(0, 300), done, due });";
  if (!EXTRACT_SOURCE.includes(a) || !EXTRACT_SOURCE.includes(b)) throw new Error('reader changed');
  let src = EXTRACT_SOURCE.replace(a, a + '\n  const WANT = ' + JSON.stringify(String(title).slice(0, 300)) + '; let clicked = false;');
  src = src.replace(b, "    if (!done && !clicked && title.slice(0, 300) === WANT) { cb.click(); clicked = true; }\n" + b);
  src = src.replace("return { state: tasks.length ? 'ok' : 'none', tasks,", "return { clicked, state: tasks.length ? 'ok' : 'none', tasks,");
  return src;
}

function merge(results) {
  const tasks = [];
  const seen = new Set();
  let state = 'none';
  const diag = [];
  for (const { list, result } of results) {
    if (!result) continue;
    diag.push({ list, state: result.state, ...result.diag });
    if (result.state === 'signin') state = 'signin';
    else if (result.state === 'ok' && state !== 'signin') state = 'ok';
    for (const t of result.tasks || []) {
      const key = t.title.toLowerCase() + '|' + t.done;
      if (seen.has(key)) { const prev = tasks.find((x) => x.title.toLowerCase() + '|' + x.done === key); if (prev && !prev.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due || '')) prev.due = t.due; continue; }
      seen.add(key);
      tasks.push({ id: 'todo:' + tasks.length + ':' + t.title.slice(0, 20), title: t.title, done: !!t.done, due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '', list });
    }
  }
  return { state, tasks: tasks.slice(0, 500), diag };
}

function createTodoSync({ scrape, cacheFile, onChange }) {
  let state = { updated: null, ok: null, status: 'idle', tasks: [], diag: [] };
  let running = null;
  try {
    if (cacheFile && fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && Array.isArray(c.tasks)) state = { updated: c.updated || null, ok: c.ok ?? null, status: c.status || 'idle', tasks: c.tasks.slice(0, 500), diag: Array.isArray(c.diag) ? c.diag : [] };
    }
  } catch { /* cache is optional */ }

  function persist() {
    if (!cacheFile) return;
    try { fs.writeFileSync(cacheFile + '.tmp', JSON.stringify(state)); fs.renameSync(cacheFile + '.tmp', cacheFile); } catch { /* best effort */ }
  }

  async function refresh() {
    if (running) return running;
    running = (async () => {
      try {
        const results = await scrape(ROUTES, EXTRACT_SOURCE);
        const m = merge(results);
        if (m.state === 'signin') state = { ...state, ok: false, status: 'signin', diag: m.diag };
        else if (m.state === 'ok') state = { updated: Date.now(), ok: true, status: 'ok', tasks: m.tasks, diag: m.diag };
        else state = { ...state, ok: false, status: 'unreadable', diag: m.diag }; // keep the last good tasks
      } catch {
        state = { ...state, ok: false, status: 'error' };
      }
      persist();
      if (onChange) onChange(publicState());
      return publicState();
    })().finally(() => { running = null; });
    return running;
  }

  function publicState() { return { updated: state.updated, ok: state.ok, status: state.status, tasks: state.tasks, diag: state.diag }; }
  return { refresh, get: publicState };
}

module.exports = { createTodoSync, merge, EXTRACT_SOURCE, completeSource, ROUTES };
