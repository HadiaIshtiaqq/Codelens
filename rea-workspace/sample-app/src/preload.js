const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', { info: () => ipcRenderer.invoke('get-system-info') });
