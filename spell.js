// Spell checking for every page in the hub: Australian English by default, red underlines (Chromium does those),
// and a right-click menu with suggestions and "Add to dictionary".
const FALLBACKS = ['en-AU', 'en-GB', 'en-US'];
const CODE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

// Choose the dictionaries to use: the ones asked for in the settings if they exist, otherwise the first English one available.
function pickLanguages(available, wanted) {
  const have = new Set((available || []).map(String));
  const want = (Array.isArray(wanted) ? wanted : []).filter((c) => typeof c === 'string' && CODE.test(c)).slice(0, 4);
  const chosen = want.filter((c) => have.has(c));
  if (chosen.length) return chosen;
  const fb = FALLBACKS.find((c) => have.has(c));
  return fb ? [fb] : [];
}

function setupSpellcheck(ses, wanted) {
  try {
    const langs = pickLanguages(ses.availableSpellCheckerLanguages, wanted);
    if (langs.length) ses.setSpellCheckerLanguages(langs);
    ses.setSpellCheckerEnabled(true);
    return langs;
  } catch { return []; }
}

// The spelling part of a context menu: suggestions for the word under the cursor, and Add to dictionary.
function spellingItems(wc, p) {
  const word = p && typeof p.misspelledWord === 'string' ? p.misspelledWord : '';
  if (!word) return [];
  const sugg = (Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : []).slice(0, 5);
  const items = sugg.length
    ? sugg.map((s) => ({ label: String(s), click: () => { try { wc.replaceMisspelling(s); } catch { /* page changed */ } } }))
    : [{ label: 'No suggestions', enabled: false }];
  items.push({ label: 'Add to dictionary', click: () => { try { wc.session.addWordToSpellCheckerDictionary(word); } catch { /* ignore */ } } });
  items.push({ type: 'separator' });
  return items;
}

function editItems(p) {
  const f = (p && p.editFlags) || {};
  if (p && p.isEditable) {
    return [{ role: 'cut', enabled: f.canCut !== false }, { role: 'copy', enabled: f.canCopy !== false }, { role: 'paste', enabled: f.canPaste !== false }, { role: 'selectAll' }];
  }
  if (p && p.selectionText) return [{ role: 'copy' }];
  return [];
}

// Template for a right-click menu in an editable box or on selected text. Empty when there is nothing useful to show.
function contextTemplate(wc, p) {
  const spell = spellingItems(wc, p);
  const edit = editItems(p);
  return [...spell, ...edit];
}

module.exports = { pickLanguages, setupSpellcheck, spellingItems, editItems, contextTemplate };
