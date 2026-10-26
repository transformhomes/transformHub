const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, Menu, net, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { createStore } = require('./store');
const { createFeedService, validFeeds } = require('./feeds');
const { createUiState } = require('./uistate');
const { createTodoSync } = require('./todo');
const { nativeTheme, nativeImage } = require('electron');

// Same data folder whether started with "npm start" or from the installer.
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'th-command-centre'));
}

// Layout in CSS pixels. renderer/index.html uses the same numbers; the tests compare the two.
const RAIL_W = 64;     // icon rail
const FEED_W = 300;    // activity panel (when open)
const HEADER_H = 52;   // header bar above the main card
const GAP = 8;         // space around the main card
const RADIUS = 12;     // rounded corners of the main card and the palette
const PALETTE_W = 620, PALETTE_TOP = 64, PALETTE_MIN_H = 150, PALETTE_MAX_H = 480;
const PARTITION = 'persist:th-command-centre'; // one shared login session for Microsoft + Claude
const INTERNAL_HOSTS = /(^|\.)(microsoftonline\.com|microsoft\.com|cloud\.microsoft|domo\.com|buildertrend\.net|buildertrend\.com|microsoft365\.com|office\.com|office365\.com|live\.com|sharepoint\.com|msauth\.net|msftauth\.net|msecnd\.net|claude\.ai|anthropic\.com)$/i;

let win = null;
let sections = [];
const views = new Map(); // id -> WebContentsView
let currentId = null;
let loadedConfig = null;
let store = null;
let feedService = null;
let ui = null;
let paletteView = null;
let paletteOpen = false;
let paletteH = PALETTE_MIN_H;
const localContentsIds = new Set(); // webContents ids of built-in pages allowed to use the data bridge

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const CONFIG_VERSION = 2;

// Tidy the sections list so one hand-edit mistake (a missing file or link) cannot crash the app.
function cleanSections(list, defaults) {
  const defById = new Map(defaults.map((d) => [d.id, d]));
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[\w-]{1,30}$/.test(raw.id) || seen.has(raw.id)) { console.error('Skipping a section with a missing or repeated id'); continue; }
    const def = defById.get(raw.id);
    const sec = { id: raw.id, label: String(raw.label || (def && def.label) || raw.id).slice(0, 40), icon: String(raw.icon || (def && def.icon) || 'home').slice(0, 20) };
    let type = raw.type || (raw.file ? 'local' : raw.url ? 'web' : def && def.type);
    if (type === 'disabled') { sec.type = 'disabled'; }
    else if (type === 'local') {
      let file = typeof raw.file === 'string' ? raw.file : '';
      if (!/^renderer\/[\w-]+\.html$/.test(file) || !fs.existsSync(path.join(__dirname, file))) file = def && def.type === 'local' ? def.file : '';
      if (!file) { console.error('Skipping section "' + raw.id + '": no valid page'); continue; }
      sec.type = 'local'; sec.file = file;
    } else if (type === 'web') {
      let ok = false;
      try { ok = typeof raw.url === 'string' && new URL(raw.url).protocol === 'https:'; } catch { /* invalid */ }
      if (!ok) { console.error('Skipping section "' + raw.id + '": needs an https link'); continue; }
      sec.type = 'web'; sec.url = raw.url;
    } else { console.error('Skipping section "' + raw.id + '": unknown type'); continue; }
    seen.add(raw.id);
    out.push(sec);
  }
  // the built-in pages always exist, even if they were removed or broken in the settings file
  for (const d of defaults) if (d.type === 'local' && !seen.has(d.id)) out.push({ id: d.id, label: d.label, icon: d.icon, type: 'local', file: d.file });
  return out;
}

