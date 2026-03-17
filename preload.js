const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  startRecording: (opts) => ipcRenderer.invoke('start-recording', opts),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  onRecordingUpdate: (cb) => {
    ipcRenderer.on('recording-update', (_event, data) => cb(data));
  },
});
