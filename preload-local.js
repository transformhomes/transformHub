// Bridge for the built-in pages (Home, AI Projects, Tasks, Calendar) only.
// Web sections (Outlook, Teams, Claude...) never get this.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  getData: () => ipcRenderer.invoke('data:get'),
  setData: (patch) => ipcRenderer.invoke('data:set', patch),
  onChanged: (fn) => ipcRenderer.on('data:changed', (_e, d) => fn(d)),
  getSettings: () => ipcRenderer.invoke('app:settings'),
  getFeeds: () => ipcRenderer.invoke('feeds:get'),
  refreshFeeds: () => ipcRenderer.invoke('feeds:refresh'),
  onFeedsChanged: (fn) => ipcRenderer.on('feeds:changed', (_e, s) => fn(s)),
  getProjects: () => ipcRenderer.invoke('projects:list'),
  openFolder: (id) => ipcRenderer.invoke('projects:open-folder', id),
  openArcane: () => ipcRenderer.invoke('projects:open-arcane'),
  go: (sectionId) => ipcRenderer.send('cc:select', sectionId),
  listDir: (project, rel) => ipcRenderer.invoke('fs:list', project, rel),
  readFile: (project, rel) => ipcRenderer.invoke('fs:read', project, rel),
  openFile: (project, rel) => ipcRenderer.invoke('fs:open', project, rel),
  revealFile: (project, rel) => ipcRenderer.invoke('fs:reveal', project, rel),
  getTodo: () => ipcRenderer.invoke('todo:get'),
  refreshTodo: () => ipcRenderer.invoke('todo:refresh'),
  onTodo: (fn) => ipcRenderer.on('todo:changed', (_e, s) => fn(s)),
  navigate: (params) => ipcRenderer.send('cc:navigate', params),
  onNavigate: (fn) => ipcRenderer.on('nav:params', (_e, p) => fn(p)),
});
