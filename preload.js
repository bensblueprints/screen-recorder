const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  startRecording: (opts) => ipcRenderer.invoke('start-recording', opts),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  stackExport: (sessionPath, encoder) => ipcRenderer.invoke('stack-export', sessionPath, encoder),
  onStackProgress: (cb) => {
    ipcRenderer.on('stack-progress', (_event, data) => cb(data));
  },
  getStatus: () => ipcRenderer.invoke('get-status'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  onRecordingUpdate: (cb) => {
    ipcRenderer.on('recording-update', (_event, data) => cb(data));
  },
  onWebcamFrame: (cb) => {
    ipcRenderer.on('webcam-frame', (_event, base64) => cb(base64));
  },
});
