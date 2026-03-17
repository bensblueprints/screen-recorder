const { app, BrowserWindow, ipcMain, desktopCapturer, shell, screen, dialog } = require('electron');
const path = require('path');
const devices = require('./lib/devices');
const recorder = require('./lib/recorder');
const config = require('./lib/config');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Screen Recorder',
    autoHideMenuBar: true,
  });

  mainWindow.loadFile('renderer/index.html');
}

// ── IPC Handlers ──

ipcMain.handle('get-devices', () => devices.enumerate());

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays();
  // Get the full virtual desktop bounds to validate offsets
  const allX = displays.map(d => d.bounds.x);
  const allY = displays.map(d => d.bounds.y);
  const minX = Math.min(...allX);
  const minY = Math.min(...allY);

  return displays.map((d, i) => {
    const w = d.size.width;
    const h = d.size.height;
    // gdigrab uses (0,0) as top-left of virtual desktop
    // Electron may report negative bounds if monitors are arranged above/left
    // Offset from the min corner so gdigrab coords are always >= 0
    const x = Math.round((d.bounds.x - minX) * d.scaleFactor);
    const y = Math.round((d.bounds.y - minY) * d.scaleFactor);
    return {
      id: d.id,
      name: `Display ${i + 1}${d.bounds.x === 0 && d.bounds.y === 0 ? ' (Primary)' : ''}`,
      width: w,
      height: h,
      x,
      y,
      scaleFactor: d.scaleFactor,
      label: `${w}x${h}`,
    };
  });
});

ipcMain.handle('start-recording', async (event, opts) => {
  return recorder.start(opts, (update) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-update', update);
    }
  });
});

ipcMain.handle('stop-recording', () => recorder.stop());

ipcMain.handle('get-status', () => recorder.getStatus());

ipcMain.handle('get-config', () => ({
  outputDir: config.outputDir,
  platform: process.platform,
}));

ipcMain.handle('open-folder', (event, folderPath) => {
  shell.openPath(folderPath);
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose recordings folder',
    defaultPath: config.outputDir,
  });
  if (!result.canceled && result.filePaths[0]) {
    config.outputDir = result.filePaths[0];
    return result.filePaths[0];
  }
  return null;
});

// ── App lifecycle ──

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  if (recorder.getStatus().recording) {
    await recorder.stop();
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
