const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

let screenProc = null;
let webcamProc = null;
let startTime = null;
let screenFile = null;
let webcamFile = null;
let statusInterval = null;
let onUpdate = null;

// ── Encoder args helper ──
function encoderArgs(encoder) {
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', config.preset, '-cq', String(config.crf)];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', '65'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(config.crf)];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(config.crf), '-qp_p', String(config.crf)];
    default:
      return ['-c:v', 'libx264', '-preset', config.cpuPreset, '-crf', String(config.crf)];
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Build FFmpeg args ──
function buildScreenArgs(opts) {
  const ts = timestamp();
  screenFile = path.join(config.outputDir, `screen_${ts}.mp4`);
  const args = [];

  if (process.platform === 'win32') {
    args.push('-f', 'gdigrab', '-framerate', String(config.framerate), '-i', 'desktop');
    if (opts.audioDevice) {
      args.push('-f', 'dshow', '-i', `audio=${opts.audioDevice}`);
    }
  } else {
    // macOS avfoundation
    const screenIdx = opts.screenId || '1';
    const audioIdx = opts.audioDevice || 'none';
    args.push('-f', 'avfoundation', '-framerate', String(config.framerate),
      '-capture_cursor', '1', '-i', `${screenIdx}:${audioIdx}`);
  }

  args.push(...encoderArgs(opts.encoder));

  if (opts.audioDevice) {
    args.push('-c:a', 'aac', '-b:a', config.audioBitrate);
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', '-y', screenFile);
  return args;
}

function buildWebcamArgs(opts) {
  const ts = timestamp();
  webcamFile = path.join(config.outputDir, `webcam_${ts}.mp4`);
  const args = [];
  const res = opts.resolution || '1280x720';

  if (process.platform === 'win32') {
    args.push('-f', 'dshow', '-video_size', res,
      '-framerate', String(config.framerate),
      '-i', `video=${opts.webcamDevice}`);
  } else {
    args.push('-f', 'avfoundation', '-framerate', String(config.framerate),
      '-video_size', res, '-i', `${opts.webcamDevice}:none`);
  }

  args.push(...encoderArgs(opts.encoder));
  args.push('-an', '-movflags', '+faststart', '-y', webcamFile);
  return args;
}

// ── Start recording ──
async function start(opts, updateCallback) {
  if (screenProc || webcamProc) throw new Error('Already recording');

  onUpdate = updateCallback;
  fs.mkdirSync(config.outputDir, { recursive: true });

  const screenArgs = buildScreenArgs(opts);
  const webcamArgs = opts.webcamDevice ? buildWebcamArgs(opts) : null;
  const launchTime = Date.now();

  // Spawn both simultaneously for minimal offset
  const promises = [];

  promises.push(new Promise((resolve, reject) => {
    screenProc = spawn(config.ffmpeg, screenArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    screenProc.stderr.on('data', () => {}); // drain stderr
    screenProc.on('error', (e) => { screenProc = null; reject(e); });
    setTimeout(resolve, 500);
  }));

  if (webcamArgs) {
    promises.push(new Promise((resolve, reject) => {
      webcamProc = spawn(config.ffmpeg, webcamArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      webcamProc.stderr.on('data', () => {});
      webcamProc.on('error', (e) => { webcamProc = null; reject(e); });
      setTimeout(resolve, 500);
    }));
  }

  await Promise.all(promises);
  startTime = launchTime;

  // Sidecar JSON for sync alignment in editing
  const sidecarFile = path.join(config.outputDir, `session_${timestamp()}.json`);
  fs.writeFileSync(sidecarFile, JSON.stringify({
    startTime: new Date(launchTime).toISOString(),
    screenFile,
    webcamFile: webcamFile || null,
    encoder: opts.encoder,
    framerate: config.framerate,
    resolution: opts.resolution || '1280x720',
  }, null, 2));

  // Push status updates every second
  statusInterval = setInterval(() => {
    if (onUpdate) onUpdate(getStatus());
  }, 1000);

  return { screenFile, webcamFile, sidecarFile };
}

// ── Stop recording ──
function stop() {
  return new Promise((resolve) => {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

    const results = { screenFile, webcamFile };
    let pending = 0;

    function done() {
      if (--pending <= 0) {
        screenProc = null;
        webcamProc = null;
        startTime = null;
        screenFile = null;
        webcamFile = null;
        resolve(results);
      }
    }

    if (screenProc) {
      pending++;
      screenProc.on('close', done);
      try { screenProc.stdin.write('q'); } catch (e) { done(); }
    }
    if (webcamProc) {
      pending++;
      webcamProc.on('close', done);
      try { webcamProc.stdin.write('q'); } catch (e) { done(); }
    }

    if (pending === 0) resolve(results);

    // Force kill after 10s
    setTimeout(() => {
      if (screenProc) try { screenProc.kill(); } catch (e) {}
      if (webcamProc) try { webcamProc.kill(); } catch (e) {}
    }, 10000);
  });
}

// ── Status ──
function getStatus() {
  const recording = !!(screenProc || webcamProc);
  const duration = recording && startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  let screenSize = 0, webcamSize = 0;
  try { if (screenFile) screenSize = fs.statSync(screenFile).size; } catch (e) {}
  try { if (webcamFile) webcamSize = fs.statSync(webcamFile).size; } catch (e) {}

  return { recording, duration, screenFile, webcamFile, screenSize, webcamSize };
}

module.exports = { start, stop, getStatus };
