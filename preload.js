// Bridge for the app's own chrome: the left rail, activity panel, header and the Ctrl+K palette.
// Web sections (Outlook, Teams, Claude...) never get this.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('cc', {
  // navigation
  getSections: () => ipcRenderer.invoke('cc:sections'),
  getCurrent: () => ipcRenderer.invoke('cc:current'),
  select: (id) => ipcRenderer.send('cc:select', id),
  goBack: () => ipcRenderer.send('cc:back'),
  go: (id) => ipcRenderer.send('cc:select', id),
  reorderSections: (ids) => ipcRenderer.invoke('cc:reorder-sections', ids),
  getSectionIcons: () => ipcRenderer.invoke('app:section-icons'),
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
  searchFiles: (q) => ipcRenderer.invoke('files:search', q),
  openFoundFile: (id, reveal) => ipcRenderer.invoke('files:open', id, !!reveal),
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
  launchApp: (id) => ipcRenderer.invoke('app:launch', id),
  openWith: (id, root, rel) => ipcRenderer.invoke('app:open-with', id, root, rel),
  openFile: (project, rel) => ipcRenderer.invoke('fs:open', project, rel),
  revealFile: (project, rel) => ipcRenderer.invoke('fs:reveal', project, rel),
  openPowerShell: (id, rel) => ipcRenderer.invoke('fs:powershell', id, rel),
  copyPath: (id, rel) => ipcRenderer.invoke('fs:copy-path', id, rel),
  getProperties: (id, rel) => ipcRenderer.invoke('fs:properties', id, rel),
  toggleFav: (root, rel, name) => ipcRenderer.invoke('explorer:fav', root, rel, name),
  getSettings: () => ipcRenderer.invoke('app:settings'),
  openArcane: () => ipcRenderer.invoke('projects:open-arcane'),
});
