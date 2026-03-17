const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// ── Debug log ──
const LOG_FILE = path.join(__dirname, '..', 'debug.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log('[recorder]', ...args);
}

let screenProc = null;
let webcamProc = null;
let startTime = null;
let screenFile = null;
let webcamFile = null;
let sessionDir = null;
let statusInterval = null;
let onUpdate = null;
let lastErrors = { screen: '', webcam: '' };

// ── Encoder args ──
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

// Screen: VIDEO ONLY (no audio)
function buildScreenArgs(opts, outDir) {
  screenFile = path.join(outDir, 'screen.mp4');
  const args = [];

  if (process.platform === 'win32') {
    args.push('-probesize', '10M', '-thread_queue_size', '1024');
    if (opts.display && opts.display.width) {
      args.push('-f', 'gdigrab', '-framerate', String(config.framerate),
        '-draw_mouse', '1',
        '-offset_x', String(opts.display.x),
        '-offset_y', String(opts.display.y),
        '-video_size', `${opts.display.width}x${opts.display.height}`,
        '-i', 'desktop');
    } else {
      args.push('-f', 'gdigrab', '-framerate', String(config.framerate),
        '-draw_mouse', '1', '-i', 'desktop');
    }
  } else {
    const screenIdx = opts.screenId || '1';
    args.push('-f', 'avfoundation', '-framerate', String(config.framerate),
      '-capture_cursor', '1', '-i', `${screenIdx}:none`);
  }

  args.push('-pix_fmt', 'yuv420p');
  args.push(...encoderArgs(opts.encoder));
  args.push('-an'); // No audio on screen file
  args.push('-movflags', '+faststart', '-y', screenFile);
  return args;
}

// Webcam: VIDEO + AUDIO (mic audio goes with the webcam)
function buildWebcamArgs(opts, outDir) {
  webcamFile = path.join(outDir, 'webcam.mp4');
  const args = [];
  const res = opts.resolution || '1280x720';

  if (process.platform === 'win32') {
    // Combine video + audio in ONE DirectShow input for perfect sync
    // Format: video=CamName:audio=MicName — both streams share the same clock
    const dshowInput = opts.audioDevice
      ? `video=${opts.webcamDevice}:audio=${opts.audioDevice}`
      : `video=${opts.webcamDevice}`;

    args.push('-thread_queue_size', '1024',
      '-f', 'dshow', '-video_size', res,
      '-framerate', String(config.framerate),
      '-rtbufsize', '256M',
      '-i', dshowInput);
  } else {
    const audioIdx = opts.audioDevice || 'none';
    args.push('-f', 'avfoundation', '-framerate', String(config.framerate),
      '-video_size', res, '-i', `${opts.webcamDevice}:${audioIdx}`);
  }

  args.push('-pix_fmt', 'yuv420p');
  args.push(...encoderArgs(opts.encoder));

  if (opts.audioDevice) {
    args.push('-c:a', 'aac', '-b:a', config.audioBitrate);
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', '-y', webcamFile);
  return args;
}

// ── Spawn FFmpeg with error detection ──
function spawnFFmpeg(args, label) {
  return new Promise((resolve, reject) => {
    log(`[${label}] Args:`, args.join(' '));
    const proc = spawn(config.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuf = '';
    let exited = false;

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    proc.on('error', (e) => {
      exited = true;
      log(`[${label}] SPAWN ERROR:`, e.message);
      reject(new Error(`${label}: ${e.message}`));
    });

    proc.on('close', (code) => {
      exited = true;
      log(`[${label}] Exited code:`, code);
      if (code !== 0) log(`[${label}] STDERR:`, stderrBuf.slice(-800));
      if (label === 'screen') lastErrors.screen = stderrBuf;
      else lastErrors.webcam = stderrBuf;
    });

    // Check after 1.5s if still alive
    setTimeout(() => {
      if (exited) {
        const errLine = stderrBuf.split('\n').filter(l => /error|cannot|failed|invalid|not found/i.test(l)).pop();
        reject(new Error(`${label}: ${errLine || 'FFmpeg exited'}\n${stderrBuf.slice(-300)}`));
      } else {
        log(`[${label}] Recording OK`);
        resolve(proc);
      }
    }, 1500);
  });
}

// ── Start recording ──
async function start(opts, updateCallback) {
  if (screenProc || webcamProc) throw new Error('Already recording');

  log('start() opts:', opts);
  onUpdate = updateCallback;

  // Create session subfolder: recordings/2026-03-17_02-33-13/
  const ts = timestamp();
  sessionDir = path.join(config.outputDir, ts);
  fs.mkdirSync(sessionDir, { recursive: true });

  const screenArgs = buildScreenArgs(opts, sessionDir);
  const webcamArgs = opts.webcamDevice ? buildWebcamArgs(opts, sessionDir) : null;

  // Spawn BOTH simultaneously for sync — don't await one before the other
  const screenPromise = spawnFFmpeg(screenArgs, 'screen');
  const webcamPromise = webcamArgs ? spawnFFmpeg(webcamArgs, 'webcam') : Promise.resolve(null);

  try {
    const [sp, wp] = await Promise.all([screenPromise, webcamPromise]);
    screenProc = sp;
    webcamProc = wp;
  } catch (e) {
    // If one failed, kill the other
    killProc(screenProc);
    killProc(webcamProc);
    screenProc = null;
    webcamProc = null;
    screenFile = null;
    webcamFile = null;
    throw e;
  }

  startTime = Date.now();

  // Sidecar JSON in the session folder
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    startTime: new Date(startTime).toISOString(),
    screenFile,
    webcamFile: webcamFile || null,
    encoder: opts.encoder,
    framerate: config.framerate,
    resolution: opts.resolution || '1280x720',
  }, null, 2));

  statusInterval = setInterval(() => {
    if (onUpdate) onUpdate(getStatus());
  }, 1000);

  return { screenFile, webcamFile, sessionDir };
}

