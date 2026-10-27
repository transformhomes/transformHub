// Bridge for the Browser tab's own toolbar page only. It can drive the tabs; it cannot read the pages.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tb', {
  state: () => ipcRenderer.invoke('browser:state'),
  onState: (fn) => ipcRenderer.on('browser:state', (_e, s) => fn(s)),
  onFocusAddress: (fn) => ipcRenderer.on('browser:focus-address', () => fn()),
  newTab: () => ipcRenderer.invoke('browser:new-tab'),
  closeTab: (id) => ipcRenderer.invoke('browser:close-tab', id),
  selectTab: (id) => ipcRenderer.invoke('browser:select-tab', id),
  go: (input) => ipcRenderer.invoke('browser:go', input),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  stop: () => ipcRenderer.invoke('browser:stop'),
  suggest: (q) => ipcRenderer.invoke('browser:suggest', q),
  clearData: () => ipcRenderer.invoke('browser:clear'),
});