function loadConfig() {
  const defaultPath = path.join(__dirname, 'config.default.json');
  const defaults = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
  const userPath = configPath();
  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(userPath, 'utf8'));
    if (!Array.isArray(cfg.sections) || cfg.sections.length === 0) throw new Error('no sections');
    if (cfg.configVersion !== CONFIG_VERSION) {
      // Older config from version 0.1: keep a copy, then move to the new layout.
      const backup = path.join(path.dirname(userPath), 'config.v' + (cfg.configVersion || 1) + '.bak.json');
      if (!fs.existsSync(backup)) fs.copyFileSync(userPath, backup);
      fs.writeFileSync(userPath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    cfg.sections = cleanSections(cfg.sections, defaults.sections);
    return cfg;
  } catch (err) {
    console.error('Bad config.json, using defaults:', err.message);
    return defaults;
  }
}

function dataDir() {
  const d = loadedConfig && typeof loadedConfig.dataDir === 'string' && loadedConfig.dataDir.trim();
  return d ? d : path.join(app.getPath('userData'), 'data');
}

function findProject(id) {
  const list = (loadedConfig && Array.isArray(loadedConfig.projects)) ? loadedConfig.projects : [];
  return list.find((p) => p && p.id === id && typeof p.path === 'string') || null;
}


