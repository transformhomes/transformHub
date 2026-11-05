// Bridge for the lock screen only: ask for the state and try a PIN.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lk', {
  state: () => ipcRenderer.invoke('lock:state'),
  unlock: (pin) => ipcRenderer.invoke('lock:unlock', pin),
});
