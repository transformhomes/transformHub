// Bridge for the app's own chrome: the left rail, activity panel, header and the Ctrl+K palette.
// Web sections (Outlook, Teams, Claude...) never get this.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('cc', {
  // navigation
  getSections: () => ipcRenderer.invoke('cc:sections'),
  getCurrent: () => ipcRenderer.invoke('cc:current'),
  select: (id) => ipcRenderer.send('cc:select', id),
  go: (id) => ipcRenderer.send('cc:select', id),
  getFavicons: () => ipcRenderer.invoke('app:favicons'),
  onFavicons: on('favicons:changed'),
  getTodo: () => ipcRenderer.invoke('todo:get'),
  onTodo: on('todo:changed'),
  navigate: (params) => ipcRenderer.send('cc:navigate', params),
  onSelected: on('cc:selected'),
  onNav: on('cc:nav'),
  listDir: (project, rel) => ipcRenderer.invoke('fs:list', project, rel),
  reload: () => ipcRenderer.send('cc:reload'),
  openConfig: () => ipcRenderer.send('cc:open-config'),

  // interface state
  getUi: () => ipcRenderer.invoke('ui:get'),
  setTheme: (t) => ipcRenderer.send('ui:set-theme', t),
  getLogo: () => ipcRenderer.invoke('app:logo'),
  toggleFeed: () => ipcRenderer.send('ui:toggle-feed'),
  onUi: on('ui:changed'),

  // command palette
  openPalette: () => ipcRenderer.send('palette:toggle'),
  closePalette: () => ipcRenderer.send('palette:close'),
  paletteResize: (h) => ipcRenderer.send('palette:resize', h),
  onPaletteOpen: on('palette:open'),
  pushRecent: (key) => ipcRenderer.send('palette:recent', key),

  // data (same as the built-in pages)
  getData: () => ipcRenderer.invoke('data:get'),
  setData: (patch) => ipcRenderer.invoke('data:set', patch),
  onChanged: on('data:changed'),
  getFeeds: () => ipcRenderer.invoke('feeds:get'),
  refreshFeeds: () => ipcRenderer.invoke('feeds:refresh'),
  onFeedsChanged: on('feeds:changed'),
  getProjects: () => ipcRenderer.invoke('projects:list'),
  getRoots: () => ipcRenderer.invoke('explorer:roots'),
  toggleFav: (root, rel, name) => ipcRenderer.invoke('explorer:fav', root, rel, name),
  getSettings: () => ipcRenderer.invoke('app:settings'),
  openArcane: () => ipcRenderer.invoke('projects:open-arcane'),
});
