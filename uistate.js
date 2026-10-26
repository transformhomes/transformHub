// Small remembered interface state: is the activity panel open, and which items were used recently.
const fs = require('fs');
const path = require('path');

const KEY_RE = /^[a-z]{2,10}:[\w.-]{1,60}$/i;

function normalise(s) {
  const src = s && typeof s === 'object' ? s : {};
  const recents = Array.isArray(src.recents) ? src.recents.filter((k) => typeof k === 'string' && KEY_RE.test(k)) : [];
  const theme = ['light', 'dark', 'system'].includes(src.theme) ? src.theme : 'system';
  return { theme, feedOpen: src.feedOpen !== false, recents: [...new Set(recents)].slice(0, 5) };
}

function createUiState(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ui-state.json');
  let state = normalise({});
  try { if (fs.existsSync(file)) state = normalise(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* start fresh */ }

  function persist() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch { /* best effort: losing this only forgets the panel state */ }
  }

  return {
    file,
    get: () => state,
    set(patch) { state = normalise({ ...state, ...patch }); persist(); return state; },
    pushRecent(key) {
      if (typeof key !== 'string' || !KEY_RE.test(key)) return state;
      state = normalise({ ...state, recents: [key, ...state.recents.filter((k) => k !== key)] });
      persist();
      return state;
    },
  };
}

module.exports = { createUiState, normalise, KEY_RE };