// ── Kill a process ──
function killProc(proc) {
  if (!proc) return;
  try { proc.stdin.write('q'); } catch (e) {}
  setTimeout(() => { try { proc.kill(); } catch (e) {} }, 3000);
}

// ── Stop recording — send 'q' to BOTH at the same instant ──
function stop() {
  return new Promise((resolve) => {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

    const results = { screenFile, webcamFile, sessionDir };
    const procs = [];
    if (screenProc) procs.push(screenProc);
    if (webcamProc) procs.push(webcamProc);

    if (procs.length === 0) { cleanup(); resolve(results); return; }

    let remaining = procs.length;
    function onDone() {
      if (--remaining <= 0) { cleanup(); resolve(results); }
    }

    // Send 'q' to ALL processes at the same time for equal duration
    for (const proc of procs) {
      if (proc.exitCode !== null || proc.killed) { onDone(); continue; }
      proc.once('close', onDone);
      try { proc.stdin.write('q'); } catch (e) {
        if (proc.exitCode !== null) onDone();
      }
    }

    setTimeout(() => {
      for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} }
      if (remaining > 0) { remaining = 0; cleanup(); resolve(results); }
    }, 8000);
  });
}

function cleanup() {
  screenProc = null;
  webcamProc = null;
  startTime = null;
  screenFile = null;
  webcamFile = null;
  sessionDir = null;
}

// ── Stack Export: screen on top, webcam on bottom, 1080x1920 (9:16) ──
function stackExport(sessionPath, encoder, onProgress) {
  return new Promise((resolve, reject) => {
    const screenMp4 = path.join(sessionPath, 'screen.mp4');
    const webcamMp4 = path.join(sessionPath, 'webcam.mp4');
    const stackedFile = path.join(sessionPath, 'stacked.mp4');

    if (!fs.existsSync(screenMp4)) return reject(new Error('screen.mp4 not found'));
    if (!fs.existsSync(webcamMp4)) return reject(new Error('webcam.mp4 not found'));

    log('stackExport:', sessionPath);

    // 1080x1920 (9:16 portrait)
    // Top half: screen scaled/cropped to 1080x960
    // Bottom half: webcam scaled/cropped to 1080x960
    // Audio from webcam file
    const args = [
      '-i', screenMp4,
      '-i', webcamMp4,
      '-filter_complex',
      [
        // Scale screen to fill 1080 wide, crop to 960 tall (center crop)
        '[0:v]scale=1080:-2,crop=1080:960[top]',
        // Scale webcam to fill 1080 wide, crop to 960 tall (center crop)
        '[1:v]scale=1080:-2,crop=1080:960[bot]',
        // Stack vertically
        '[top][bot]vstack=inputs=2[out]',
      ].join(';'),
      '-map', '[out]',
      '-map', '1:a?', // Audio from webcam (? = optional if no audio)
      '-pix_fmt', 'yuv420p',
      ...encoderArgs(encoder),
      '-c:a', 'aac', '-b:a', config.audioBitrate,
      '-movflags', '+faststart',
      '-shortest',
      '-y', stackedFile,
    ];

    log('stackExport args:', args.join(' '));

    const proc = spawn(config.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuf = '';

    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      // Parse progress: "frame= 123 fps= 30 ... time=00:00:04.10"
      const timeMatch = stderrBuf.match(/time=(\d+:\d+:\d+\.\d+)/g);
      if (timeMatch && onProgress) {
        onProgress(timeMatch[timeMatch.length - 1].replace('time=', ''));
      }
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(stackedFile)) {
        const size = fs.statSync(stackedFile).size;
        log('stackExport done:', stackedFile, size, 'bytes');
        resolve({ file: stackedFile, size });
      } else {
        const errLine = stderrBuf.split('\n').filter(l => /error/i.test(l)).pop();
        log('stackExport FAILED:', errLine);
        reject(new Error(errLine || 'Stack export failed'));
      }
    });

    proc.on('error', (e) => reject(e));
  });
}

// ── Status ──
function getStatus() {
  const recording = !!(screenProc && screenProc.exitCode === null) ||
                    !!(webcamProc && webcamProc.exitCode === null);
  const duration = recording && startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  let screenSize = 0, webcamSize = 0;
  try { if (screenFile) screenSize = fs.statSync(screenFile).size; } catch (e) {}
  try { if (webcamFile) webcamSize = fs.statSync(webcamFile).size; } catch (e) {}

  return { recording, duration, screenFile, webcamFile, screenSize, webcamSize, sessionDir };
}

module.exports = { start, stop, getStatus, stackExport };
