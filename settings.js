// Checks everything the Settings page sends before it touches the settings file. Pure functions, no Electron.
const path = require('path');

const ICON_NAMES = ['home', 'folder', 'mail', 'calendar', 'tasks', 'chat', 'star', 'briefcase', 'check', 'users', 'book', 'chart', 'gear', 'globe'];
const SPELL_OPTIONS = ['en-AU', 'en-GB', 'en-US'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isHttps = (u) => { try { return new URL(String(u).trim()).protocol === 'https:'; } catch { return false; } };
const absolute = (p) => typeof p === 'string' && p.length <= 260 && (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p));
const uniqueId = (base, taken, max = 30) => {
  let id = base.slice(0, max) || 'item', n = 2;
  while (taken.has(id)) { const suffix = '-' + n++; id = base.slice(0, max - suffix.length) + suffix; }
  taken.add(id);
  return id;
};

// sections: the tabs as the settings file has them now (the base for changes); live: the tabs as the running app has them
function buildSettings(patch, { current, sections, live: liveSections, defaults, cleanSections, validFeeds }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Nothing to save.' };
  const config = {};
  let restartNeeded = false;
  let feedsChanged = false;

  if ('userName' in patch) {
    if (typeof patch.userName !== 'string') return { ok: false, error: 'Your name must be text.' };
    config.userName = patch.userName.trim().slice(0, 60);
  }
  if ('spellCheckLanguage' in patch) {
    if (!SPELL_OPTIONS.includes(patch.spellCheckLanguage)) return { ok: false, error: 'Please choose one of the spell check languages in the list.' };
    config.spellCheckLanguages = [patch.spellCheckLanguage];
  }
  if ('outlookDesktop' in patch) {
    if (typeof patch.outlookDesktop !== 'boolean') return { ok: false, error: 'Outlook on Home must be on or off.' };
    config.outlookDesktop = patch.outlookDesktop;
  }

  if ('calendarFeeds' in patch) {
    if (!Array.isArray(patch.calendarFeeds) || patch.calendarFeeds.length > 20) return { ok: false, error: 'The calendar links are not valid.' };
    const rows = patch.calendarFeeds.filter((f) => f && (String(f.url || '').trim() || String(f.name || '').trim()));
    for (let i = 0; i < rows.length; i++) {
      if (typeof rows[i].url !== 'string' || !isHttps(rows[i].url)) return { ok: false, error: 'Calendar link ' + (i + 1) + ' must be a full web address starting with https://' };
    }
    if (rows.length > 5) return { ok: false, error: 'You can have up to 5 calendar links.' };
    config.calendarFeeds = validFeeds(rows.map((f) => ({ name: String(f.name || '').trim() || 'Calendar', url: f.url })));
    feedsChanged = JSON.stringify(config.calendarFeeds) !== JSON.stringify(validFeeds(current.calendarFeeds));
  }

  if ('projects' in patch) {
    if (!Array.isArray(patch.projects) || patch.projects.length > 40) return { ok: false, error: 'The project folders are not valid.' };
    const existing = new Map((Array.isArray(current.projects) ? current.projects : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
    const taken = new Set();
    const out = [];
    const rows = patch.projects.filter((p) => p && (String(p.name || '').trim() || String(p.path || '').trim()));
    for (let i = 0; i < rows.length; i++) {
      const p = rows[i];
      const name = typeof p.name === 'string' ? p.name.trim().slice(0, 40) : '';
      if (!name) return { ok: false, error: 'Project folder ' + (i + 1) + ' needs a name.' };
      if (!absolute(typeof p.path === 'string' ? p.path.trim() : '')) return { ok: false, error: 'Project folder ' + (i + 1) + ' ("' + name + '") needs a full folder path, like C:\\Projects\\My Project.' };
      let id = typeof p.id === 'string' && existing.has(p.id) && /^[\w-]{1,30}$/.test(p.id) && !taken.has(p.id) ? p.id : null;
      if (id) taken.add(id); else id = uniqueId(slug(name) || 'project', taken);
      out.push({ ...(existing.get(id) || {}), id, name, path: p.path.trim() });
    }
    config.projects = out;
  }

  if ('sections' in patch) {
    if (!Array.isArray(patch.sections) || patch.sections.length > 40) return { ok: false, error: 'The tabs list is not valid.' };
    const live = sections.filter((s) => s.id !== 'settings');
    const liveById = new Map(live.map((s) => [s.id, s]));
    const defById = new Map(defaults.map((d) => [d.id, d]));
    const taken = new Set(live.map((s) => s.id));
    taken.add('settings');
    const out = [];
    const seen = new Set();
    for (let i = 0; i < patch.sections.length; i++) {
      const it = patch.sections[i];
      if (!it || typeof it !== 'object') return { ok: false, error: 'The tabs list is not valid.' };
      const label = typeof it.label === 'string' ? it.label.trim().slice(0, 40) : '';
      if (!label) return { ok: false, error: 'Every tab needs a name.' };
      const base = typeof it.id === 'string' ? liveById.get(it.id) : null;
      if (base) {
        if (seen.has(base.id)) return { ok: false, error: 'The tabs list is not valid.' };
        seen.add(base.id);
        const icon = ICON_NAMES.includes(it.icon) ? it.icon : base.icon;
        if (base.type === 'web') {
          if (typeof it.url !== 'string' || !isHttps(it.url)) return { ok: false, error: 'The tab "' + label + '" needs a full web address starting with https://' };
          const e = { id: base.id, label, icon, type: 'web', url: it.url.trim() };
          if (base.iconFile) e.iconFile = base.iconFile;
          out.push(e);
        } else {
          let hidden = it.hidden === true;
          if (base.id === 'home') hidden = false;
          if (hidden) out.push({ id: base.id, label, icon, type: 'disabled' });
          else if (base.type === 'disabled') {
            const d = defById.get(base.id);
            if (!d) return { ok: false, error: 'The tab "' + label + '" cannot be shown again from here. Use Advanced.' };
            const e = { id: base.id, label, icon, type: d.type };
            if (d.file) e.file = d.file;
            if (d.url) e.url = d.url;
            if (base.iconFile) e.iconFile = base.iconFile;
            out.push(e);
          } else {
            const e = { id: base.id, label, icon, type: base.type };
            if (base.file) e.file = base.file;
            if (base.url) e.url = base.url;
            if (base.iconFile) e.iconFile = base.iconFile;
            out.push(e);
          }
        }
      } else {
        if (typeof it.url !== 'string' || !isHttps(it.url)) return { ok: false, error: 'The new tab "' + label + '" needs a full web address starting with https://' };
        out.push({ id: uniqueId('web-' + (slug(label) || 'tab'), taken), label, icon: ICON_NAMES.includes(it.icon) ? it.icon : 'globe', type: 'web', url: it.url.trim() });
      }
    }
    // tabs that cannot be removed from here stay, at the end
    for (const s of live) if (!seen.has(s.id) && s.type !== 'web') {
      const e = { id: s.id, label: s.label, icon: s.icon, type: s.type };
      if (s.file) e.file = s.file; if (s.url) e.url = s.url; if (s.iconFile) e.iconFile = s.iconFile;
      out.push(e);
    }
    if (!out.some((s) => s.type !== 'disabled')) return { ok: false, error: 'At least one tab must be shown.' };
    const cleaned = cleanSections(out, defaults);
    if (cleaned.filter((s) => s.id !== 'settings').length < out.length) return { ok: false, error: 'One of the tabs is not valid.' };
    config.sections = out;
    const sig = (list) => JSON.stringify(list.filter((s) => s.id !== 'settings').map((s) => [s.id, s.label, s.icon, s.type, s.url || '', s.file || '', s.iconFile || '']));
    restartNeeded = sig(out) !== sig(liveSections || sections);
  }

  if ('startSection' in patch) {
    const list = config.sections || sections;
    const ok = typeof patch.startSection === 'string' && list.some((s) => s.id === patch.startSection && s.type !== 'disabled');
    if (!ok) return { ok: false, error: 'The start tab must be one of the tabs that is shown.' };
    config.startSection = patch.startSection;
  }
  return { ok: true, config, restartNeeded, feedsChanged };
}

// Turn a JSON error into something a non-coder can find: line and column.
function describeJsonError(text, err) {
  const m = /position (\d+)/.exec(String(err && err.message));
  if (!m) return 'The file is not valid: ' + String(err && err.message).slice(0, 120);
  const pos = Number(m[1]);
  const before = text.slice(0, pos).split('\n');
  return 'There is a mistake near line ' + before.length + ', column ' + (before[before.length - 1].length + 1) + '. Check for a missing comma, bracket or quote mark just before that point.';
}

// null when the text is safe to save as the settings file, otherwise a plain-English reason.
function rawSettingsError(text, { configVersion, cleanSections, defaults }) {
  let cfg;
  try { cfg = JSON.parse(text); } catch (err) { return describeJsonError(text, err); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'The settings must be one object, starting with { and ending with }.';
  if (cfg.configVersion !== configVersion) return 'The line "configVersion": ' + configVersion + ' must stay as it is, otherwise Transform Workstation would reset your settings.';
  if (!Array.isArray(cfg.sections) || !cfg.sections.length) return 'The "sections" list (your tabs) must not be empty.';
  const cleaned = cleanSections(cfg.sections, defaults);
  if (!cleaned.some((s) => s.type !== 'disabled' && s.id !== 'settings')) return 'At least one tab must be shown.';
  if (cfg.apps != null && !Array.isArray(cfg.apps)) return '"apps" must be a list.';
  if (cfg.projects != null && !Array.isArray(cfg.projects)) return '"projects" must be a list.';
  return null;
}

module.exports = { buildSettings, rawSettingsError, describeJsonError, ICON_NAMES, SPELL_OPTIONS };
