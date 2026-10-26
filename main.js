const { app, BrowserWindow, WebContentsView, ipcMain, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createStore } = require('./store');

// Same data folder whether started with "npm start" or from the installer.
if (!process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'th-command-centre'));
}

const RAIL_WIDTH = 64;
const PARTITION = 'persist:th-command-centre'; // one shared login session for Microsoft + Claude
const INTERNAL_HOSTS = /(^|\.)(microsoftonline\.com|microsoft\.com|cloud\.microsoft|microsoft365\.com|office\.com|office365\.com|live\.com|sharepoint\.com|msauth\.net|msftauth\.net|msecnd\.net|claude\.ai|anthropic\.com)$/i;

let win = null;
let sections = [];
const views = new Map(); // id -> WebContentsView
let currentId = null;
let loadedConfig = null;
let store = null;
const localContentsIds = new Set(); // webContents ids of built-in pages allowed to use the data bridge

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

const CONFIG_VERSION = 2;

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

function launchAgent(projectPath) {
  return new Promise((resolve) => {
    const cmd = (loadedConfig && loadedConfig.agentCommand) || 'agy';
    if (!/^[\w.-]+$/.test(cmd)) return resolve({ ok: false, error: 'agentCommand in the settings must be a plain command name.' });
    if (!fs.existsSync(projectPath)) return resolve({ ok: false, error: 'Folder not found: ' + projectPath });
    if (/["`%^&|<>]/.test(projectPath)) return resolve({ ok: false, error: 'This folder path has a special character that cannot be launched safely. Rename the folder or open it manually.' });

    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn(cmd + ' "' + projectPath + '"', { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
        : spawn(cmd, [projectPath], { detached: true, stdio: 'ignore' });
    } catch (err) {
      return finish({ ok: false, error: err.message });
    }
    child.once('error', (err) => finish({ ok: false, error: err.code === 'ENOENT' ? cmd + ' was not found. Is Antigravity installed and on your PATH?' : err.message }));
    child.once('exit', (code) => { if (code) finish({ ok: false, error: cmd + ' stopped with code ' + code + '. Is Antigravity installed and on your PATH?' }); });
    child.once('spawn', () => { child.unref(); setTimeout(() => finish({ ok: true }), 800); });
  });
}

function isLocalSender(event) {
  return localContentsIds.has(event.sender.id) && event.senderFrame && String(event.senderFrame.url).startsWith('file://');
}

function broadcastData(data) {
  localContentsIds.forEach((id) => {
    const wc = require('electron').webContents.fromId(id);
    if (wc && !wc.isDestroyed()) wc.send('data:changed', data);
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

function contentBounds() {
  const [w, h] = win.getContentSize();
  return { x: RAIL_WIDTH, y: 0, width: Math.max(0, w - RAIL_WIDTH), height: h };
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
  const wc = view.webContents;
  if (section.type === 'local') {
    localContentsIds.add(wc.id);
    wc.once('destroyed', () => localContentsIds.delete(wc.id));
  }

  if (section.type === 'web') {
    wc.setUserAgent(chromeUserAgent());
    wc.loadURL(section.url);
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

function select(id) {
  const section = sections.find((s) => s.id === id);
  if (!section || section.type === 'disabled') return;

  if (currentId && views.has(currentId)) {
    win.contentView.removeChildView(views.get(currentId));
  }
  if (!views.has(id)) views.set(id, createView(section));

  const view = views.get(id);
  win.contentView.addChildView(view);
  view.setBounds(contentBounds());
  currentId = id;
  win.webContents.send('cc:selected', id);
  view.webContents.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'TH Command Centre',
    backgroundColor: '#0f1115',
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

  win.on('resize', () => {
    if (currentId && views.has(currentId)) views.get(currentId).setBounds(contentBounds());
  });

  win.webContents.once('did-finish-load', () => {
    const cfg = loadedConfig;
    const start = sections.find((s) => s.id === (process.env.CC_TEST_SECTION || cfg.startSection) && s.type !== 'disabled')
      || sections.find((s) => s.type !== 'disabled');
    if (start) select(start.id);

    if (process.env.CC_TEST_SCRIPT) {
      // Test hook only (never set in normal use): run a script that can drive the app.
      const ctx = {
        select, views, store, sections, win, app,
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
    ipcMain.handle('cc:sections', () => sections);
    ipcMain.on('cc:select', (_e, id) => select(id));
    ipcMain.on('cc:reload', () => {
      const v = views.get(currentId);
      if (v) v.webContents.reload();
    });
    ipcMain.on('cc:open-config', () => shell.openPath(configPath()));

    loadedConfig = loadConfig();
    sections = loadedConfig.sections;
    store = createStore(dataDir());

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
    ipcMain.handle('projects:open-agent', (e, id) => {
      if (!isLocalSender(e)) return { ok: false, error: 'Not allowed.' };
      const proj = findProject(id);
      return proj ? launchAgent(proj.path) : { ok: false, error: 'Unknown project.' };
    });
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
    // Ctrl+1..9 jumps to a section, Ctrl+R reloads it - works whichever pane has focus.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.shift) return;
      if (/^[1-9]$/.test(input.key)) {
        const enabled = sections.filter((s) => s.type !== 'disabled');
        const target = enabled[Number(input.key) - 1];
        if (target) { select(target.id); event.preventDefault(); }
      } else if (input.key.toLowerCase() === 'r') {
        const v = views.get(currentId);
        if (v) { v.webContents.reload(); event.preventDefault(); }
      }
    });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
