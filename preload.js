const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  getSections: () => ipcRenderer.invoke('cc:sections'),
  getCurrent: () => ipcRenderer.invoke('cc:current'),
  select: (id) => ipcRenderer.send('cc:select', id),
  reload: () => ipcRenderer.send('cc:reload'),
  openConfig: () => ipcRenderer.send('cc:open-config'),
  onSelected: (fn) => ipcRenderer.on('cc:selected', (_e, id) => fn(id)),
});
