// Bridge for the built-in pages (Home, AI Projects, Tasks, Calendar) only.
// Web sections (Outlook, Teams, Claude...) never get this.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  getData: () => ipcRenderer.invoke('data:get'),
  setData: (patch) => ipcRenderer.invoke('data:set', patch),
  onChanged: (fn) => ipcRenderer.on('data:changed', (_e, d) => fn(d)),
  getSettings: () => ipcRenderer.invoke('app:settings'),
  getProjects: () => ipcRenderer.invoke('projects:list'),
  openAgent: (id) => ipcRenderer.invoke('projects:open-agent', id),
  openFolder: (id) => ipcRenderer.invoke('projects:open-folder', id),
  openArcane: () => ipcRenderer.invoke('projects:open-arcane'),
  go: (sectionId) => ipcRenderer.send('cc:select', sectionId),
});
