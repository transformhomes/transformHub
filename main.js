const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, Menu, net, webContents, dialog, protocol, clipboard, powerMonitor } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { createStore } = require('./store');
const { createFeedService, validFeeds } = require('./feeds');
const { createUiState } = require('./uistate');
const { createTodoSync, completeSource, EXTRACT_SOURCE: TODO_SOURCE } = require('./todo');
const { createDrmd } = require('./drmd');
const { createBrowser } = require('./browser');
const { createOutlook } = require('./outlook');
const { buildSettings, rawSettingsError } = require('./settings');
const { setupSpellcheck, contextTemplate } = require('./spell');
const { createLock, MAX_PIN } = require('./lock');
const { createFileSearch } = require('./filesearch');
const { createRecent } = require('./recent');
const { listBackups, restoreBackup } = require('./backups');
const { execFile } = require('child_process');
const { nativeTheme, nativeImage, screen } = require('electron');

// Same data folder whether started with "npm start" or from the installer.
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'th-command-centre'));
}

if (process.platform === 'win32') app.setAppUserModelId('au.com.transformhomes.transformhub'); // groups the taskbar button under the app's own icon

// Layout in CSS pixels. renderer/index.html uses the same numbers; the tests compare the two.
const RAIL_W = 64;     // icon rail
const FEED_W = 300;    // activity panel (when open)
const HEADER_H = 52;   // header bar above the main card
const GAP = 8;         // space around the main card
const RADIUS = 12;     // rounded corners of the main card and the palette
const PALETTE_W = 620, PALETTE_TOP = 64, PALETTE_MIN_H = 150, PALETTE_MAX_H = 480;
const PARTITION = 'persist:th-command-centre'; // one shared login session for Microsoft + Claude
const DRMD_PARTITION = 'persist:th-drmd';       // Dr. MD keeps its own storage, apart from the sign-in session
const DRMD_DIR = path.join(__dirname, 'drmd');   // the built Dr. MD page (see the README: npm run drmd)
const BROWSER_PARTITION = 'persist:th-browser'; // the Browser tab keeps its own sign-ins and history, apart from everything else
const VAULT_PARTITION = 'persist:th-vault';     // the password vault (Bitwarden) keeps its own storage, apart from every other site
const VAULT_HOSTS = /(^|\.)bitwarden\.(com|eu)$/i;
const KEEP_SIGNED_IN_DAYS = 30;                 // sign-ins for the sites listed under "keepSignedIn" last this long between restarts
const DRMD_URL = 'drmd://app/';
const DRMD_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const INTERNAL_HOSTS = /(^|\.)(microsoftonline\.com|microsoft\.com|cloud\.microsoft|domo\.com|buildertrend\.net|buildertrend\.com|microsoft365\.com|office\.com|office365\.com|live\.com|sharepoint\.com|msauth\.net|msftauth\.net|msecnd\.net|claude\.ai|anthropic\.com)$/i;

let win = null;
let sections = [];
const views = new Map(); // id -> WebContentsView
let currentId = null;
let previousId = null; // the tab you were on before this one (Alt+Q goes back to it)
let secondId = null;   // a second tab shown beside the current one (Shift+click a tab in the rail)
let loadedConfig = null;
let store = null;
let feedService = null;
let ui = null;
let paletteView = null;
let paletteOpen = false;
let paletteH = PALETTE_MIN_H;
const localContentsIds = new Set(); // webContents ids of built-in pages allowed to use the data bridge
const drmdContentsIds = new Set();  // webContents ids of Dr. MD (allowed to use the Dr. MD file bridge only)
let drmdService = null;
let browserService = null;
let outlookService = null;
let recentSvc = null;
let fileSearch = null; // created on first use (a test can supply its own)
let testPickImage = null; // set by the test hook to stand in for the picture picker
let testPickFolder = null; // set by the test hook to stand in for the folder picker
let testPickApp = null; // set by the test hook to stand in for the file picker
let spawnShell = null; // set by the test hook to stand in for starting PowerShell
let outlookRun = null; // set by the test hook to stand in for PowerShell
const browserShellIds = new Set(); // webContents id of the Browser tab's toolbar page
let testDialogs = null; // set only by the test hook, to stand in for the native Open and Save dialogs

// drmd:// must be declared before the app is ready. It serves the built Dr. MD files like a small website.
protocol.registerSchemesAsPrivileged([{ scheme: 'drmd', privileges: { standard: true, secure: true, supportsFetchAPI: true, stream: true } }]);

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const CONFIG_VERSION = 2;

// Tidy the sections list so one hand-edit mistake (a missing file or link) cannot crash the app.
function cleanSections(list, defaults) {
  const defById = new Map(defaults.map((d) => [d.id, d]));
  const out = [];
  const seen = new Set();
  let hasBrowser = false;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[\w-]{1,30}$/.test(raw.id) || seen.has(raw.id)) { console.error('Skipping a section with a missing or repeated id'); continue; }
    const def = defById.get(raw.id);
    const sec = { id: raw.id, label: String(raw.label || (def && def.label) || raw.id).slice(0, 40), icon: String(raw.icon || (def && def.icon) || 'home').slice(0, 20) };
    // The AI Projects page is now the Explorer: update the old default name and icon, keep any custom ones.
    if (raw.id === 'projects') { if (sec.label === 'AI Projects') sec.label = 'Explorer'; if (sec.icon === 'briefcase') sec.icon = 'folder'; }
    let type = raw.type || (raw.file ? 'local' : raw.url ? 'web' : def && def.type);
    if (type === 'disabled') { sec.type = 'disabled'; }
    else if (type === 'drmd') { sec.type = 'drmd'; }
    else if (type === 'browser') {
      if (hasBrowser) { console.error('Skipping section "' + raw.id + '": only one browser tab is allowed'); continue; }
      hasBrowser = true;
      sec.type = 'browser';
      try { if (typeof raw.url === 'string' && new URL(raw.url).protocol === 'https:') sec.url = raw.url; } catch { /* use the default start page */ }
    }
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
    if (validIconPath(raw.iconFile)) sec.iconFile = raw.iconFile;
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

// Drives shown under "This PC" in the Explorer. Settings: "explorer": { "drives": ["C:\\", "D:\\"] }.
// An entry can also be { "name": "Shared", "path": "..." }. Default on Windows: C:\ and D:\ (whichever exist).
function driveRoots() {
  const cfg = loadedConfig && loadedConfig.explorer;
  const found = (l) => l.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
  const list = cfg && Array.isArray(cfg.drives) ? cfg.drives : (process.platform === 'win32' ? found(['C:\\', 'D:\\']) : []);
  const out = [];
  const seen = new Set();
  for (const d of list.slice(0, 12)) {
    let id, name, p;
    if (typeof d === 'string' && /^[A-Za-z]:[\\/]?$/.test(d.trim())) {
      const letter = d.trim()[0].toUpperCase();
      id = 'drive:' + letter; name = 'Local Disk (' + letter + ':)'; p = letter + ':\\';
    } else if (d && typeof d === 'object' && typeof d.path === 'string' && path.isAbsolute(d.path) && typeof d.name === 'string' && d.name.trim()) {
      name = d.name.trim().slice(0, 40); id = 'drive:' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'disk'); p = d.path;
    } else continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, path: p });
  }
  // Your own Desktop, Downloads, Documents, Pictures, Music and Videos folders, listed after the drives.
  // Windows supplies the real location (so a OneDrive-redirected Documents folder works). Turn off with "explorer": { "quickFolders": false }.
  if (!(cfg && cfg.quickFolders === false) && process.platform === 'win32') {
    for (const [key, name] of [['desktop', 'Desktop'], ['downloads', 'Downloads'], ['documents', 'Documents'], ['pictures', 'Pictures'], ['music', 'Music'], ['videos', 'Videos']]) {
      const id = 'drive:' + key;
      if (seen.has(id)) continue;
      let p;
      try { p = app.getPath(key); if (!p || !fs.existsSync(p)) continue; } catch { continue; }
      seen.add(id);
      out.push({ id, name, path: p });
    }
  }
  return out;
}

// A browsable place: a configured project folder or a drive. Everything else resolves inside one of these.
function findRoot(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('drive:')) { const d = driveRoots().find((x) => x.id === id); return d ? { path: d.path, kind: 'drive', name: d.name } : null; }
  const p = findProject(id);
  return p ? { path: p.path, kind: 'project', name: String(p.name || id) } : null;
}

// Never shown or opened on a drive: system folders, sign-in data and key stores.
const BLOCK_NAMES = new Set(['appdata', 'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'recovery', 'system volume information',
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', 'config.msi', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys']);
const isBlockedName = (n) => { const l = String(n).toLowerCase(); return BLOCK_NAMES.has(l) || l.startsWith('ntuser.'); };

