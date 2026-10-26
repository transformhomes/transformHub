// Local data store for Tasks and Calendar.
// Plain JSON on this laptop's drive. Every save keeps the previous good copy as data.json.bak,
// writes via a temp file + rename so a crash mid-save cannot leave a half-written file,
// and a corrupt file is set aside (never silently overwritten) on the next start.
const fs = require('fs');
const path = require('path');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ITEMS = 20000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function normaliseTask(t) {
  if (!t || typeof t !== 'object') return null;
  const title = str(t.title, 500).trim();
  const id = str(t.id, 100);
  if (!title || !id) return null;
  return {
    id,
    title,
    done: t.done === true,
    project: typeof t.project === 'string' && t.project ? t.project.slice(0, 100) : null,
    due: DATE_RE.test(t.due) ? t.due : '',
    created: Number.isFinite(t.created) ? t.created : Date.now(),
    doneAt: Number.isFinite(t.doneAt) ? t.doneAt : null,
  };
}

function normaliseEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const title = str(e.title, 300).trim();
  const id = str(e.id, 100);
  if (!title || !id || !DATE_RE.test(e.date)) return null;
  const allDay = e.allDay === true;
  const start = !allDay && TIME_RE.test(e.start) ? e.start : '';
  const end = !allDay && start && TIME_RE.test(e.end) ? e.end : '';
  return { id, title, date: e.date, allDay: allDay || !start, start, end };
}

function normalise(d) {
  const src = d && typeof d === 'object' ? d : {};
  const list = (arr, fn) => (Array.isArray(arr) ? arr.slice(0, MAX_ITEMS).map(fn).filter(Boolean) : []);
  return {
    version: 1,
    tasks: list(src.tasks, normaliseTask),
    events: list(src.events, normaliseEvent),
    focusProject: typeof src.focusProject === 'string' && src.focusProject ? src.focusProject.slice(0, 100) : null,
  };
}

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'data.json');
  const bak = file + '.bak';
  const tmp = file + '.tmp';
  let lastGoodJson = null;

  function tryRead(p) {
    return normalise(JSON.parse(fs.readFileSync(p, 'utf8')));
  }

  function load() {
    for (const p of [file, bak]) {
      if (!fs.existsSync(p)) continue;
      try {
        const d = tryRead(p);
        if (p === bak) {
          // main file was bad or missing: restore it from the backup right away
          fs.writeFileSync(file, JSON.stringify(d, null, 2));
        }
        lastGoodJson = JSON.stringify(d, null, 2);
        return d;
      } catch (err) {
        console.error('Could not read', p, '-', err.message);
        try { fs.copyFileSync(p, p + '.corrupt-' + Date.now()); } catch { /* best effort */ }
      }
    }
    return normalise({});
  }

  let data = load();

  function persist() {
    const json = JSON.stringify(data, null, 2);
    if (lastGoodJson) fs.writeFileSync(bak, lastGoodJson);
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
    lastGoodJson = json;
  }

  return {
    file,
    get: () => data,
    update(patch) {
      const p = patch && typeof patch === 'object' ? patch : {};
      const next = normalise({
        tasks: 'tasks' in p ? p.tasks : data.tasks,
        events: 'events' in p ? p.events : data.events,
        focusProject: 'focusProject' in p ? p.focusProject : data.focusProject,
      });
      data = next;
      persist();
      return data;
    },
  };
}

module.exports = { createStore, normalise };
