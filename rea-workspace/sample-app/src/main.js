const { app, ipcMain } = require('electron');
ipcMain.handle('get-system-info', async () => ({ platform: process.platform }));
app.whenReady().then(() => {});