// ---- Apps (launchers) ----------------------------------------------------------------------------
// Settings: "apps": [ { "name": "Typora", "path": "D:\\Program Files\\Typora\\Typora.exe", "types": [".md"] } ].
// Only apps listed in the settings file can be started, and the pages only ever send an app's id, never a path.
const IMAGE_ICON_EXT = /\.(png|ico|jpe?g)$/i;
const validIconPath = (p) => typeof p === 'string' && p.length <= 300 && path.isAbsolute(p) && (IMAGE_ICON_EXT.test(p) || /\.exe$/i.test(p));
const MAX_APPS = 24;
// Well-known programs get a friendly name and the file types they open, so the right-click "Open in Excel" and "Open in Word" work without any setup.
// A list of "types" in the settings file for that app replaces these. Macro-enabled files (.xlsm, .docm) are left out on purpose.
const KNOWN_APPS = {
  excel: { label: 'Excel', types: ['.xlsx', '.xls', '.xlsb', '.csv', '.tsv', '.xltx', '.xlt', '.ods'] },
  winword: { label: 'Word', types: ['.docx', '.doc', '.dotx', '.dot', '.rtf', '.odt'] },
  powerpnt: { label: 'PowerPoint', types: ['.pptx', '.ppt', '.ppsx', '.potx', '.odp'] },
  acrobat: { label: 'Acrobat', types: ['.pdf'] },
  acrord32: { label: 'Acrobat Reader', types: ['.pdf'] },
  'notepad++': { label: 'Notepad++', types: ['.txt', '.md', '.json', '.log', '.xml', '.csv', '.js', '.css', '.html', '.ini', '.yml', '.yaml'] },
};
const knownApp = (p) => KNOWN_APPS[path.basename(String(p)).replace(/\.exe$/i, '').toLowerCase()] || null;
const appIdFor = (name) => 'app:' + (String(name).trim().slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app');
function appList() {
  const raw = loadedConfig && Array.isArray(loadedConfig.apps) ? loadedConfig.apps : [];
  const out = [];
  const seen = new Set();
  for (const a of raw.slice(0, MAX_APPS)) {
    if (!a || typeof a.name !== 'string' || !a.name.trim() || typeof a.path !== 'string' || !path.isAbsolute(a.path)) continue;
    const name = a.name.trim().slice(0, 40);
    const id = appIdFor(name);
    if (seen.has(id)) continue;
    seen.add(id);
    let types = (Array.isArray(a.types) ? a.types : []).filter((t) => typeof t === 'string' && /^\.[a-z0-9]{1,8}$/i.test(t)).map((t) => t.toLowerCase()).slice(0, 20);
    const known = knownApp(a.path);
    if (!types.length && known) types = known.types.slice();
    const icon = validIconPath(a.icon) ? a.icon : null;
    out.push({ id, name, label: known ? known.label : name, path: a.path, types, icon });
  }
  return out;
}

// Each program's own icon, read from its .exe (cached). Pages get small picture data only, never a path.
const appIconCache = new Map();
let genericExeIcon; // what Windows gives for a program with no icon of its own
// Windows sometimes hands back its plain "blank window" icon for a program that does have one. When that happens,
// read the icon straight out of the file with PowerShell (the path goes in through the environment, never into the script).
const EXTRACT_ICON_SCRIPT = "Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Icon]::ExtractAssociatedIcon($env:TH_ICON_PATH); if ($i) { $m = New-Object IO.MemoryStream; $i.ToBitmap().Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()) }";
function extractIconWithPowerShell(p) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(null); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', EXTRACT_ICON_SCRIPT],
      { timeout: 10000, windowsHide: true, env: { ...process.env, TH_ICON_PATH: p }, maxBuffer: 1024 * 1024 },
      (err, out) => { const b64 = String(out || '').trim(); resolve(!err && /^[A-Za-z0-9+/=]{100,400000}$/.test(b64) ? 'data:image/png;base64,' + b64 : null); });
  });
}
async function appIcon(p) {
  if (appIconCache.has(p)) return appIconCache.get(p);
  let url = null;
  try {
    if (IMAGE_ICON_EXT.test(p)) {
      if (fs.statSync(p).size <= 1024 * 1024) {
        let img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) { const s = img.getSize(); if (Math.max(s.width, s.height) > 128) img = img.resize({ height: s.height >= s.width ? 128 : undefined, width: s.width > s.height ? 128 : undefined }); url = img.toDataURL(); }
      }
    } else {
      const img = await app.getFileIcon(p, { size: 'large' });
      if (img && !img.isEmpty()) url = img.toDataURL();
      if (process.platform === 'win32') {
        if (genericExeIcon === undefined) {
          try { const g = await app.getFileIcon('C:\\th-no-such-folder\\none.exe', { size: 'large' }); genericExeIcon = g && !g.isEmpty() ? g.toDataURL() : null; } catch { genericExeIcon = null; }
        }
        if (!url || (genericExeIcon && url === genericExeIcon)) url = (await extractIconWithPowerShell(p)) || url;
      }
    }
  } catch { /* a letter is shown instead */ }
  appIconCache.set(p, url);
  return url;
}

// Adding and removing apps rewrites the "apps" list in the settings file (a copy of the old file is kept the first time).
function writeAppsToConfig(list) {
  const file = configPath();
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backup = path.join(path.dirname(file), 'config.before-apps.bak.json');
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  cfg.apps = list;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  loadedConfig.apps = list;
}

// Change one part of the settings file safely: read it fresh, keep a copy of the old file, write a temp file and rename.
function updateConfigFile(mutator, backupName) {
  const file = configPath();
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backupName) {
    const backup = path.join(path.dirname(file), backupName);
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  mutator(cfg);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
  return cfg;
}

// Settings page saves keep the last ten copies of the file, newest first, in a "config-backups" folder next to it.
function backupConfigRolling() {
  const file = configPath();
  const dir = path.join(path.dirname(file), 'config-backups');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    fs.copyFileSync(file, path.join(dir, 'config-' + stamp + '.json'));
    const all = fs.readdirSync(dir).filter((n) => /^config-[\d-]+\.json$/.test(n)).sort().reverse();
    for (const old of all.slice(10)) fs.unlinkSync(path.join(dir, old));
  } catch { /* a missing backup should not stop a save, but the page tells the user nothing was lost */ }
}

// ---- Home page background picture ----
// A copy of the chosen picture lives in the app's data folder, so the original can move or be deleted.
const BG_MAX_BYTES = 8 * 1024 * 1024;
const BG_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function imageKind(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null; // anything else (including SVG, which can hold scripts) is refused
}
const clampDim = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(85, Math.round(v))) : 35; };
function clearBackgroundFiles() {
  for (const ext of Object.keys(BG_TYPES)) { try { fs.unlinkSync(path.join(app.getPath('userData'), 'home-background.' + ext)); } catch { /* not there */ } }
}
function homeBackground() {
  const c = loadedConfig && loadedConfig.homeBackground;
  if (!c || typeof c.file !== 'string' || !/^home-background\.(png|jpg|webp)$/.test(c.file)) return null;
  try {
    const file = path.join(app.getPath('userData'), c.file);
    if (fs.statSync(file).size > BG_MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    const kind = imageKind(buf);
    if (!kind) return null;
    return { dataUrl: 'data:' + BG_TYPES[kind] + ';base64,' + buf.toString('base64'), dim: clampDim(c.dim) };
  } catch { return null; }
}
function notifyHomeBackground() {
  const v = views.get('home');
  if (v && !v.webContents.isDestroyed()) v.webContents.send('home:bg');
}
function saveBackgroundSetting(value) {
  updateConfigFile((cfg) => { if (value) cfg.homeBackground = value; else delete cfg.homeBackground; });
  if (value) loadedConfig.homeBackground = value; else delete loadedConfig.homeBackground;
}

function startApp(id, fileArg) {
  const a = appList().find((x) => x.id === id);
  if (!a) return { ok: false, error: 'Unknown app.' };
  let st;
  try { st = fs.statSync(a.path); } catch { return { ok: false, error: a.name + ' was not found at ' + a.path }; }
  if (!st.isFile() || (process.platform === 'win32' && !/\.exe$/i.test(a.path))) return { ok: false, error: 'The path for ' + a.name + ' must be its .exe file.' };
  try {
    const child = require('child_process').spawn(a.path, fileArg ? [fileArg] : [], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* reported nowhere: the app simply did not start */ });
    child.unref();
    return { ok: true };
  } catch { return { ok: false, error: 'Could not start ' + a.name + '.' }; }
}


