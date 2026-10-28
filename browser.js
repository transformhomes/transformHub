// The Browser tab: a small tabbed web browser. The tab strip and address bar are a built-in page
// (renderer/browser.html); each tab is its own sandboxed page placed under it. Pages never get a bridge
// to the hub, they use their own storage area, and they cannot ask for the camera, location and so on.
const fs = require('fs');
const { contextTemplate } = require('./spell');

const TOOLBAR_H = 80;           // tab strip + address bar; renderer/browser.html uses the same number
const MAX_TABS = 20;
const MAX_HISTORY = 300;
const DEFAULT_START = 'https://www.google.com/';
const SEARCH_URL = 'https://www.google.com/search?q=';
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

// Turn whatever was typed into an http(s) address. Anything that is not clearly an address becomes a search,
// so javascript:, file:, data: and the like can never be opened from the address bar.
function normaliseInput(raw) {
  const text = String(raw == null ? '' : raw).trim().slice(0, 2000);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try { const u = new URL(text); if (u.protocol === 'http:' || u.protocol === 'https:') return u.href; } catch { /* fall through to search */ }
    return SEARCH_URL + encodeURIComponent(text);
  }
  if (!/\s/.test(text)) {
    const local = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?([/?#].*)?$/i.test(text);
    const domain = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d{1,5})?([/?#].*)?$/i.test(text);
    if (local || domain) {
      try { return new URL((local ? 'http://' : 'https://') + text).href; } catch { /* fall through */ }
    }
  }
  return SEARCH_URL + encodeURIComponent(text);
}

function isWebUrl(url) {
  try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

// Chromium network error numbers -200 to -219 are certificate problems (wrong name, expired, not trusted, revoked ...).
function isCertError(code) { return typeof code === 'number' && code <= -200 && code >= -219; }

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Shown instead of a site whose security certificate cannot be trusted. There is deliberately no "continue anyway".
function certPage(url, detail) {
  let host = url;
  try { host = new URL(url).host; } catch { /* show the raw text */ }
  return '<!doctype html><html lang="en-AU"><meta charset="utf-8"><title>Connection not private</title>'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">'
    + '<style>body{font:15px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:12vh 8vw;background:#fff7f5;color:#3b1a14}h1{font-size:24px;margin:0 0 10px}'
    + 'p{max-width:620px}code{background:#f3dcd6;padding:1px 6px;border-radius:4px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #b8442f;background:#b8442f;color:#fff;cursor:pointer}'
    + '@media (prefers-color-scheme:dark){body{background:#2a1512;color:#f3d9d3}code{background:#4a2620}}</style>'
    + '<h1>This connection is not private</h1>'
    + '<p>Transform Workstation could not confirm that <strong>' + esc(host) + '</strong> is the genuine site, so it has not opened it. '
    + 'This can happen on a public Wi-Fi network, or if the site\'s security certificate has expired or is wrong. Details: <code>' + esc(detail) + '</code></p>'
    + '<p>Do not enter passwords here. If you expected this site to work, tell your IT contact.</p>'
    + '<button onclick="history.back()">Go back</button></html>';
}

function loadHistory(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((x) => x && typeof x.url === 'string' && isWebUrl(x.url)).slice(0, MAX_HISTORY)
      .map((x) => ({ url: x.url.slice(0, 2000), title: String(x.title || '').slice(0, 200), t: Number(x.t) || 0 }));
  } catch { return []; }
}

// deps: { shellView, attachView(view), detachView(view), stageBounds(), WebContentsView, Menu, shell, session (the browser's own Electron session), userAgent, historyFile, startUrl }
// Tab pages are placed straight into the app window (not inside the toolbar page), under the toolbar.
function createBrowser(deps) {
  const { shellView, WebContentsView, Menu, shell, session: ses, historyFile } = deps;
  const startUrl = isWebUrl(deps.startUrl) ? deps.startUrl : DEFAULT_START;
  const tabs = []; // { id, view, title, loading }
  let nextId = 1;
  let activeId = null;
  let history = loadHistory(historyFile);
  let pushTimer = null;
  let attached = false; // true while the Browser section is the one on screen

  // pages may only ask for fullscreen and for copying to the clipboard
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  const find = (id) => tabs.find((t) => t.id === id) || null;
  const active = () => find(activeId);

  function nav(tab) {
    const h = tab.view.webContents.navigationHistory;
    return {
      back: !!(h && h.canGoBack()),
      forward: !!(h && h.canGoForward()),
    };
  }

  function state() {
    return {
      activeId,
      tabs: tabs.map((t) => {
        const wc = t.view.webContents;
        const n = nav(t);
        const raw = wc.getURL();
        const url = t.certError && raw.startsWith('data:') ? t.certError.url : raw; // show the address you asked for, not the warning page's
        return { id: t.id, title: t.title || (url ? url : 'New tab'), url, loading: t.loading, canBack: n.back, canForward: n.forward };
      }),
    };
  }

  function push() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (shellView.webContents.isDestroyed()) return;
      shellView.webContents.send('browser:state', state());
    }, 30);
  }

  function saveHistory() {
    try { fs.writeFileSync(historyFile, JSON.stringify(history)); } catch { /* history is a convenience only */ }
  }

  function record(url, title) {
    if (!isWebUrl(url)) return;
    const i = history.findIndex((h) => h.url === url);
    const prev = i >= 0 ? history.splice(i, 1)[0] : null;
    history.unshift({ url: url.slice(0, 2000), title: String(title || (prev && prev.title) || '').slice(0, 200), t: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    saveHistory();
  }

  function layout() {
    const t = active();
    if (!t) return;
    const b = deps.stageBounds();
    t.view.setBounds({ x: b.x, y: b.y + TOOLBAR_H, width: Math.max(0, b.width), height: Math.max(0, b.height - TOOLBAR_H) });
  }

  function wire(tab) {
    const wc = tab.view.webContents;
    wc.setUserAgent(deps.userAgent);
    wc.on('page-title-updated', (_e, title) => { tab.title = title; if (isWebUrl(wc.getURL())) record(wc.getURL(), title); push(); });
    wc.on('did-start-loading', () => { tab.loading = true; push(); });
    wc.on('did-stop-loading', () => { tab.loading = false; push(); });
    wc.on('did-navigate', (_e, url) => { tab.title = ''; if (isWebUrl(url)) { tab.certError = null; record(url, ''); } push(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || !isCertError(code) || !isWebUrl(url)) return;
      tab.certError = { url, desc };
      wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(certPage(url, desc))).catch(() => { /* nothing more to show */ });
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { record(url, tab.title); push(); } });
    wc.on('destroyed', () => push());
    // links that open a new window become a new tab here
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) newTab(url);
      else if (/^mailto:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // only web pages load in a tab; mail links go to the mail program, everything else is refused
    const guard = (event, url) => {
      if (isWebUrl(url)) return;
      event.preventDefault();
      if (/^mailto:/i.test(url)) shell.openExternal(url);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('context-menu', (_e, p) => {
      const items = [];
      if (p.linkURL && isWebUrl(p.linkURL)) {
        items.push({ label: 'Open link in new tab', click: () => newTab(p.linkURL) });
        items.push({ label: 'Copy link address', click: () => { Promise.resolve(require('electron').clipboard.writeText(p.linkURL)).catch(() => { /* nothing to do */ }); } });
      }
      items.push(...contextTemplate(wc, p));
      if (!items.length) { const n = nav(tab); items.push({ label: 'Back', enabled: n.back, click: () => back() }, { label: 'Forward', enabled: n.forward, click: () => forward() }, { label: 'Reload', click: () => reload() }); }
      const pageUrl = wc.getURL();
      if (isWebUrl(pageUrl)) {
        if (items.length) items.push({ type: 'separator' });
        items.push({ label: 'Copy page address', click: () => { Promise.resolve(require('electron').clipboard.writeText(pageUrl)).catch(() => { /* nothing to do */ }); } });
      }
      Menu.buildFromTemplate(items).popup();
    });
  }

  function select(id) {
    const next = find(id);
    if (!next) return false;
    const prev = active();
    if (prev && prev !== next && attached) deps.detachView(prev.view);
    activeId = id;
    if (attached) { deps.attachView(next.view); layout(); }
    push();
    return true;
  }

  function newTab(url) {
    if (tabs.length >= MAX_TABS) return null;
    const view = new WebContentsView({
      webPreferences: { partition: deps.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const tab = { id: nextId++, view, title: '', loading: false };
    tabs.push(tab);
    wire(tab);
    const target = url == null ? startUrl : normaliseInput(url);
    if (target) view.webContents.loadURL(target).catch(() => { /* the page shows its own error */ });
    select(tab.id);
    return tab.id;
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return false;
    const [tab] = tabs.splice(i, 1);
    if (attached && activeId === tab.id) deps.detachView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!tabs.length) { activeId = null; newTab(); return true; }
    if (activeId === id) select((tabs[Math.min(i, tabs.length - 1)]).id); else push();
    return true;
  }

  function go(input) {
    const t = active();
    const url = normaliseInput(input);
    if (!t || !url) return false;
    t.view.webContents.loadURL(url).catch(() => { /* the page shows its own error */ });
    return true;
  }

  function back() { const t = active(); const h = t && t.view.webContents.navigationHistory; if (h && h.canGoBack()) h.goBack(); }
  function forward() { const t = active(); const h = t && t.view.webContents.navigationHistory; if (h && h.canGoForward()) h.goForward(); }
  function reload() { const t = active(); if (t) t.view.webContents.reload(); }
  function stop() { const t = active(); if (t) t.view.webContents.stop(); }
  function focusContent() { const t = active(); if (t && !t.view.webContents.isDestroyed()) t.view.webContents.focus(); }
  function cycle(step) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    select(tabs[(i + step + tabs.length) % tabs.length].id);
  }

  function suggest(query) {
    const q = String(query || '').trim().toLowerCase().slice(0, 200);
    if (!q) return [];
    return history.filter((h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q)).slice(0, 6).map((h) => ({ url: h.url, title: h.title }));
  }

  async function clearData() {
    history = [];
    saveHistory();
    await ses.clearStorageData();
    await ses.clearCache();
    push();
    return true;
  }

  function attach() { attached = true; const t = active(); if (t) { deps.attachView(t.view); layout(); } }
  function detach() { const t = active(); if (attached && t) deps.detachView(t.view); attached = false; }

  function owns(contents) { return tabs.some((t) => t.view.webContents === contents); }

  newTab();

  return {
    state, newTab, closeTab, select, go, back, forward, reload, stop, focusContent, cycle, layout, suggest, clearData, owns, attach, detach,
    activeView: () => { const t = active(); return t ? t.view : null; },
    history: () => history.slice(), tabCount: () => tabs.length, activeWebContents: () => { const t = active(); return t ? t.view.webContents : null; },
  };
}

module.exports = { createBrowser, normaliseInput, isWebUrl, isCertError, certPage, TOOLBAR_H, MAX_TABS, DEFAULT_START };
