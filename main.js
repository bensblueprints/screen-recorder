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
  // Sort left-to-right by logical X position
  const sorted = [...displays].sort((a, b) => a.bounds.x - b.bounds.x);

  // Compute physical pixel crop X offset by summing widths of displays to the left
  let cropX = 0;
  return sorted.map((d, i) => {
    const w = d.size.width;   // physical pixels
    const h = d.size.height;  // physical pixels
    const x = cropX;
    cropX += w;  // next display starts after this one
    const isPrimary = d.bounds.x === 0 && d.bounds.y === 0;
    return {
      id: d.id,
      name: `Display ${i + 1}${isPrimary ? ' (Primary)' : ''}`,
      width: w,
      height: h,
      cropX: x,    // X offset for FFmpeg crop filter
      cropY: 0,    // assume horizontal arrangement
      label: `${w}x${h}`,
    };
  });
});

ipcMain.handle('start-recording', async (event, opts) => {
  return recorder.start(opts, (update) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-update', update);
    }
  }, (jpegBuf) => {
    // Send webcam preview frames during recording
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('webcam-frame', jpegBuf.toString('base64'));
    }
  });
});

ipcMain.handle('stop-recording', () => recorder.stop());

ipcMain.handle('stack-export', async (event, sessionPath, encoder) => {
  return recorder.stackExport(sessionPath, encoder, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stack-progress', progress);
    }
  });
});

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