// ---- Moving, copying and dropping files (Explorer drag and drop) ----
// Nothing is ever overwritten (a name clash gets "(2)"), a folder cannot be put inside itself, and every destination is resolved inside a known folder or drive.
const sameOrInside = (child, parent) => {
  const n = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const c = n(child), p = n(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};
function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = ext && name.length > ext.length ? name.slice(0, -ext.length) : name;
  const tail = base === name ? '' : ext;
  for (let i = 2; i < 1000; i++) { const n = base + ' (' + i + ')' + tail; if (!fs.existsSync(path.join(dir, n))) return n; }
  return null;
}
function copyOrMove(srcReal, dstDirReal, copy) {
  let st;
  try { st = fs.lstatSync(srcReal); } catch { return { ok: false, error: 'That item was not found.' }; }
  if (st.isSymbolicLink()) return { ok: false, error: 'Shortcuts and links are not moved or copied from here.' };
  if (st.isDirectory() && sameOrInside(dstDirReal, srcReal)) return { ok: false, error: 'A folder cannot be put inside itself.' };
  if (!copy && sameOrInside(path.dirname(srcReal), dstDirReal) && sameOrInside(dstDirReal, path.dirname(srcReal))) return { ok: true, same: true };
  const name = freeName(dstDirReal, path.basename(srcReal));
  if (!name) return { ok: false, error: 'Too many items with that name in the destination.' };
  const target = path.join(dstDirReal, name);
  const cp = () => fs.cpSync(srcReal, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
  try {
    if (copy) cp();
    else {
      try { fs.renameSync(srcReal, target); }
      catch (err) { if (err.code !== 'EXDEV') throw err; cp(); fs.rmSync(srcReal, { recursive: true, force: false }); } // another drive: copy, then remove the original
    }
  } catch (err) {
    return { ok: false, error: 'Could not ' + (copy ? 'copy' : 'move') + ' ' + path.basename(srcReal) + (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') ? ': it is in use or protected.' : '.') };
  }
  return { ok: true, name };
}
let dragIcon = null;
function dragIconImage() {
  if (dragIcon) return dragIcon;
  let img = nativeImage.createFromPath(logoPath());
  if (!img.isEmpty()) img = img.resize({ width: 32, height: 32 });
  if (img.isEmpty()) img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  return (dragIcon = img);
}

// ---- Side by side: Workstation on the left half of the screen, a program from your Apps list on the right half ----
// The program's own window is moved with a short PowerShell step (the program name goes in through the environment, never into the script).
const SNAP_SCRIPT = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class THW { [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint f); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); }'; "
  + "$end = (Get-Date).AddSeconds(20); while ((Get-Date) -lt $end) { $p = Get-Process -Name $env:TH_PROC -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; "
  + "if ($p) { [THW]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [THW]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, [int]$env:TH_X, [int]$env:TH_Y, [int]$env:TH_W, [int]$env:TH_H, 68) | Out-Null; [THW]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'ok'; exit } Start-Sleep -Milliseconds 400 } 'timeout'";
let layoutBefore = null; // Workstation's size and place before it was snapped, so Restore can put it back
function snapRects() {
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const half = Math.floor(wa.width / 2);
  const left = { x: wa.x, y: wa.y, width: half, height: wa.height };
  const right = { x: wa.x + half, y: wa.y, width: wa.width - half, height: wa.height };
  const phys = process.platform === 'win32' && typeof screen.dipToScreenRect === 'function' ? screen.dipToScreenRect(win, right) : right;
  return { left, right: phys };
}
async function snapApp(id) {
  const a = appList().find((x) => x.id === id);
  if (!a) return { ok: false, error: 'Unknown app.' };
  if (process.platform !== 'win32' && !outlookRun) return { ok: false, error: 'Side by side is only available on Windows.' };
  if (!win || win.isDestroyed()) return { ok: false, error: 'No window.' };
  const proc = path.basename(a.path).replace(/\.exe$/i, '');
  if (!/^[\w .+-]{1,60}$/.test(proc)) return { ok: false, error: 'This program cannot be placed side by side.' };
  const started = startApp(id, null);
  if (!started.ok) return started;
  if (!layoutBefore) layoutBefore = { bounds: win.getBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
  if (win.isFullScreen()) win.setFullScreen(false);
  if (win.isMaximized()) win.unmaximize();
  if (win.isMinimized()) win.restore();
  const { left, right } = snapRects();
  win.setBounds(left);
  const out = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SNAP_SCRIPT],
      { timeout: 30000, windowsHide: true, env: { ...process.env, TH_PROC: proc, TH_X: String(right.x), TH_Y: String(right.y), TH_W: String(right.width), TH_H: String(right.height) } },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
  if (out !== 'ok') return { ok: true, snapped: true, note: a.name + ' did not show a window in time, so only Workstation was resized. Try Shift+click again once it has opened.' };
  return { ok: true, snapped: true };
}
function restoreLayout() {
  if (!layoutBefore || !win || win.isDestroyed()) return { ok: true };
  win.setBounds(layoutBefore.bounds);
  if (layoutBefore.maximized) win.maximize();
  layoutBefore = null;
  return { ok: true };
}

// ---- Open a file in Word / Excel / PowerPoint on the web ----
// The file is copied into your OneDrive "My files > Documents" folder (through your signed-in Microsoft session, using SharePoint's own upload
// call from a hidden window), then opened in the matching web tab. Nothing is overwritten: a name clash gets "(2)".
const WEB_APPS = { '.xlsx': 'excel', '.xls': 'excel', '.xlsb': 'excel', '.csv': 'excel', '.xltx': 'excel', '.docx': 'word', '.doc': 'word', '.dotx': 'word', '.rtf': 'word', '.pptx': 'powerpoint', '.ppt': 'powerpoint' };
const WEB_MAX_BYTES = 25 * 1024 * 1024;
async function uploadInPage(b64, name, folderRel, siteUrl) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const json = { Accept: 'application/json;odata=verbose' };
  const ci = await fetch(siteUrl + '/_api/contextinfo', { method: 'POST', headers: json, credentials: 'include' });
  if (!ci.ok) return { ok: false, error: 'Microsoft would not let this window upload (is the OneDrive tab signed in?).' };
  const digest = (await ci.json()).d.GetContextWebInformation.FormDigestValue;
  const clean = String(name).replace(/[#%&*{}\\:<>?\/|"~]/g, '_');
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  for (let i = 1; i <= 20; i++) {
    const n = i === 1 ? clean : stem + ' (' + i + ')' + ext;
    const url = siteUrl + "/_api/web/GetFolderByServerRelativeUrl('" + folderRel.replace(/'/g, "''") + "')/Files/add(url='" + n.replace(/'/g, "''") + "',overwrite=false)";
    const r = await fetch(url, { method: 'POST', headers: { ...json, 'X-RequestDigest': digest }, body: bin, credentials: 'include' });
    if (r.ok) { const d = (await r.json()).d; return { ok: true, name: n, uniqueId: d.UniqueId, serverRelativeUrl: d.ServerRelativeUrl }; }
    const text = await r.text();
    if (!/2130575257|already exists/i.test(text)) return { ok: false, error: 'OneDrive refused the upload (' + r.status + ').' };
  }
  return { ok: false, error: 'Too many files with that name in OneDrive Documents.' };
}
async function openInWeb(rootId, rel) {
  const r = resolveInProject(rootId, rel);
  if (r.error) return { ok: false, error: r.error };
  const ext = path.extname(r.real).toLowerCase();
  const kind = WEB_APPS[ext];
  if (!kind) return { ok: false, error: 'That type of file cannot be opened in Office on the web.' };
  let st;
  try { st = fs.statSync(r.real); } catch { return { ok: false, error: 'Not found.' }; }
  if (!st.isFile()) return { ok: false, error: 'Pick a file.' };
  if (st.size > WEB_MAX_BYTES) return { ok: false, error: 'That file is larger than 25 MB. Upload it in the OneDrive tab instead.' };
  const b64 = fs.readFileSync(r.real).toString('base64');
  const w = new BrowserWindow({ show: false, width: 900, height: 700, skipTaskbar: true, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  let site = null, up = null, seen = '';
  const siteFrom = (href) => {
    try {
      const u = new URL(href);
      const m = /^\/personal\/([^/]+)/i.exec(u.pathname);
      if (/\.sharepoint\.com$/i.test(u.hostname) && m) return { origin: u.origin, path: '/personal/' + m[1] };
    } catch { /* not a URL */ }
    return null;
  };
  try {
    const wc = w.webContents;
    wc.setUserAgent(chromeUserAgent());
    wc.setAudioMuted(true);
    // 1. The OneDrive tab, if it has already been opened and is showing your files, tells us where your OneDrive lives.
    const odSec = sections.find((x) => x.type === 'web' && /onedrive/i.test(x.label));
    const odView = odSec && views.get(odSec.id);
    if (odView && !odView.webContents.isDestroyed()) { site = siteFrom(odView.webContents.getURL()); if (!site) seen = hostOf(odView.webContents.getURL()); }
    // 2. Otherwise ask Microsoft, in a hidden window, where "OneDrive" goes.
    if (!site) {
      for (const start of ['https://www.office.com/launch/onedrive', 'https://www.microsoft365.com/launch/onedrive']) {
        wc.loadURL(start).catch(() => { /* redirects can abort the first load */ });
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
          await new Promise((res) => setTimeout(res, 800));
          const href = wc.getURL();
          seen = hostOf(href) || seen;
          site = siteFrom(href);
          if (site) break;
          if (/^login\.(microsoftonline|live)\.com$/i.test(hostOf(href)) && Date.now() - t0 > 12000) return { ok: false, error: 'Please sign in to Microsoft in the OneDrive or Inbox tab first, then try again.' };
        }
        if (site) break;
      }
    }
    if (!site) return { ok: false, error: 'Could not find your OneDrive address (Microsoft ended on ' + (seen || 'no page') + '). Open the OneDrive tab and show My files, then try again.' };
    if (hostOf(wc.getURL()) !== hostOf(site.origin)) {
      // The upload runs from a page on your own SharePoint address, so the hidden window has to be there.
      await wc.loadURL(site.origin + site.path + '/_layouts/15/onedrive.aspx').catch(() => { /* the page may redirect */ });
      if (hostOf(wc.getURL()) !== hostOf(site.origin)) return { ok: false, error: 'Could not open your OneDrive (Microsoft sent the window to ' + (hostOf(wc.getURL()) || 'no page') + '). Sign in again in the OneDrive tab and retry.' };
    }
    up = await wc.executeJavaScript('(' + uploadInPage.toString() + ')(' + [b64, path.basename(r.real), site.path + '/Documents', site.origin + site.path].map((x) => JSON.stringify(x)).join(',') + ')');
  } catch { return { ok: false, error: 'Could not send the file to OneDrive.' }; }
  finally { if (!w.isDestroyed()) w.destroy(); }
  if (!up || !up.ok) return { ok: false, error: (up && up.error) || 'Could not send the file to OneDrive.' };
  const url = site.origin + site.path + '/_layouts/15/Doc.aspx?sourcedoc=%7B' + encodeURIComponent(up.uniqueId) + '%7D&file=' + encodeURIComponent(up.name) + '&action=default&mobileredirect=true';
  const label = { excel: /excel/i, word: /word/i, powerpoint: /power ?point/i }[kind];
  const sec = sections.find((x) => x.type === 'web' && label.test(x.label));
  if (!sec) { openInBrowserTab(url); return { ok: true, name: up.name }; }
  if (currentId !== sec.id) selectBeside(sec.id);
  const v = views.get(sec.id);
  if (v && !v.webContents.isDestroyed()) v.webContents.loadURL(url).catch(() => { /* the page shows its own error */ });
  return { ok: true, name: up.name };
}

// ---- Project file browser ----------------------------------------------------------
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
  const proj = findRoot(id);
  if (!proj) return { error: 'Unknown folder.' };
  const clean = safeRel(rel);
  if (clean === null) return { error: 'That path is not allowed.' };
  let root;
  try { root = fs.realpathSync(proj.path); } catch { return { error: 'Folder not found: ' + proj.path }; }
  const target = path.join(root, ...clean.split('/').filter(Boolean));
  let real;
  try { real = fs.realpathSync(target); } catch { return { error: 'Not found.' }; }
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep; // a drive root such as C:\ already ends with a separator
  if (norm(real) !== norm(root) && !norm(real).startsWith(norm(rootWithSep))) return { error: 'That path is outside this folder.' };
  if (proj.kind === 'drive') {
    const inside = norm(real) === norm(root) ? [] : real.slice(rootWithSep.length).split(path.sep).filter(Boolean);
    if (clean.split('/').some(isBlockedName) || inside.some(isBlockedName)) return { error: 'That folder is not available here.' };
  }
  return { root, real, clean, kind: proj.kind };
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
    if (r.kind === 'drive' && isBlockedName(d.name)) continue;
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
  // A hidden window drawn off-screen (no real window). Microsoft's task list only fills in when the page
  // believes it is visible, so it must not be parked outside the screen or hidden the normal way.
  todoView = new BrowserWindow({
    show: false, width: 1200, height: 900, skipTaskbar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  const wc = todoView.webContents;
  wc.setUserAgent(chromeUserAgent());
  wc.setAudioMuted(true);
  wc.setFrameRate(4);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (!isInternal(url)) event.preventDefault(); });
  return todoView;
}

let todoLock = Promise.resolve();
function withTodoLock(fn) {
  const run = todoLock.then(fn, fn);
  todoLock = run.catch(() => {});
  return run;
}
function scrapeTodo(routes, source) { return withTodoLock(() => scrapeTodoNow(routes, source)); }

// Ticks one open task in Microsoft To Do by driving the same signed-in page the reader uses.
function completeTodo(title) {
  return withTodoLock(async () => {
    if (!win || win.isDestroyed()) return { ok: false, error: 'The window is not ready.' };
    const wc = ensureTodoView().webContents;
    try {
      await wc.loadURL(process.env.CC_TEST_SCRIPT && process.env.CC_TEST_TODO_URL ? process.env.CC_TEST_TODO_URL : 'https://to-do.office.com/tasks/inbox');
      const src = completeSource(title);
      const started = Date.now();
      let r = null;
      while (Date.now() - started < 20000) {
        await new Promise((res) => setTimeout(res, 1500));
        r = await wc.executeJavaScript(src);
        if (r && (r.state === 'signin' || r.clicked)) break;
      }
      if (!r || r.state === 'signin') return { ok: false, error: 'Please sign in to Microsoft in the Inbox tab first.' };
      if (!r.clicked) return { ok: false, error: 'Could not find that task in Microsoft To Do. It may be on another list or already ticked.' };
      await new Promise((res) => setTimeout(res, 2000));
      const after = await wc.executeJavaScript(TODO_SOURCE);
      const still = after && (after.tasks || []).some((t) => !t.done && t.title.slice(0, 300) === String(title).slice(0, 300));
      if (still) return { ok: false, error: 'Microsoft did not confirm the tick. Please check To Do.' };
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach Microsoft To Do.' };
    }
  });
}

async function scrapeTodoNow(routes, source) {
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

function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function isVaultUrl(url) { return VAULT_HOSTS.test(hostOf(url)); }

// Extra sites a tab may move to, from the optional "allowedHosts" list in the settings file (for example a company sign-in provider).
function extraHostAllowed(url) {
  const host = hostOf(url);
  const list = loadedConfig && Array.isArray(loadedConfig.allowedHosts) ? loadedConfig.allowedHosts : [];
  return !!host && list.some((h) => typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h) && (host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase())));
}

// A web tab stays on its own site (and the Microsoft/Claude/DOMO sign-in sites). Anything else opens in the Browser tab.
function allowedForSection(section, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') return false;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (isVaultUrl(section.url)) return isVaultUrl(url);        // the vault never leaves its own site
  const own = hostOf(section.url).replace(/^www\./, '');
  const host = u.hostname.toLowerCase();
  return isInternal(url) || (!!own && (host === own || host === 'www.' + own || host.endsWith('.' + own))) || extraHostAllowed(url);
}

function openInBrowserTab(url) {
  if (!/^https?:/i.test(url)) return;
  const sec = sections.find((x) => x.type === 'browser');
  if (sec) select(sec.id); // also creates the Browser tab the first time
  if (sec && browserService) browserService.newTab(url); else shell.openExternal(url);
}

// Sign-in cookies that have no end date normally vanish when the app closes. For the sites listed in "keepSignedIn"
// (DOMO by default) they are given an end date, so you stay signed in between restarts.
function keepSignedIn(ses, hosts) {
  const wanted = (hosts || []).filter((h) => typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h)).map((h) => h.toLowerCase());
  if (!wanted.length) return;
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed || !cookie.session) return;
    const dom = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!wanted.some((h) => dom === h || dom.endsWith('.' + h))) return;
    const details = {
      url: (cookie.secure ? 'https://' : 'http://') + dom + (cookie.path || '/'),
      name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: !!cookie.secure, httpOnly: !!cookie.httpOnly,
      expirationDate: Math.floor(Date.now() / 1000) + KEEP_SIGNED_IN_DAYS * 86400,
    };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite;
    ses.cookies.set(details).catch(() => { /* the cookie simply stays a session cookie */ });
  });
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

