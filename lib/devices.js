const { execFile } = require('child_process');
const config = require('./config');

function enumerate() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      enumerateWindows(resolve);
    } else if (process.platform === 'darwin') {
      enumerateMac(resolve);
    } else {
      resolve({ cameras: [], audio: [], screens: [], encoder: 'libx264' });
    }
  });
}

// ── Windows: DirectShow devices + gdigrab for screen ──
function enumerateWindows(resolve) {
  execFile(config.ffmpeg, [
    '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'
  ], { timeout: 10000 }, (err, stdout, stderr) => {
    const output = stderr || '';
    const cameras = [];
    const audio = [];
    let section = null;

    for (const line of output.split('\n')) {
      if (line.includes('DirectShow video devices')) { section = 'video'; continue; }
      if (line.includes('DirectShow audio devices')) { section = 'audio'; continue; }
      const m = line.match(/"([^"]+)"/);
      if (m && !line.includes('Alternative name')) {
        if (section === 'video') cameras.push(m[1]);
        else if (section === 'audio') audio.push(m[1]);
      }
    }

    // Windows always has "desktop" via gdigrab
    const screens = [{ id: 'desktop', name: 'Entire Screen' }];

    detectEncoder((encoder) => {
      resolve({ cameras, audio, screens, encoder });
    });
  });
}

// ── Mac: AVFoundation devices (cameras + screens + audio) ──
function enumerateMac(resolve) {
  execFile(config.ffmpeg, [
    '-f', 'avfoundation', '-list_devices', 'true', '-i', ''
  ], { timeout: 10000 }, (err, stdout, stderr) => {
    const output = stderr || '';
    const cameras = [];
    const screens = [];
    const audio = [];
    let section = null;

    for (const line of output.split('\n')) {
      if (line.includes('AVFoundation video devices')) { section = 'video'; continue; }
      if (line.includes('AVFoundation audio devices')) { section = 'audio'; continue; }
      const m = line.match(/\[(\d+)\]\s+(.+)/);
      if (m) {
        const idx = m[1];
        const name = m[2].trim();
        if (section === 'video') {
          if (/screen|display|capture screen/i.test(name)) {
            screens.push({ id: idx, name });
          } else {
            cameras.push({ id: idx, name });
          }
        } else if (section === 'audio') {
          audio.push({ id: idx, name });
        }
      }
    }

    detectEncoderMac((encoder) => {
      resolve({ cameras, audio, screens, encoder });
    });
  });
}

// ── Encoder detection ──
function detectEncoder(callback) {
  tryEncoder('h264_nvenc', () =>
    tryEncoder('h264_qsv', () =>
      tryEncoder('h264_amf', () =>
        callback('libx264')
      , callback)
    , callback)
  , callback);
}

function detectEncoderMac(callback) {
  tryEncoder('h264_videotoolbox', () => callback('libx264'), callback);
}

function tryEncoder(name, onFail, onSuccess) {
  execFile(config.ffmpeg, [
    '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=1',
    '-c:v', name, '-frames:v', '1', '-f', 'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null'
  ], { timeout: 10000 }, (err) => {
    if (err) onFail();
    else onSuccess(name);
  });
}

module.exports = { enumerate };
