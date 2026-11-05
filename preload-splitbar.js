// Bridge for the draggable divider between two tabs. It can only say where the pointer is, or ask for half and half.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar', {
  grab: (on) => ipcRenderer.send('cc:split-grab', !!on),
  resize: (x) => ipcRenderer.send('cc:split-resize', x),
  reset: () => ipcRenderer.send('cc:split-reset'),
});