function isBrowserSection(id) { const sec = sections.find((x) => x.id === id); return !!(sec && sec.type === 'browser' && browserService); }

// ---- Screen lock (see lock.js) ----
let lockSvc = null;
let lockView = null;
let locked = false;
function lockService() { return lockSvc || (lockSvc = createLock({ file: path.join(app.getPath('userData'), 'lock.json') })); }
function fromLock(e) { return !!(locked && lockView && e.sender === lockView.webContents); }
function raiseLock() {
  if (!locked || !lockView || !win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  win.contentView.addChildView(lockView); // adding it again moves it to the front
  lockView.setBounds({ x: 0, y: 0, width: w, height: h });
}
function lockNow() {
  if (locked || !win || win.isDestroyed() || !lockService().active()) return false;
  closePalette(false);
  lockView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-lock.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  lockView.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1319' : '#e5eaf1');
  const wc = lockView.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.loadFile(path.join(__dirname, 'renderer', 'lock.html'));
  locked = true;
  raiseLock();
  wc.focus();
  return true;
}
function unlockNow() {
  if (!locked) return;
  locked = false;
  if (lockView) {
    try { win.contentView.removeChildView(lockView); } catch { /* window already closing */ }
    if (!lockView.webContents.isDestroyed()) lockView.webContents.close();
    lockView = null;
  }
  const v = currentId && views.get(currentId);
  if (currentId && isBrowserSection(currentId)) browserService.focusContent();
  else if (v) v.webContents.focus();
}
function idleCheck(idleSeconds) {
  if (locked || !lockService().active()) return false;
  const idle = idleSeconds == null ? powerMonitor.getSystemIdleTime() : idleSeconds;
  if (idle >= lockService().minutes() * 60) return lockNow();
  return false;
}

// Two tabs side by side: the current tab on the left, the second tab on the right
function splitRects() {
  if (!win || !secondId || !views.has(secondId)) return null;
  const b = stageBounds();
  const w = Math.max(0, Math.floor((b.width - GAP) / 2));
  return { a: { ...b, width: w }, b: { ...b, x: b.x + w + GAP, width: Math.max(0, b.width - w - GAP) } };
}
function notifySplit() { if (win && !win.isDestroyed()) win.webContents.send('cc:split', secondId); }
function closeSecond() {
  if (!secondId) return;
  const v = views.get(secondId);
  if (v && win && !win.isDestroyed()) { try { win.contentView.removeChildView(v); } catch { /* already gone */ } }
  secondId = null;
  layout();
  notifySplit();
}
function selectBeside(id) {
  const section = sections.find((x) => x.id === id);
  if (!win || !section || section.type === 'disabled' || section.type === 'browser' || !currentId || id === currentId) return false;
  if (isBrowserSection(currentId)) { select(id); return true; } // the Browser tab cannot be split; just go there
  if (secondId && secondId !== id && views.has(secondId)) { try { win.contentView.removeChildView(views.get(secondId)); } catch { /* already gone */ } }
  if (!views.has(id)) views.set(id, createView(section));
  secondId = id;
  win.contentView.addChildView(views.get(id));
  if (paletteOpen && paletteView) win.contentView.addChildView(paletteView);
  if (locked) raiseLock();
  layout();
  notifySplit();
  return true;
}

function layout() {
  if (!win) return;
  if (locked) raiseLock();
  const sp = splitRects();
  if (currentId && views.has(currentId)) { views.get(currentId).setBounds(sp ? sp.a : stageBounds()); if (isBrowserSection(currentId)) browserService.layout(); }
  if (sp) views.get(secondId).setBounds(sp.b);
  if (paletteOpen && paletteView) paletteView.setBounds(paletteBounds());
}

function rounded(view) {
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(RADIUS);
}

function createBrowserView(section) {
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-browser.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  rounded(view);
  const wc = view.webContents;
  browserShellIds.add(wc.id); // the toolbar page may drive the tabs; it is not a "local" page and gets no data bridge
  wc.once('destroyed', () => browserShellIds.delete(wc.id));
  wc.loadFile(path.join(__dirname, 'renderer', 'browser.html'));
  wc.on('will-navigate', (event) => event.preventDefault()); // the toolbar page never navigates
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  browserService = createBrowser({
    shellView: view, WebContentsView, Menu, shell,
    attachView: (v) => { rounded(v); win.contentView.addChildView(v); if (paletteOpen && paletteView) win.contentView.addChildView(paletteView); },
    detachView: (v) => { try { win.contentView.removeChildView(v); } catch { /* already gone */ } },
    stageBounds,
    session: session.fromPartition(BROWSER_PARTITION), partition: BROWSER_PARTITION,
    userAgent: chromeUserAgent(),
    historyFile: path.join(app.getPath('userData'), 'browser-history.json'),
    startUrl: section.url,
  });
  return view;
}

function createView(section) {
  if (section.type === 'browser') return createBrowserView(section);
  const view = new WebContentsView({
    webPreferences: {
      partition: section.type === 'web' ? (isVaultUrl(section.url) ? VAULT_PARTITION : PARTITION) : section.type === 'drmd' ? DRMD_PARTITION : undefined,
      preload: section.type === 'local' ? path.join(__dirname, 'preload-local.js') : section.type === 'drmd' ? path.join(__dirname, 'preload-drmd.js') : undefined,
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
  if (section.type === 'drmd') {
    drmdContentsIds.add(wc.id);
    wc.once('destroyed', () => drmdContentsIds.delete(wc.id));
    if (fs.existsSync(path.join(DRMD_DIR, '_shell.html'))) wc.loadURL(DRMD_URL);
    else wc.loadFile(path.join(__dirname, 'renderer', 'drmd-missing.html'));
    wc.setWindowOpenHandler(({ url }) => {
      if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (url.startsWith(DRMD_URL)) return;
      event.preventDefault();
      if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    });
    return view;
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

  if (section.type === 'web') {
    const guard = (event, url) => {
      if (allowedForSection(section, url)) return;
      event.preventDefault();
      openInBrowserTab(url);
    };
    wc.on('will-navigate', guard);
    if (isVaultUrl(section.url)) wc.on('will-redirect', guard);
  }
  wc.on('will-navigate', (event, url) => {
    if (section.type === 'local' && !url.startsWith('file:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return view;
}

// Alt+Q: back to the tab you were on before this one. Pressing it again comes back.
function goBackSection() {
  const target = previousId && sections.find((x) => x.id === previousId && x.type !== 'disabled');
  if (!target || target.id === currentId) return false;
  select(target.id);
  return true;
}

function enabledSections() { return sections.filter((x) => x.type !== 'disabled' && x.id !== 'settings'); }

function deliverParams(view, params) {
  const wc = view.webContents;
  const send = () => { if (!wc.isDestroyed()) wc.send('nav:params', params); };
  if (wc.isLoading()) wc.once('did-finish-load', send); else send();
}

function select(id, params) {
  const section = sections.find((x) => x.id === id);
  if (!section || section.type === 'disabled' || !win) return;
  if (section.type === 'browser') closeSecond();           // the Browser tab always has the whole area
  else if (id === secondId) { secondId = null; notifySplit(); } // the tab on the right becomes the main one

  if (currentId && currentId !== id && views.has(currentId)) {
    if (isBrowserSection(currentId)) browserService.detach();
    win.contentView.removeChildView(views.get(currentId));
  }
  if (!views.has(id)) views.set(id, createView(section));

  const view = views.get(id);
  win.contentView.addChildView(view);
  view.setBounds(stageBounds());
  if (section.type === 'browser') browserService.attach();
  if (paletteOpen && paletteView) win.contentView.addChildView(paletteView); // keep the palette on top
  if (locked) raiseLock();
  if (currentId && currentId !== id) previousId = currentId;
  currentId = id;
  if (secondId) layout();
  win.webContents.send('cc:selected', id);
  if (params) deliverParams(view, params);
  if (!paletteOpen) { if (section.type === 'browser') browserService.focusContent(); else view.webContents.focus(); }
}

// ---- theme and logo ----
function applyTheme() {
  nativeTheme.themeSource = ui.get().theme; // 'system' | 'light' | 'dark'; web pages that support it follow along
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0f1319' : '#e5eaf1');
}

// Rail logo: thumbnail.png if present, otherwise transformHub.png. Window and taskbar icon: thumbnail.ico first.
function firstExisting(names) { for (const n of names) { const p = path.join(__dirname, n); if (fs.existsSync(p)) return p; } return null; }
function logoPath() { return firstExisting(['thumbnail.png', 'transformHub.png']) || path.join(__dirname, 'transformHub.png'); }
function windowIconPath() { return firstExisting(['thumbnail.ico', 'transformHub.ico', 'thumbnail.png', 'transformHub.png']); }

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
  if (currentId && isBrowserSection(currentId)) { browserService.reload(); return; }
  const v = currentId && views.get(currentId);
  if (v) v.webContents.reload();
}

function isWebContents(contents) {
  if (browserShellIds.has(contents.id) || (browserService && browserService.owns(contents))) return true; // the Browser tab follows the web-site key rules
  for (const [id, view] of views) {
    const sec = sections.find((x) => x.id === id);
    if (sec && (sec.type === 'web' || sec.type === 'drmd') && view.webContents === contents) return true;
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

  // Browser tab: the usual browser keys, only while its toolbar or one of its pages has the focus
  if (currentId && isBrowserSection(currentId) && web) {
    const shellWc = views.get(currentId).webContents;
    if (ctrlOnly && key === 't') { browserService.newTab(); shellWc.send('browser:focus-address'); shellWc.focus(); return true; }
    if (ctrlOnly && key === 'w') { browserService.closeTab(browserService.state().activeId); return true; }
    if ((ctrlOnly && key === 'l') || (altOnly && key === 'd')) { shellWc.focus(); shellWc.send('browser:focus-address'); return true; }
    if (altOnly && key === 'arrowleft') { browserService.back(); return true; }
    if (altOnly && key === 'arrowright') { browserService.forward(); return true; }
    if (ctrlOnly && key === 'r') { browserService.reload(); return true; }
    if (input.control && !input.alt && !input.meta && key === 'tab') { browserService.cycle(input.shift ? -1 : 1); return true; }
  }

  if (key === 'q' && altOnly) { goBackSection(); return true; } // back to the previous tab
  if (key === 'l' && ctrlShift) { lockNow(); return true; } // lock the screen (only when a PIN is set up in Settings)

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
    title: 'Transform Workstation ' + app.getVersion(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1319' : '#e5eaf1',
    icon: windowIconPath() || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);

  // Windows: tell the taskbar which icon and which start command belong to this window, so a pinned button
  // keeps the Transform Workstation icon instead of falling back to electron.exe's.
  if (process.platform === 'win32') {
    const ico = firstExisting(['thumbnail.ico', 'transformHub.ico']);
    if (ico) {
      try {
        win.setAppDetails({
          appId: 'au.com.transformhomes.transformhub',
          appIconPath: ico, appIconIndex: 0,
          relaunchCommand: '"' + process.execPath + '" "' + app.getAppPath() + '"',
          relaunchDisplayName: 'Transform Workstation',
        });
      } catch (err) { console.error('Could not set the taskbar details:', err.message); }
    }
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  localContentsIds.add(win.webContents.id);
  win.on('page-title-updated', (e) => e.preventDefault()); // keep the version in the title
  win.on('resize', layout);
  win.on('focus', () => { if (locked && lockView && !lockView.webContents.isDestroyed()) lockView.webContents.focus(); });

  win.webContents.once('did-finish-load', () => {
    const cfg = loadedConfig;
    const start = sections.find((s) => s.id === (process.env.CC_TEST_SECTION || cfg.startSection) && s.type !== 'disabled')
      || sections.find((s) => s.type !== 'disabled');
    if (start) select(start.id);
    if (!process.env.CC_TEST_SCRIPT) lockNow(); // a PIN, once set up, is also asked for at start-up

    if (process.env.CC_TEST_SCRIPT) {
      // Test hook only (never set in normal use): run a script that can drive the app.
      const ctx = {
        select, goBackSection, previous: () => previousId, views, store, sections, win, app, feeds: feedService, config: loadedConfig,
        ui, handleKey, todo: () => todoService, cacheFavicon, favicons: () => favicons, openPalette, closePalette, toggleFeed, stageBounds, paletteBounds,
        palette: () => ({ view: paletteView, open: paletteOpen }),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        current: () => currentId,
        browser: () => browserService,
        nav: { allowedForSection, openInBrowserTab },
        lock: { service: lockService, now: lockNow, isLocked: () => locked, idleCheck, view: () => lockView },
        setPickFolder: (fn) => { testPickFolder = fn; },
        setPickImage: (fn) => { testPickImage = fn; },
        setRecent: (run) => { recentSvc = createRecent({ run, ttl: 0 }); },
        setFileSearch: (run) => { fileSearch = createFileSearch({ run }); },
        setPickApp: (fn) => { testPickApp = fn; },
        setSpawn: (fn) => { spawnShell = fn; },
        setOutlookRun: (fn) => { outlookRun = fn; outlookService = null; },
        setDialogs: (d) => { testDialogs = d; },
      };
      Promise.resolve(require(process.env.CC_TEST_SCRIPT)(ctx))
        .catch((err) => { console.error('TEST SCRIPT FAILED:', err); process.exitCode = 1; })
        .finally(() => app.quit());
    }
  });

  win.on('closed', () => { win = null; if (todoView && !todoView.isDestroyed()) todoView.destroy(); });
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
    // Serve the built Dr. MD page at drmd://app/ (only files inside the drmd folder; any other path gets the app shell).
    session.fromPartition(DRMD_PARTITION).protocol.handle('drmd', async (request) => {
      const withCsp = (res) => {
        const headers = new Headers(res.headers);
        headers.set('Content-Security-Policy', DRMD_CSP);
        return new Response(res.body, { status: res.status, headers });
      };
      try {
        const u = new URL(request.url);
        if (u.hostname !== 'app') return new Response('Not found', { status: 404 });
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
        let file = path.resolve(DRMD_DIR, rel || '_shell.html');
        const inside = (f) => f === DRMD_DIR || f.startsWith(DRMD_DIR + path.sep);
        if (!inside(file)) return new Response('Not found', { status: 404 });
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          if (path.extname(rel)) return new Response('Not found', { status: 404 });
          file = path.join(DRMD_DIR, '_shell.html'); // a page route: let the app handle it
        }
        return withCsp(await net.fetch(pathToFileURL(file).href));
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });

    drmdService = createDrmd({
      stateFile: path.join(app.getPath('userData'), 'drmd-recents.json'),
      backupDir: path.join(app.getPath('userData'), 'drmd-backups'),
      showOpen: async () => {
        if (testDialogs) return testDialogs.open();
        const r = await dialog.showOpenDialog(win, { title: 'Open a Markdown file', properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
      },
      showSave: async (suggested) => {
        if (testDialogs) return testDialogs.save(suggested);
        const r = await dialog.showSaveDialog(win, { title: 'Save note', defaultPath: path.join(app.getPath('documents'), suggested), filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    });
    const fromDrmd = (e) => drmdContentsIds.has(e.sender.id) && e.senderFrame && String(e.senderFrame.url).startsWith(DRMD_URL);
    const idOk = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64;
    const NOPE = { ok: false, error: 'Not allowed.' };
    ipcMain.handle('drmd:open', (e) => (fromDrmd(e) ? drmdService.open() : NOPE));
    ipcMain.handle('drmd:open-recent', (e, id) => (fromDrmd(e) && idOk(id) ? drmdService.openRecent(id) : NOPE));
    ipcMain.handle('drmd:reload', (e, id) => (fromDrmd(e) && idOk(id) ? drmdService.reload(id) : NOPE));
    ipcMain.handle('drmd:recents', (e) => (fromDrmd(e) ? drmdService.recents() : []));
    ipcMain.handle('drmd:forget', (e, id) => (fromDrmd(e) && idOk(id) ? drmdService.forget(id) : []));
    ipcMain.handle('drmd:save', (e, id, text, mtime) => (fromDrmd(e) && idOk(id) && typeof text === 'string' && Number.isFinite(mtime) ? drmdService.save(id, text, mtime) : NOPE));
    ipcMain.handle('drmd:save-as', (e, name, text) => (fromDrmd(e) && typeof text === 'string' && (name === undefined || typeof name === 'string') ? drmdService.saveAs(name, text) : NOPE));
    ipcMain.handle('cc:reorder-sections', (e, ids) => {
      if (!isLocalSender(e) || !Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return { ok: false, error: 'Not allowed.' };
      const shown = sections.filter((x) => x.id !== 'settings');
      if (new Set(ids).size !== ids.length || ids.length !== shown.length || !shown.every((x) => ids.includes(x.id))) return { ok: false, error: 'That order does not match your tabs.' };
      const byId = new Map(sections.map((x) => [x.id, x]));
      const next = [...ids.map((x) => byId.get(x)), ...sections.filter((x) => x.id === 'settings')];
      try {
        updateConfigFile((cfg) => {
          const rank = new Map(next.map((x, i) => [x.id, i]));
          const file = Array.isArray(cfg.sections) ? cfg.sections : [];
          cfg.sections = file.slice().sort((a, b) => (rank.has(a && a.id) ? rank.get(a.id) : 999) - (rank.has(b && b.id) ? rank.get(b.id) : 999));
        }, 'config.before-reorder.bak.json');
      } catch { return { ok: false, error: 'Could not save your settings file.' }; }
      sections = next;
      loadedConfig.sections = next;
      return { ok: true };
    });
    // ---- Settings page ----
    const readConfigFile = () => JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const sectionsSig = (list) => JSON.stringify(list.filter((s) => s.id !== 'settings').map((s) => [s.id, s.label, s.icon, s.type, s.url || '', s.file || '', s.iconFile || '']));
    const defaultSections = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')).sections;
    ipcMain.handle('settings:get', (e) => {
      if (!isLocalSender(e)) return null;
      let raw = '';
      try { raw = fs.readFileSync(configPath(), 'utf8'); } catch { /* shown as empty */ }
      const c = loadedConfig;
      let fileSections = sections;
      try { fileSections = cleanSections(JSON.parse(raw).sections, defaultSections()); } catch { /* show the running tabs */ }
      return {
        userName: String(c.userName || ''),
        spellCheckLanguage: (Array.isArray(c.spellCheckLanguages) && c.spellCheckLanguages[0]) || 'en-AU',
        outlookDesktop: c.outlookDesktop !== false,
        startSection: c.startSection || 'home',
        calendarFeeds: validFeeds(c.calendarFeeds),
        projects: (c.projects || []).filter((p) => p && p.id && p.name).map((p) => ({ id: String(p.id), name: String(p.name), path: String(p.path || '') })),
        restartPending: sectionsSig(fileSections) !== sectionsSig(sections),
        sections: fileSections.filter((s) => s.id !== 'settings').map((s) => ({ id: s.id, label: s.label, icon: s.icon, type: s.type, url: s.url || '', hidden: s.type === 'disabled', canRemove: s.type === 'web', canHide: s.type !== 'web' && s.id !== 'home' })),
        raw, version: app.getVersion(), file: configPath(), platform: process.platform,
      };
    });
    ipcMain.handle('settings:save', (e, patch) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      let cur;
      try { cur = readConfigFile(); } catch { return { ok: false, error: 'Your settings file could not be read, so nothing was changed.' }; }
      const defs = defaultSections();
      const r = buildSettings(patch, { current: cur, sections: cleanSections(cur.sections, defs), live: sections, defaults: defs, cleanSections, validFeeds });
      if (!r.ok) return r;
      backupConfigRolling();
      try { updateConfigFile((cfg) => { Object.assign(cfg, r.config); }); } catch { return { ok: false, error: 'Could not save your settings file.' }; }
      const { sections: _newTabs, ...liveChanges } = r.config; // the running tabs are replaced after a restart
      Object.assign(loadedConfig, liveChanges);
      for (const ses of [session.defaultSession, session.fromPartition(PARTITION), session.fromPartition(DRMD_PARTITION), session.fromPartition(BROWSER_PARTITION)]) setupSpellcheck(ses, loadedConfig.spellCheckLanguages || ['en-AU']);
      if (outlookService) outlookService = null;
      if (feedService && r.feedsChanged) feedService.refresh();
      return { ok: true, restartNeeded: r.restartNeeded };
    });
    ipcMain.handle('settings:save-raw', (e, text) => {
      if (!isLocalSender(e) || typeof text !== 'string' || text.length > 500000) return { ok: false, error: 'Not allowed.' };
      const err = rawSettingsError(text, { configVersion: CONFIG_VERSION, cleanSections, defaults: defaultSections() });
      if (err) return { ok: false, error: err };
      backupConfigRolling();
      try {
        const tmp = configPath() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(JSON.parse(text), null, 2));
        fs.renameSync(tmp, configPath());
      } catch { return { ok: false, error: 'Could not save your settings file.' }; }
      return { ok: true, restartNeeded: true };
    });
    ipcMain.handle('settings:pick-folder', async (e) => {
      if (!isLocalSender(e)) return null;
      if (testPickFolder) return testPickFolder();
      const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('settings:restore-defaults-info', (e) => (isLocalSender(e) ? { backups: (() => { try { return fs.readdirSync(path.join(path.dirname(configPath()), 'config-backups')).filter((n) => /^config-[\d-]+\.json$/.test(n)).sort().reverse().slice(0, 10); } catch { return []; } })() } : null));
    ipcMain.on('app:restart', (e) => { if (isLocalSender(e) && !process.env.CC_TEST_SCRIPT) { app.relaunch(); app.exit(0); } });
    ipcMain.handle('cc:sections', (e) => (isLocalSender(e) ? sections.map((x) => ({ id: x.id, label: x.label, icon: x.icon, type: x.type })) : []));
    ipcMain.on('cc:back', (e) => { if (isLocalSender(e)) goBackSection(); });
    ipcMain.on('cc:select', (e, id) => { if (isLocalSender(e) && typeof id === 'string') select(id); });
    ipcMain.on('cc:select-beside', (e, id) => { if (isLocalSender(e) && typeof id === 'string') selectBeside(id); });
    ipcMain.on('cc:close-split', (e) => { if (isLocalSender(e)) closeSecond(); });
    ipcMain.handle('cc:split-state', (e) => (isLocalSender(e) ? secondId : null));
    ipcMain.on('cc:navigate', (e, p) => {
      if (!isLocalSender(e) || !p || typeof p.section !== 'string') return;
      const params = {};
      if (typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) params.date = p.date;
      if (typeof p.project === 'string' && p.project.length <= 100) params.project = p.project;
      if (typeof p.path === 'string' && safeRel(p.path) !== null) params.path = safeRel(p.path);
      select(p.section, Object.keys(params).length ? params : undefined);
      if (win && !win.isDestroyed()) win.webContents.send('cc:nav', { section: p.section, ...params });
    });
    ipcMain.handle('explorer:roots', (e) => {
      if (!isLocalSender(e)) return null;
      const projects = (loadedConfig.projects || []).filter((p) => p && p.id && p.name).map((p) => ({ id: String(p.id), name: String(p.name), path: String(p.path || '') }));
      const favs = ui.get().favs.filter((f) => findRoot(f.root));
      return { projects, drives: driveRoots(), favs, apps: appList().map((x) => ({ id: x.id, name: x.name, label: x.label, types: x.types })) };
    });
    ipcMain.handle('explorer:fav', (e, root, rel, name) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(root, rel);
      if (r.error) return { ok: false, error: r.error };
      if (!r.clean) return { ok: false, error: 'Pick a folder inside it.' };
      let isDir = false;
      try { isDir = fs.statSync(r.real).isDirectory(); } catch { /* handled below */ }
      if (!isDir) return { ok: false, error: 'Only folders can be favourites.' };
      const favs = ui.get().favs;
      const has = favs.some((f) => f.root === root && f.rel === r.clean);
      const label = String(name || '').trim().slice(0, 80) || r.clean.split('/').pop();
      const next = has ? favs.filter((f) => !(f.root === root && f.rel === r.clean)) : [...favs, { root, rel: r.clean, name: label }];
      ui.set({ favs: next });
      if (win && !win.isDestroyed()) win.webContents.send('ui:changed', ui.get());
      return { ok: true, pinned: !has, favs: ui.get().favs };
    });
    ipcMain.handle('app:icons', async (e) => {
      if (!isLocalSender(e)) return {};
      const out = {};
      for (const a of appList()) { const u = await appIcon(a.icon || a.path); if (u) out[a.id] = u; }
      return out;
    });
    ipcMain.handle('app:add', async (e) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const raw = Array.isArray(loadedConfig.apps) ? loadedConfig.apps.slice() : [];
      if (raw.length >= MAX_APPS) return { ok: false, error: 'You can have up to ' + MAX_APPS + ' apps.' };
      let picked;
      if (testPickApp) picked = await testPickApp();
      else {
        const r = await dialog.showOpenDialog(win, { title: 'Choose a program to add', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }], defaultPath: process.env.ProgramFiles || undefined });
        picked = r.canceled ? null : r.filePaths[0];
      }
      if (!picked) return { ok: true, cancelled: true };
      if (typeof picked !== 'string' || !path.isAbsolute(picked) || (process.platform === 'win32' && !/\.exe$/i.test(picked))) return { ok: false, error: 'Please choose a program (.exe file).' };
      try { if (!fs.statSync(picked).isFile()) throw new Error('x'); } catch { return { ok: false, error: 'That file was not found.' }; }
      if (raw.some((a) => a && typeof a.path === 'string' && a.path.toLowerCase() === picked.toLowerCase())) return { ok: false, error: 'That program is already in your list.' };
      let name = path.basename(picked).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 40) || 'App';
      name = name.charAt(0).toUpperCase() + name.slice(1);
      if (/^explorer\.exe$/i.test(path.basename(picked))) name = 'File Explorer';
      const taken = new Set(raw.map((a) => a && typeof a.name === 'string' ? appIdFor(a.name) : ''));
      let candidate = name, n = 2;
      while (taken.has(appIdFor(candidate))) candidate = name.slice(0, 36) + ' ' + n++;
      try { writeAppsToConfig([...raw, { name: candidate, path: picked, types: [] }]); } catch { return { ok: false, error: 'Could not save your settings file.' }; }
      return { ok: true, name: candidate };
    });
    ipcMain.handle('app:remove', (e, id) => {
      if (!isLocalSender(e) || typeof id !== 'string') return { ok: false, error: 'Not allowed.' };
      const raw = Array.isArray(loadedConfig.apps) ? loadedConfig.apps : [];
      const next = raw.filter((a) => !(a && typeof a.name === 'string' && appIdFor(a.name) === id));
      if (next.length === raw.length) return { ok: false, error: 'Unknown app.' };
      try { writeAppsToConfig(next); } catch { return { ok: false, error: 'Could not save your settings file.' }; }
      return { ok: true };
    });
    ipcMain.handle('app:reorder', (e, ids) => {
      if (!isLocalSender(e) || !Array.isArray(ids) || ids.length > MAX_APPS || !ids.every((x) => typeof x === 'string')) return { ok: false, error: 'Not allowed.' };
      const raw = Array.isArray(loadedConfig.apps) ? loadedConfig.apps : [];
      const idOf = (a) => (a && typeof a.name === 'string' ? appIdFor(a.name) : null);
      const byId = new Map();
      for (const a of raw) { const id = idOf(a); if (id && !byId.has(id)) byId.set(id, a); }
      if (new Set(ids).size !== ids.length || !ids.every((x) => byId.has(x))) return { ok: false, error: 'That order does not match your apps.' };
      const picked = new Set(ids.map((x) => byId.get(x)));
      const next = [...ids.map((x) => byId.get(x)), ...raw.filter((a) => !picked.has(a))]; // entries that are not shown stay at the end
      try { updateConfigFile((cfg) => { cfg.apps = next; }, 'config.before-reorder.bak.json'); loadedConfig.apps = next; } catch { return { ok: false, error: 'Could not save your settings file.' }; }
      return { ok: true };
    });
    ipcMain.handle('app:snap', (e, id) => (isLocalSender(e) && typeof id === 'string' ? snapApp(id) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('app:restore-layout', (e) => (isLocalSender(e) ? restoreLayout() : { ok: false }));
    ipcMain.handle('app:layout-state', (e) => (isLocalSender(e) ? { snapped: !!layoutBefore } : null));
    ipcMain.handle('app:launch', (e, id) => (isLocalSender(e) && typeof id === 'string' ? startApp(id, null) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('app:open-with', (e, id, root, rel) => {
      if (!isLocalSender(e) || typeof id !== 'string') return { ok: false, error: 'Not allowed.' };
      const a = appList().find((x) => x.id === id);
      if (!a) return { ok: false, error: 'Unknown app.' };
      const r = resolveInProject(root, rel);
      if (r.error) return { ok: false, error: r.error };
      let isFile = false;
      try { isFile = fs.statSync(r.real).isFile(); } catch { /* handled below */ }
      const ext = path.extname(r.real).toLowerCase();
      if (!isFile || !a.types.includes(ext) || RISKY_EXT.has(ext)) return { ok: false, error: a.name + ' is not set up to open this type of file.' };
      return startApp(id, r.real);
    });
    ipcMain.handle('fs:list', (e, id, rel) => (isLocalSender(e) ? listDir(id, rel) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('fs:read', (e, id, rel) => (isLocalSender(e) ? readPreview(id, rel) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('fs:open', async (e, id, rel) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(id, rel);
      if (r.error) return { ok: false, error: r.error };
      let isDir = false;
      try { isDir = fs.statSync(r.real).isDirectory(); } catch { return { ok: false, error: 'Not found.' }; }
      if (!isDir && RISKY_EXT.has(path.extname(r.real).toLowerCase())) return { ok: false, error: 'For safety, programs and scripts are not run from here. Use Show in File Explorer instead.' };
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
    // Right-click menu in the Explorer: PowerShell here, copy path, properties. All paths go through resolveInProject.
    ipcMain.handle('fs:powershell', (e, id, rel) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(id, rel);
      if (r.error) return { ok: false, error: r.error };
      let dir;
      try { dir = fs.statSync(r.real).isDirectory() ? r.real : path.dirname(r.real); } catch { return { ok: false, error: 'Not found.' }; }
      if (process.platform !== 'win32' && !spawnShell) return { ok: false, error: 'PowerShell is only available on Windows.' };
      try {
        // fixed arguments only; the folder is passed as the working directory, never as part of a command
        const child = (spawnShell || require('child_process').spawn)('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit'], { cwd: dir, detached: true, stdio: 'ignore' });
        child.on('error', () => { /* nothing more to do */ });
        child.unref();
        return { ok: true };
      } catch { return { ok: false, error: 'Could not start PowerShell.' }; }
    });
    ipcMain.handle('fs:copy-path', async (e, id, rel) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(id, rel);
      if (r.error) return { ok: false, error: r.error };
      try { await clipboard.writeText(r.real); } catch { return { ok: false, error: 'Could not copy to the clipboard.' }; } // newer Electron versions copy asynchronously
      return { ok: true, path: r.real };
    });
    ipcMain.handle('fs:properties', (e, id, rel) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const r = resolveInProject(id, rel);
      if (r.error) return { ok: false, error: r.error };
      let st;
      try { st = fs.statSync(r.real); } catch { return { ok: false, error: 'Not found.' }; }
      const out = { ok: true, name: path.basename(r.real) || r.real, kind: st.isDirectory() ? 'folder' : 'file', path: r.real,
        created: st.birthtimeMs, modified: st.mtimeMs, accessed: st.atimeMs, readOnly: (st.mode & 0o200) === 0 };
      if (st.isDirectory()) {
        try { const names = fs.readdirSync(r.real); out.items = names.length; } catch { out.items = null; }
      } else { out.size = st.size; out.type = path.extname(r.real).slice(1).toUpperCase() || ''; }
      return out;
    });
    // Drag and drop: move or copy inside the Explorer, drop files in from Windows, drag a file out to Windows.
    ipcMain.handle('fs:transfer', (e, srcRoot, srcRel, dstRoot, dstRel, copy) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const s = resolveInProject(srcRoot, srcRel);
      if (s.error) return { ok: false, error: s.error };
      if (!s.clean) return { ok: false, error: 'A whole drive or project folder cannot be moved from here.' };
      const d = resolveInProject(dstRoot, dstRel);
      if (d.error) return { ok: false, error: d.error };
      let isDir = false;
      try { isDir = fs.statSync(d.real).isDirectory(); } catch { /* handled below */ }
      if (!isDir) return { ok: false, error: 'Drop it onto a folder.' };
      return copyOrMove(s.real, d.real, copy === true);
    });
    ipcMain.handle('fs:open-web', (e, id, rel) => (isLocalSender(e) ? openInWeb(id, rel) : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('fs:import', (e, dstRoot, dstRel, paths) => {
      if (!isLocalSender(e) || !Array.isArray(paths) || !paths.length || paths.length > 50) return { ok: false, error: 'Not allowed.' };
      const d = resolveInProject(dstRoot, dstRel);
      if (d.error) return { ok: false, error: d.error };
      let isDir = false;
      try { isDir = fs.statSync(d.real).isDirectory(); } catch { /* handled below */ }
      if (!isDir) return { ok: false, error: 'Drop it onto a folder.' };
      let done = 0;
      const failed = [];
      for (const p of paths) {
        if (typeof p !== 'string' || p.length > 1000 || !path.isAbsolute(p) || path.parse(p).root === p || isBlockedName(path.basename(p))) { failed.push('That item cannot be copied here.'); continue; }
        const r = copyOrMove(path.resolve(p), d.real, true);
        if (r.ok) done++; else failed.push(r.error);
      }
      return { ok: done > 0 || !failed.length, done, failed };
    });
    ipcMain.on('fs:drag-out', (e, id, rel) => {
      if (!isLocalSender(e)) return;
      const r = resolveInProject(id, rel);
      if (r.error) return;
      try { if (!fs.statSync(r.real).isFile()) return; e.sender.startDrag({ file: r.real, icon: dragIconImage() }); } catch { /* the drag simply does not start */ }
    });
    ipcMain.on('cc:reload', (e) => { if (isLocalSender(e)) reloadCurrent(); });
    // Opens the settings file for editing. Notepad is used on Windows because a .json file often has no program assigned to it.
    async function openSettingsFile() {
      const file = configPath();
      if (process.platform === 'win32') {
        try {
          const child = require('child_process').spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
          child.on('error', () => { /* the fallback below is tried when Notepad cannot start */ });
          child.unref();
          return { ok: true };
        } catch { /* fall through */ }
      }
      const err = await shell.openPath(file);
      if (!err) return { ok: true };
      shell.showItemInFolder(file);
      return { ok: false, error: 'No program could open the file, so its folder was shown instead.' };
    }
    ipcMain.on('cc:open-config', (e) => { if (isLocalSender(e)) openSettingsFile(); });
    ipcMain.handle('settings:open-file', (e) => (isLocalSender(e) ? openSettingsFile() : { ok: false, error: 'Not allowed.' }));
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
    // Spell check: Australian English unless "spellCheckLanguages" in the settings says otherwise, in every storage area the app uses
    for (const ses of [session.defaultSession, session.fromPartition(PARTITION), session.fromPartition(DRMD_PARTITION), session.fromPartition(BROWSER_PARTITION)]) {
      setupSpellcheck(ses, loadedConfig.spellCheckLanguages || ['en-AU']);
    }
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
    // Classic Outlook on this PC: unread count and appointments. Settings: "outlookDesktop": false turns it off.
    const defaultOutlookRun = (script) => new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 25000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    ipcMain.handle('outlook:get', (e, force) => {
      if (!isLocalSender(e)) return { state: 'off' };
      const on = loadedConfig.outlookDesktop !== false && (outlookRun || process.platform === 'win32');
      if (!on) return { state: 'off' };
      if (!outlookService) outlookService = createOutlook({ run: outlookRun || defaultOutlookRun });
      return outlookService.get(force === true);
    });
    ipcMain.handle('feeds:get', (e) => (isLocalSender(e) ? feedService.get() : null));
    ipcMain.handle('feeds:refresh', (e) => (isLocalSender(e) ? feedService.refresh() : null));

    // Left-rail pictures for sections that name an "iconFile" (a program's .exe, or a .png/.ico picture)
    ipcMain.handle('app:section-icons', async (e) => {
      if (!isLocalSender(e)) return {};
      const out = {};
      for (const s of sections) { if (s.iconFile) { const u = await appIcon(s.iconFile); if (u) out[s.id] = u; } }
      return out;
    });
    loadFavicons();
    ipcMain.handle('app:favicons', (e) => (isLocalSender(e) ? favicons : {}));
    todoService = createTodoSync({ scrape: scrapeTodo, cacheFile: path.join(dataDir(), 'todo-cache.json'), onChange: broadcastTodo });
    const runTodo = () => { if (todoEnabled()) todoService.refresh(); };
    if (!process.env.CC_TEST_SCRIPT) { setTimeout(runTodo, 9000); setInterval(runTodo, 10 * 60 * 1000); }
    ipcMain.handle('todo:get', (e) => (isLocalSender(e) ? { enabled: todoEnabled(), ...todoService.get() } : null));
    ipcMain.handle('todo:complete', async (e, title) => {
      if (!isLocalSender(e) || !todoEnabled() || typeof title !== 'string' || !title || title.length > 300) return { ok: false, error: 'Not available.' };
      const r = await completeTodo(title);
      if (r.ok) todoService.refresh();
      return r;
    });
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
    // Browser tab: only its own toolbar page may drive the tabs
    const fromBrowserShell = (e) => !!(browserService && browserShellIds.has(e.sender.id));
    ipcMain.handle('browser:state', (e) => (fromBrowserShell(e) ? browserService.state() : null));
    ipcMain.handle('browser:new-tab', (e) => (fromBrowserShell(e) ? browserService.newTab() : null));
    ipcMain.handle('browser:close-tab', (e, id) => (fromBrowserShell(e) && Number.isInteger(id) ? browserService.closeTab(id) : false));
    ipcMain.handle('browser:select-tab', (e, id) => (fromBrowserShell(e) && Number.isInteger(id) ? browserService.select(id) : false));
    ipcMain.handle('browser:go', (e, input) => (fromBrowserShell(e) && typeof input === 'string' ? browserService.go(input) : false));
    ipcMain.handle('browser:back', (e) => { if (fromBrowserShell(e)) browserService.back(); });
    ipcMain.handle('browser:forward', (e) => { if (fromBrowserShell(e)) browserService.forward(); });
    ipcMain.handle('browser:reload', (e) => { if (fromBrowserShell(e)) browserService.reload(); });
    ipcMain.handle('browser:stop', (e) => { if (fromBrowserShell(e)) browserService.stop(); });
    ipcMain.handle('browser:suggest', (e, q) => (fromBrowserShell(e) && typeof q === 'string' ? browserService.suggest(q) : []));
    ipcMain.handle('browser:clear', async (e) => (fromBrowserShell(e) ? browserService.clearData() : false));
    // ---- Screen lock ----
    ipcMain.handle('lock:state', (e) => (fromLock(e) ? { wait: lockService().waitSeconds() } : null));
    ipcMain.handle('lock:unlock', (e, pin) => {
      if (!fromLock(e) || typeof pin !== 'string' || pin.length > MAX_PIN) return { ok: false, wait: 0 };
      const r = lockService().verify(pin);
      if (r.ok) setTimeout(unlockNow, 60); // a moment later, so the reply reaches the lock page before it is closed
      return { ok: r.ok, wait: r.wait || 0 };
    });
    ipcMain.handle('lock:get', (e) => (isLocalSender(e) && !locked ? lockService().status() : null));
    ipcMain.handle('lock:save', (e, p) => {
      if (!isLocalSender(e) || locked || !p || typeof p !== 'object') return { ok: false, error: 'Not allowed.' };
      return lockService().save({
        enabled: !!p.enabled, minutes: p.minutes,
        newPin: typeof p.newPin === 'string' && p.newPin ? p.newPin : null,
        currentPin: typeof p.currentPin === 'string' ? p.currentPin : undefined,
      });
    });
    ipcMain.handle('lock:remove', (e, pin) => (isLocalSender(e) && !locked ? lockService().remove(typeof pin === 'string' ? pin : '') : { ok: false, error: 'Not allowed.' }));
    ipcMain.handle('lock:now', (e) => (isLocalSender(e) && !locked ? lockNow() : false));
    if (!process.env.CC_TEST_SCRIPT) {
      setInterval(() => idleCheck(), 15000);
      powerMonitor.on('lock-screen', () => lockNow()); // Windows key + L
      powerMonitor.on('suspend', () => lockNow());     // lid closed or sleep
    }
    // ---- Pick up where you left off (Home) ----
    const recentOn = () => !(loadedConfig && loadedConfig.homeRecent === false);
    ipcMain.handle('recent:list', async (e, force) => {
      if (!isLocalSender(e)) return { ok: false, items: [] };
      if (!recentOn()) return { ok: true, disabled: true, items: [] };
      if (!recentSvc) recentSvc = createRecent();
      return recentSvc.list(!!force);
    });
    ipcMain.handle('recent:open', async (e, id, reveal) => {
      if (!isLocalSender(e) || !recentSvc) return { ok: false, error: 'Not allowed.' };
      const hit = recentSvc.pick(id); // only something the latest list returned can be opened
      if (!hit) return { ok: false, error: 'That item is no longer in the list. Refresh and try again.' };
      let st;
      try { st = fs.statSync(hit.path); } catch { return { ok: false, error: 'That file was not found. It may have been moved or deleted.' }; }
      const risky = st.isFile() && RISKY_EXT.has(path.extname(hit.path).toLowerCase());
      if (reveal || risky) { shell.showItemInFolder(hit.path); return { ok: true, revealed: true }; }
      const err = await shell.openPath(hit.path);
      return err ? { ok: false, error: 'Could not open that file.' } : { ok: true };
    });
    ipcMain.handle('settings:home-recent', (e, on) => {
      if (!isLocalSender(e) || typeof on !== 'boolean') return { ok: false };
      try { updateConfigFile((cfg) => { if (on) delete cfg.homeRecent; else cfg.homeRecent = false; }); } catch { return { ok: false }; }
      if (on) delete loadedConfig.homeRecent; else loadedConfig.homeRecent = false;
      notifyHomeBackground(); // tells Home to redraw
      return { ok: true };
    });
    ipcMain.handle('settings:home-recent-get', (e) => (isLocalSender(e) ? { on: recentOn() } : null));
    // ---- Searching this PC from the search box ----
    ipcMain.handle('files:search', (e, q) => {
      if (!isLocalSender(e) || typeof q !== 'string') return { ok: false, results: [] };
      if (!fileSearch) fileSearch = createFileSearch();
      return fileSearch.search(q);
    });
    ipcMain.handle('files:open', async (e, id, reveal) => {
      if (!isLocalSender(e) || !fileSearch) return { ok: false, error: 'Not allowed.' };
      const hit = fileSearch.pick(id); // only something the last search returned can be opened
      if (!hit) return { ok: false, error: 'That result is no longer available. Search again.' };
      let st;
      try { st = fs.statSync(hit.path); } catch { return { ok: false, error: 'That file was not found. It may have been moved.' }; }
      const risky = st.isFile() && RISKY_EXT.has(path.extname(hit.path).toLowerCase());
      if (reveal || risky) { shell.showItemInFolder(hit.path); return { ok: true, revealed: true, note: risky ? 'For safety, programs and scripts are not run from here, so the folder was shown instead.' : '' }; }
      const err = await shell.openPath(hit.path);
      return err ? { ok: false, error: 'Could not open that file.' } : { ok: true };
    });
    // ---- Home page background ----
    ipcMain.handle('home:background', (e) => (isLocalSender(e) ? homeBackground() : null));
    ipcMain.handle('settings:bg-pick', async (e) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      let src;
      if (testPickImage) src = await testPickImage();
      else {
        const r = await dialog.showOpenDialog(win, { title: 'Choose a background picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
        src = r.canceled ? null : r.filePaths[0];
      }
      if (!src) return { ok: false, cancelled: true };
      try {
        const st = fs.statSync(src);
        if (!st.isFile()) return { ok: false, error: 'That is not a picture file.' };
        if (st.size > BG_MAX_BYTES) return { ok: false, error: 'That picture is larger than 8 MB. Choose a smaller one (a screen-sized picture is plenty).' };
        const buf = fs.readFileSync(src);
        const kind = imageKind(buf);
        if (!kind) return { ok: false, error: 'Please choose a PNG, JPG or WebP picture.' };
        const name = 'home-background.' + kind;
        const dest = path.join(app.getPath('userData'), name);
        const tmp = dest + '.tmp';
        fs.writeFileSync(tmp, buf);
        clearBackgroundFiles();
        fs.renameSync(tmp, dest);
        const dim = loadedConfig.homeBackground ? clampDim(loadedConfig.homeBackground.dim) : 35;
        saveBackgroundSetting({ file: name, dim });
        notifyHomeBackground();
        return { ok: true, dim };
      } catch { return { ok: false, error: 'Could not use that picture.' }; }
    });
    ipcMain.handle('settings:bg-dim', (e, n) => {
      if (!isLocalSender(e) || !loadedConfig.homeBackground) return { ok: false };
      try { saveBackgroundSetting({ file: loadedConfig.homeBackground.file, dim: clampDim(n) }); } catch { return { ok: false }; }
      notifyHomeBackground();
      return { ok: true };
    });
    ipcMain.handle('settings:bg-remove', (e) => {
      if (!isLocalSender(e)) return { ok: false };
      try { clearBackgroundFiles(); saveBackgroundSetting(null); } catch { return { ok: false }; }
      notifyHomeBackground();
      return { ok: true };
    });
    // ---- Settings backups ----
    const backupsDir = () => path.join(path.dirname(configPath()), 'config-backups');
    ipcMain.handle('settings:backups', (e) => (isLocalSender(e) ? listBackups(backupsDir()) : []));
    ipcMain.handle('settings:restore-backup', (e, name) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      return restoreBackup(name, {
        dir: backupsDir(), file: configPath(), backupNow: backupConfigRolling,
        check: (text) => rawSettingsError(text, { configVersion: CONFIG_VERSION, cleanSections, defaults: defaultSections() }),
      });
    });
    // ---- Safer sessions ----
    const denyMost = (ses) => {
      const ok = (p) => p === 'fullscreen' || p === 'clipboard-sanitized-write';
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ok(permission)));
      ses.setPermissionCheckHandler((_wc, permission) => ok(permission));
    };
    denyMost(session.fromPartition(VAULT_PARTITION)); // the vault page may not ask for the camera, location and so on
    keepSignedIn(session.fromPartition(PARTITION), Array.isArray(loadedConfig.keepSignedIn) ? loadedConfig.keepSignedIn : ['domo.com']);
    ipcMain.handle('cc:current', () => currentId);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  // A site with a faulty or untrusted certificate is never loaded, and there is no "continue anyway".
  app.on('certificate-error', (event, _wc, _url, _error, _cert, callback) => { event.preventDefault(); callback(false); });

  app.on('web-contents-created', (_e, contents) => {
    // Developer tools stay shut unless the app was started for development with TH_DEVTOOLS=1.
    if (process.env.TH_DEVTOOLS !== '1' && !process.env.CC_TEST_SCRIPT) contents.on('devtools-opened', () => contents.closeDevTools());
    // Right-click in a text box or on selected text: spelling suggestions, Cut/Copy/Paste. (The Browser tab builds its own menu.)
    contents.on('context-menu', (_event, params) => {
      if (browserService && browserService.owns(contents)) return;
      const template = contextTemplate(contents, params);
      if (template.length) Menu.buildFromTemplate(template).popup();
    });
    contents.on('before-input-event', (event, input) => {
      if (locked) { if (!lockView || contents !== lockView.webContents) event.preventDefault(); return; } // nothing but the PIN box gets keys
      if (handleKey(contents, input)) event.preventDefault();
    });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
