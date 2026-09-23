const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('findBar', {
  send: message => ipcRenderer.send('omarchy:find', message),
  onResult: callback => ipcRenderer.on('find:result', (event, result) => callback(result)),
});