// ---- Project file browser (read-only) ----------------------------------------------------------
// Everything is resolved inside a configured project folder: no "..", no symlinks out, no drive letters.
const HIDE_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '$RECYCLE.BIN', 'System Volume Information', '.DS_Store', 'Thumbs.db']);
const RISKY_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.msp', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.mjs', '.wsf', '.wsh', '.hta', '.lnk', '.url', '.reg', '.jar', '.cpl', '.dll', '.sh', '.appx', '.msix', '.application', '.pif']);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const TEXT_EXT = new Set(['', '.md', '.txt', '.json', '.csv', '.tsv', '.log', '.yml', '.yaml', '.toml', '.ini', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.bat', '.cmd', '.sh', '.sql', '.env', '.gitignore']);
const MAX_TEXT_BYTES = 300 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function safeRel(rel) {
  if (rel == null || rel === '') return '';
  if (typeof rel !== 'string' || rel.length > 500 || /[\u0000-\u001f\\]/.test(rel)) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || /[:*?"<>|]/.test(p))) return null;
  return parts.join('/');
}

function resolveInProject(id, rel) {
  const proj = findProject(id);
  if (!proj) return { error: 'Unknown project.' };
  const clean = safeRel(rel);
  if (clean === null) return { error: 'That path is not allowed.' };
  let root;
  try { root = fs.realpathSync(proj.path); } catch { return { error: 'Folder not found: ' + proj.path }; }
  const target = path.join(root, ...clean.split('/').filter(Boolean));
  let real;
  try { real = fs.realpathSync(target); } catch { return { error: 'Not found.' }; }
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (norm(real) !== norm(root) && !norm(real).startsWith(norm(root) + path.sep)) return { error: 'That path is outside the project.' };
  return { root, real, clean };
}

function listDir(id, rel) {
  const r = resolveInProject(id, rel);
  if (r.error) return { ok: false, error: r.error };
  let st;
  try { st = fs.statSync(r.real); } catch { return { ok: false, error: 'Could not read this item.' }; }
  if (!st.isDirectory()) return { ok: true, isFile: true, name: path.basename(r.real), size: st.size, mtime: st.mtimeMs };
  let dirents;
  try { dirents = fs.readdirSync(r.real, { withFileTypes: true }); } catch { return { ok: false, error: 'Could not open this folder.' }; }
  const entries = [];
  for (const d of dirents) {
    if (HIDE_NAMES.has(d.name) || d.isSymbolicLink() || (!d.isDirectory() && !d.isFile())) continue;
    let size = 0, mtime = 0;
    if (entries.length < 1500) {
      try { const s = fs.statSync(path.join(r.real, d.name)); size = d.isFile() ? s.size : 0; mtime = s.mtimeMs; } catch { /* leave blank */ }
    }
    entries.push({ name: d.name, dir: d.isDirectory(), size, mtime });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { ok: true, isFile: false, entries: entries.slice(0, 1000), truncated: entries.length > 1000 };
}

function readPreview(id, rel) {
  const r = resolveInProject(id, rel);
  if (r.error) return { ok: false, error: r.error };
  let st;
  try { st = fs.statSync(r.real); } catch { return { ok: false, error: 'Could not read this file.' }; }
  if (!st.isFile()) return { ok: false, error: 'That is a folder.' };
  const ext = path.extname(r.real).toLowerCase();
  try {
    if (IMAGE_MIME[ext]) {
      if (st.size > MAX_IMAGE_BYTES) return { ok: true, kind: 'other', size: st.size, note: 'Image is too large to preview.' };
      return { ok: true, kind: 'image', size: st.size, dataUrl: 'data:' + IMAGE_MIME[ext] + ';base64,' + fs.readFileSync(r.real).toString('base64') };
    }
    if (TEXT_EXT.has(ext)) {
      const fd = fs.openSync(r.real, 'r');
      try {
        const len = Math.min(st.size, MAX_TEXT_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, 0);
        if (buf.includes(0)) return { ok: true, kind: 'other', size: st.size };
        return { ok: true, kind: 'text', size: st.size, text: buf.toString('utf8'), truncated: st.size > MAX_TEXT_BYTES };
      } finally { fs.closeSync(fd); }
    }
  } catch { return { ok: false, error: 'Could not read this file.' }; }
  return { ok: true, kind: 'other', size: st.size };
}

// ---- Microsoft To Do reader (experimental, read-only) ----
let todoService = null;
let todoView = null;

function todoEnabled() { return !!(loadedConfig && loadedConfig.msTodo && loadedConfig.msTodo.enabled === true); }

function broadcastTodo(state) {
  localContentsIds.forEach((id) => {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('todo:changed', state);
  });
}

function ensureTodoView() {
  if (todoView && !todoView.webContents.isDestroyed()) return todoView;
  todoView = new WebContentsView({
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const wc = todoView.webContents;
  wc.setUserAgent(chromeUserAgent());
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (!isInternal(url)) event.preventDefault(); });
  // The page must be "on screen" to draw, so park it far outside the visible window.
  win.contentView.addChildView(todoView);
  todoView.setBounds({ x: -4000, y: 0, width: 1200, height: 800 });
  return todoView;
}

async function scrapeTodo(routes, source) {
  if (!win || win.isDestroyed()) throw new Error('no window');
  const wc = ensureTodoView().webContents;
  const results = [];
  for (const route of routes) {
    let result = null;
    try {
      await wc.loadURL(process.env.CC_TEST_SCRIPT && process.env.CC_TEST_TODO_URL ? process.env.CC_TEST_TODO_URL : route.url);
      const started = Date.now();
      while (Date.now() - started < 20000) {
        await new Promise((r) => setTimeout(r, 1500));
        result = await wc.executeJavaScript(source);
        if (result && (result.state === 'signin' || (result.state === 'ok' && Date.now() - started > 3000))) break;
      }
    } catch { /* leave result as is; the next route may still work */ }
    results.push({ list: route.list, result });
    if (result && result.state === 'signin') break;
  }
  return results;
}

// ---- site icons: each web tab's own favicon, cached after the first visit ----
const FAVICON_FILE = () => path.join(app.getPath('userData'), 'favicons.json');
let favicons = {};
function loadFavicons() {
  try { const f = JSON.parse(fs.readFileSync(FAVICON_FILE(), 'utf8')); if (f && typeof f === 'object') favicons = f; } catch { favicons = {}; }
}
function publicHost(h) {
  return !!h && !/^(localhost|\[.*\]|\d+\.\d+\.\d+\.\d+)$/i.test(h) && !/\.(local|internal|lan)$/i.test(h);
}
async function fetchFavicon(url) {
  if (url.startsWith('data:')) {
    if (url.length > 400000 || !/^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i.test(url)) return null;
    return url;
  }
  const u = new URL(url);
  if (u.protocol !== 'https:' || !publicHost(u.hostname)) return null;
  const res = await session.fromPartition(PARTITION).fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  let type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if ((type === 'application/octet-stream' || type === '') && /\.ico$/i.test(u.pathname)) type = 'image/x-icon';
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 300 * 1024) return null;
  return 'data:' + type + ';base64,' + buf.toString('base64');
}

async function cacheFavicon(sectionId, list, pageUrl) {
  try {
    const candidates = (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string');
    try { if (pageUrl) candidates.push(new URL('/favicon.ico', pageUrl).href); } catch { /* ignore */ }
    for (const url of candidates) {
      let dataUrl = null;
      try { dataUrl = await fetchFavicon(url); } catch { dataUrl = null; }
      if (!dataUrl) continue; // try the next candidate
      if (favicons[sectionId] === dataUrl) return;
      favicons[sectionId] = dataUrl;
      try { fs.writeFileSync(FAVICON_FILE(), JSON.stringify(favicons)); } catch { /* best effort */ }
      if (win && !win.isDestroyed()) win.webContents.send('favicons:changed', favicons);
      return;
    }
  } catch { /* icons are decoration only */ }
}

function isLocalSender(event) {
  return localContentsIds.has(event.sender.id) && event.senderFrame && String(event.senderFrame.url).startsWith('file://');
}

function broadcastData(data) {
  localContentsIds.forEach((id) => {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('data:changed', data);
  });
}

function broadcastFeeds(state) {
  localContentsIds.forEach((id) => {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('feeds:changed', state);
  });
}

function chromeUserAgent() {
  // Present as plain Chrome so sign-in pages and bot checks behave.
  return session.fromPartition(PARTITION).getUserAgent()
    .replace(/\sElectron\/[\d.]+/i, '')
    .replace(new RegExp('\\s' + app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/[\\d.]+', 'i'), '');
}

function isInternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true;
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return INTERNAL_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

function stageBounds() {
  const [w, h] = win.getContentSize();
  const left = RAIL_W + (ui.get().feedOpen ? FEED_W : 0) + GAP;
  return { x: left, y: HEADER_H, width: Math.max(0, w - left - GAP), height: Math.max(0, h - HEADER_H - GAP) };
}

function paletteBounds() {
  const [w] = win.getContentSize();
  const width = Math.max(320, Math.min(PALETTE_W, w - 32));
  return { x: Math.round((w - width) / 2), y: PALETTE_TOP, width, height: paletteH };
}

function layout() {
  if (!win) return;
  if (currentId && views.has(currentId)) views.get(currentId).setBounds(stageBounds());
  if (paletteOpen && paletteView) paletteView.setBounds(paletteBounds());
}

function rounded(view) {
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(RADIUS);
}

function createView(section) {
  const view = new WebContentsView({
    webPreferences: {
      partition: section.type === 'web' ? PARTITION : undefined,
      preload: section.type === 'local' ? path.join(__dirname, 'preload-local.js') : undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  rounded(view);
  const wc = view.webContents;
  if (section.type === 'local') {
    localContentsIds.add(wc.id);
    wc.once('destroyed', () => localContentsIds.delete(wc.id));
  }

  if (section.type === 'web') {
    wc.setUserAgent(chromeUserAgent());
    wc.loadURL(section.url);
    wc.on('page-favicon-updated', (_e, list) => cacheFavicon(section.id, list, wc.getURL()));
  } else {
    wc.loadFile(path.join(__dirname, section.file));
  }

  wc.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      // sign-in popups and Office pop-outs stay inside the app
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (section.type === 'local' && !url.startsWith('file:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return view;
}

function enabledSections() { return sections.filter((x) => x.type !== 'disabled'); }

function deliverParams(view, params) {
  const wc = view.webContents;
  const send = () => { if (!wc.isDestroyed()) wc.send('nav:params', params); };
  if (wc.isLoading()) wc.once('did-finish-load', send); else send();
}

function select(id, params) {
  const section = sections.find((x) => x.id === id);
  if (!section || section.type === 'disabled' || !win) return;

  if (currentId && currentId !== id && views.has(currentId)) {
    win.contentView.removeChildView(views.get(currentId));
  }
  if (!views.has(id)) views.set(id, createView(section));

  const view = views.get(id);
  win.contentView.addChildView(view);
  view.setBounds(stageBounds());
  if (paletteOpen && paletteView) win.contentView.addChildView(paletteView); // keep the palette on top
  currentId = id;
  win.webContents.send('cc:selected', id);
  if (params) deliverParams(view, params);
  if (!paletteOpen) view.webContents.focus();
}

// ---- theme and logo ----
function applyTheme() {
  nativeTheme.themeSource = ui.get().theme; // 'system' | 'light' | 'dark'; web pages that support it follow along
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1319' : '#e5eaf1');
}

function logoPath() { return path.join(__dirname, 'transformHub.png'); }

function readLogo() {
  try {
    const p = logoPath();
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    const buf = fs.readFileSync(p);
    if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null; // must be a real PNG
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch { return null; }
}

function toggleFeed() {
  ui.set({ feedOpen: !ui.get().feedOpen });
  layout();
  if (win) win.webContents.send('ui:changed', ui.get());
}

function openPalette() {
  if (!win) return;
  if (paletteOpen) { closePalette(true); return; }
  if (!paletteView) {
    paletteView = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    rounded(paletteView);
    const wc = paletteView.webContents;
    localContentsIds.add(wc.id);
    wc.loadFile(path.join(__dirname, 'renderer', 'palette.html'));
    // clicking anywhere else (another pane, another window) closes it
    wc.on('blur', () => { if (paletteOpen) closePalette(false); });
  }
  paletteH = PALETTE_MIN_H;
  paletteOpen = true;
  win.contentView.addChildView(paletteView);
  paletteView.setBounds(paletteBounds());
  const wc = paletteView.webContents;
  const announce = () => { if (!wc.isDestroyed()) { wc.focus(); wc.send('palette:open'); } };
  if (wc.isLoading()) wc.once('did-finish-load', announce); else announce();
}

function closePalette(restoreFocus) {
  if (!paletteOpen || !paletteView || !win) return;
  paletteOpen = false;
  win.contentView.removeChildView(paletteView);
  if (restoreFocus) {
    const v = currentId && views.get(currentId);
    if (v) v.webContents.focus(); else win.webContents.focus();
  }
}

function reloadCurrent() {
  const v = currentId && views.get(currentId);
  if (v) v.webContents.reload();
}

function isWebContents(contents) {
  for (const [id, view] of views) {
    const sec = sections.find((x) => x.id === id);
    if (sec && sec.type === 'web' && view.webContents === contents) return true;
  }
  return false;
}

// Keyboard shortcuts. Inside web sections (Outlook, Teams, OneDrive, Claude, DOMO) we keep our hands off
// the keys those sites use themselves (Ctrl+K insert link, Ctrl+R reply, Ctrl+1..9 switch module),
// so there the app's shortcuts use Alt or Ctrl+Shift instead. Returns true if the key was handled.
function handleKey(contents, input) {
  if (!win || !input || input.type !== 'keyDown') return false;
  const key = String(input.key || '').toLowerCase();
  const web = isWebContents(contents);
  const ctrlOnly = input.control && !input.alt && !input.shift && !input.meta;
  const ctrlShift = input.control && input.shift && !input.alt && !input.meta;
  const altOnly = input.alt && !input.control && !input.shift && !input.meta;

  if (key === 'f5' && !input.control && !input.alt) { reloadCurrent(); return true; }

  if (key === 'k' && (web ? ctrlShift : ctrlOnly)) { openPalette(); return true; }

  if (key === '\\' && ctrlOnly) { toggleFeed(); return true; }

  if (/^[0-9]$/.test(key) && (web ? altOnly : ctrlOnly)) {
    const list = enabledSections();
    const target = list[key === '0' ? 9 : Number(key) - 1];
    if (target) { select(target.id); return true; }
    return false;
  }

  if (key === 'r' && ctrlOnly && !web) { reloadCurrent(); return true; }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'transformHub ' + app.getVersion(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1319' : '#e5eaf1',
    icon: fs.existsSync(logoPath()) ? logoPath() : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  localContentsIds.add(win.webContents.id);
  win.on('page-title-updated', (e) => e.preventDefault()); // keep the version in the title
  win.on('resize', layout);

  win.webContents.once('did-finish-load', () => {
    const cfg = loadedConfig;
    const start = sections.find((s) => s.id === (process.env.CC_TEST_SECTION || cfg.startSection) && s.type !== 'disabled')
      || sections.find((s) => s.type !== 'disabled');
    if (start) select(start.id);

    if (process.env.CC_TEST_SCRIPT) {
      // Test hook only (never set in normal use): run a script that can drive the app.
      const ctx = {
        select, views, store, sections, win, app, feeds: feedService, config: loadedConfig,
        ui, handleKey, todo: () => todoService, cacheFavicon, favicons: () => favicons, openPalette, closePalette, toggleFeed, stageBounds, paletteBounds,
        palette: () => ({ view: paletteView, open: paletteOpen }),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        current: () => currentId,
      };
      Promise.resolve(require(process.env.CC_TEST_SCRIPT)(ctx))
        .catch((err) => { console.error('TEST SCRIPT FAILED:', err); process.exitCode = 1; })
        .finally(() => app.quit());
    }
  });

  win.on('closed', () => { win = null; });
}

// Single instance: opening the app again focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    ipcMain.handle('cc:sections', (e) => (isLocalSender(e) ? sections.map((x) => ({ id: x.id, label: x.label, icon: x.icon, type: x.type })) : []));
    ipcMain.on('cc:select', (e, id) => { if (isLocalSender(e) && typeof id === 'string') select(id); });
    ipcMain.on('cc:navigate', (e, p) => {
      if (!isLocalSender(e) || !p || typeof p.section !== 'string') return;
      const params = {};
      if (typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) params.date = p.date;
      if (typeof p.project === 'string' && p.project.length <= 100) params.project = p.project;
      if (typeof p.path === 'string' && safeRel(p.path) !== null) params.path = safeRel(p.path);
      select(p.section, Object.keys(params).length ? params : undefined);
      if (win && !win.isDestroyed()) win.webContents.send('cc:nav', { section: p.section, ...params });
    });
    ipcMain.handle('fs:list', (e, id, rel) => (isLocalSender(e) ? listDir(id, rel) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('fs:read', (e, id, rel) => (isLocalSender(e) ? readPreview(id, rel) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('fs:open', async (e, id, rel) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(id, rel);
      if (r.error) return { ok: false, error: r.error };
      let isDir = false;
      try { isDir = fs.statSync(r.real).isDirectory(); } catch { return { ok: false, error: 'Not found.' }; }
      if (!isDir && RISKY_EXT.has(path.extname(r.real).toLowerCase())) return { ok: false, error: 'For safety, programs and scripts are not run from here. Use Show in Explorer instead.' };
      const err = await shell.openPath(r.real);
      return err ? { ok: false, error: err } : { ok: true };
    });
    ipcMain.handle('fs:reveal', (e, id, rel) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(id, rel);
      if (r.error) return { ok: false, error: r.error };
      shell.showItemInFolder(r.real);
      return { ok: true };
    });
    ipcMain.on('cc:reload', (e) => { if (isLocalSender(e)) reloadCurrent(); });
    ipcMain.on('cc:open-config', (e) => { if (isLocalSender(e)) shell.openPath(configPath()); });
    ipcMain.on('ui:set-theme', (e, t) => { if (isLocalSender(e) && ['light', 'dark', 'system'].includes(t)) { ui.set({ theme: t }); applyTheme(); } });
    ipcMain.handle('app:logo', (e) => (isLocalSender(e) ? readLogo() : null));
    ipcMain.handle('ui:get', (e) => (isLocalSender(e) ? ui.get() : null));
    ipcMain.on('ui:toggle-feed', (e) => { if (isLocalSender(e)) toggleFeed(); });
    ipcMain.on('palette:toggle', (e) => { if (isLocalSender(e)) openPalette(); });
    ipcMain.on('palette:close', (e) => { if (isLocalSender(e)) closePalette(true); });
    ipcMain.on('palette:resize', (e, h) => {
      if (!isLocalSender(e) || !Number.isFinite(h)) return;
      paletteH = Math.max(PALETTE_MIN_H, Math.min(PALETTE_MAX_H, Math.round(h)));
      if (paletteOpen && paletteView) paletteView.setBounds(paletteBounds());
    });
    ipcMain.on('palette:recent', (e, key) => { if (isLocalSender(e)) ui.pushRecent(key); });

    loadedConfig = loadConfig();
    sections = loadedConfig.sections;
    store = createStore(dataDir());
    ui = createUiState(dataDir());
    nativeTheme.themeSource = ui.get().theme;

    feedService = createFeedService({
      getFeeds: () => validFeeds(loadedConfig && loadedConfig.calendarFeeds),
      fetchText: async (url) => {
        const res = await net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      },
      cacheFile: path.join(dataDir(), 'feeds-cache.json'),
      onChange: broadcastFeeds,
    });
    if (!process.env.CC_TEST_SCRIPT) {
      setTimeout(() => feedService.refresh(), 2500);
      setInterval(() => feedService.refresh(), 15 * 60 * 1000);
    }
    ipcMain.handle('feeds:get', (e) => (isLocalSender(e) ? feedService.get() : null));
    ipcMain.handle('feeds:refresh', (e) => (isLocalSender(e) ? feedService.refresh() : null));

    loadFavicons();
    ipcMain.handle('app:favicons', (e) => (isLocalSender(e) ? favicons : {}));
    todoService = createTodoSync({ scrape: scrapeTodo, cacheFile: path.join(dataDir(), 'todo-cache.json'), onChange: broadcastTodo });
    const runTodo = () => { if (todoEnabled()) todoService.refresh(); };
    if (!process.env.CC_TEST_SCRIPT) { setTimeout(runTodo, 9000); setInterval(runTodo, 10 * 60 * 1000); }
    ipcMain.handle('todo:get', (e) => (isLocalSender(e) ? { enabled: todoEnabled(), ...todoService.get() } : null));
    ipcMain.handle('todo:refresh', async (e) => {
      if (!isLocalSender(e)) return null;
      if (!todoEnabled()) return { enabled: false, ...todoService.get() };
      return { enabled: true, ...(await todoService.refresh()) };
    });

    ipcMain.handle('data:get', (e) => (isLocalSender(e) ? store.get() : null));
    ipcMain.handle('data:set', (e, patch) => {
      if (!isLocalSender(e)) return null;
      const data = store.update(patch);
      broadcastData(data);
      return data;
    });
    ipcMain.handle('app:settings', (e) => (isLocalSender(e) ? { userName: String((loadedConfig && loadedConfig.userName) || '').slice(0, 60) } : null));
    ipcMain.handle('projects:list', (e) => (isLocalSender(e)
      ? (loadedConfig.projects || []).filter((p) => p && p.id && p.name).map((p) => ({ id: String(p.id), name: String(p.name), path: String(p.path || '') }))
      : []));
    ipcMain.handle('projects:open-folder', async (e, id) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const proj = findProject(id);
      if (!proj) return { ok: false, error: 'Unknown project.' };
      const err = await shell.openPath(proj.path);
      return err ? { ok: false, error: err } : { ok: true };
    });
    ipcMain.handle('projects:open-arcane', (e) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const url = loadedConfig.arcaneUrl || 'http://127.0.0.1:7600';
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) return { ok: false, error: 'arcaneUrl must be a local address.' };
      shell.openExternal(url);
      return { ok: true };
    });
    ipcMain.handle('cc:current', () => currentId);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (event, input) => {
      if (handleKey(contents, input)) event.preventDefault();
    });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
