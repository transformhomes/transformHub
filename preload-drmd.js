// Bridge for Dr. MD only. It can ask the hub to show Open and Save dialogs and to read or write the
// files the user picked there. It never sends a file path.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drmdHost', {
  open: () => ipcRenderer.invoke('drmd:open'),
  openRecent: (id) => ipcRenderer.invoke('drmd:open-recent', id),
  reload: (id) => ipcRenderer.invoke('drmd:reload', id),
  recents: () => ipcRenderer.invoke('drmd:recents'),
  forget: (id) => ipcRenderer.invoke('drmd:forget', id),
  save: (id, text, expectedMtime) => ipcRenderer.invoke('drmd:save', id, text, expectedMtime),
  saveAs: (suggestedName, text) => ipcRenderer.invoke('drmd:save-as', suggestedName, text),
});
