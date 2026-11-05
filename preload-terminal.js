// Bridge for the PowerShell tab's page only. It can start the terminal, send keystrokes, resize it, and use the clipboard.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('term', {
  start: (cols, rows) => ipcRenderer.invoke('term:start', cols, rows),
  input: (data) => ipcRenderer.send('term:input', data),
  resize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
  onData: (fn) => ipcRenderer.on('term:data', (_e, d) => fn(d)),
  onExit: (fn) => ipcRenderer.on('term:exit', (_e, c) => fn(c)),
  clipRead: () => ipcRenderer.invoke('term:clip-read'),
  clipWrite: (t) => ipcRenderer.send('term:clip-write', t),
});
