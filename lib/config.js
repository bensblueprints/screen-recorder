const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// FFmpeg binary — cross-platform auto-detect
function findFFmpeg() {
  if (process.platform === 'win32') {
    const winget = 'C:\\Users\\admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe';
    if (fs.existsSync(winget)) return winget;
  }
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (fs.existsSync(p)) return p;
    }
  }
  return 'ffmpeg'; // Fall back to PATH
}

// Output directory — user's Documents when packaged, local when dev
function getOutputDir() {
  try {
    if (app && app.isPackaged) {
      return path.join(app.getPath('documents'), 'Screen Recordings');
    }
  } catch (e) {}
  return path.join(__dirname, '..', 'recordings');
}

module.exports = {
  ffmpeg: findFFmpeg(),
  outputDir: getOutputDir(),
  port: 3847,
  crf: 20,
  audioBitrate: '192k',
  framerate: 30,
  preset: 'p4',
  cpuPreset: 'fast',
};
