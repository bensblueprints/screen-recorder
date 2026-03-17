const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// ── Debug log to file ──
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
let statusInterval = null;
let onUpdate = null;
let lastErrors = { screen: '', webcam: '' };

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
    // probesize + thread_queue_size fix gdigrab blocking when combined with dshow audio
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
    if (opts.audioDevice) {
      args.push('-thread_queue_size', '1024', '-f', 'dshow',
        '-rtbufsize', '256M', '-i', `audio=${opts.audioDevice}`);
    }
  } else {
    const screenIdx = opts.screenId || '1';
    const audioIdx = opts.audioDevice || 'none';
    args.push('-f', 'avfoundation', '-framerate', String(config.framerate),
      '-capture_cursor', '1', '-i', `${screenIdx}:${audioIdx}`);
  }

  // Explicit stream mapping when multiple inputs (prevents FFmpeg guessing wrong)
  if (opts.audioDevice && process.platform === 'win32') {
    args.push('-map', '0:v', '-map', '1:a');
  }

  // Force YUV420P — gdigrab outputs BGRA, NVENC needs yuv420p
  args.push('-pix_fmt', 'yuv420p');
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
    args.push('-thread_queue_size', '1024',
      '-f', 'dshow', '-video_size', res,
      '-framerate', String(config.framerate),
      '-rtbufsize', '256M',
      '-i', `video=${opts.webcamDevice}`);
  } else {
    args.push('-f', 'avfoundation', '-framerate', String(config.framerate),
      '-video_size', res, '-i', `${opts.webcamDevice}:none`);
  }

  // Force YUV420P — HP camera outputs YUV422 which NVENC can't encode directly
  args.push('-pix_fmt', 'yuv420p');
  args.push(...encoderArgs(opts.encoder));
  args.push('-an', '-movflags', '+faststart', '-y', webcamFile);
  return args;
}

// ── Spawn an FFmpeg process with error detection ──
function spawnFFmpeg(args, label) {
  return new Promise((resolve, reject) => {
    log(`[${label}] Spawning FFmpeg:`, config.ffmpeg);
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
      reject(new Error(`${label} FFmpeg failed to launch: ${e.message}`));
    });

    proc.on('close', (code) => {
      exited = true;
      log(`[${label}] Exited with code:`, code);
      if (code !== 0) log(`[${label}] STDERR:`, stderrBuf.slice(-1000));
      if (label === 'screen') lastErrors.screen = stderrBuf;
      else lastErrors.webcam = stderrBuf;
    });

    // Wait 2s then check if process is still alive
    setTimeout(() => {
      if (exited) {
        const errLine = stderrBuf.split('\n').filter(l => /error|cannot|failed|invalid|not found/i.test(l)).pop();
        log(`[${label}] FAILED - exited within 2s. Error:`, errLine);
        reject(new Error(`${label} FFmpeg exited immediately: ${errLine || 'unknown'}\n\nStderr:\n${stderrBuf.slice(-500)}`));
      } else {
        log(`[${label}] Still alive after 2s — recording OK`);
        resolve(proc);
      }
    }, 2000);
  });
}

// ── Start recording ──
async function start(opts, updateCallback) {
  if (screenProc || webcamProc) throw new Error('Already recording');

  log('start() called with opts:', opts);
  log('config.outputDir:', config.outputDir);
  log('config.ffmpeg:', config.ffmpeg);

  onUpdate = updateCallback;
  fs.mkdirSync(config.outputDir, { recursive: true });

  const screenArgs = buildScreenArgs(opts);
  const webcamArgs = opts.webcamDevice ? buildWebcamArgs(opts) : null;

  console.log('[recorder] Screen args:', screenArgs.join(' '));
  if (webcamArgs) console.log('[recorder] Webcam args:', webcamArgs.join(' '));

  const launchTime = Date.now();

  // Spawn screen capture
  try {
    screenProc = await spawnFFmpeg(screenArgs, 'screen');
  } catch (e) {
    screenProc = null;
    screenFile = null;
    throw e;
  }

  // Spawn webcam capture
  if (webcamArgs) {
    try {
      webcamProc = await spawnFFmpeg(webcamArgs, 'webcam');
    } catch (e) {
      // Screen already running — stop it, then throw
      killProc(screenProc);
      screenProc = null;
      screenFile = null;
      webcamProc = null;
      webcamFile = null;
      throw e;
    }
  }

  startTime = launchTime;

  // Sidecar JSON
  const sidecarFile = path.join(config.outputDir, `session_${timestamp()}.json`);
  fs.writeFileSync(sidecarFile, JSON.stringify({
    startTime: new Date(launchTime).toISOString(),
    screenFile,
    webcamFile: webcamFile || null,
    encoder: opts.encoder,
    framerate: config.framerate,
    resolution: opts.resolution || '1280x720',
  }, null, 2));

  // Push status updates
  statusInterval = setInterval(() => {
    if (onUpdate) onUpdate(getStatus());
  }, 1000);

  return { screenFile, webcamFile, sidecarFile };
}

// ── Kill a process safely ──
function killProc(proc) {
  if (!proc) return;
  try { proc.stdin.write('q'); } catch (e) {}
  setTimeout(() => {
    try { proc.kill(); } catch (e) {}
  }, 3000);
}

// ── Stop recording ──
function stop() {
  return new Promise((resolve) => {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }

    const results = { screenFile, webcamFile };
    const procsToStop = [];
    if (screenProc) procsToStop.push(screenProc);
    if (webcamProc) procsToStop.push(webcamProc);

    if (procsToStop.length === 0) {
      cleanup();
      resolve(results);
      return;
    }

    let remaining = procsToStop.length;

    function onDone() {
      remaining--;
      if (remaining <= 0) {
        cleanup();
        resolve(results);
      }
    }

    for (const proc of procsToStop) {
      // If already exited, count it immediately
      if (proc.exitCode !== null || proc.killed) {
        onDone();
        continue;
      }

      proc.once('close', onDone);

      // Send 'q' to stdin for graceful MP4 finalization
      try {
        proc.stdin.write('q');
      } catch (e) {
        // stdin already closed — process likely dead
        // Check if close event will fire
        if (proc.exitCode !== null) onDone();
      }
    }

    // Force kill after 8s if still hanging
    setTimeout(() => {
      for (const proc of procsToStop) {
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
      // If we haven't resolved yet, do it now
      if (remaining > 0) {
        remaining = 0;
        cleanup();
        resolve(results);
      }
    }, 8000);
  });
}

function cleanup() {
  screenProc = null;
  webcamProc = null;
  startTime = null;
  screenFile = null;
  webcamFile = null;
}

// ── Status ──
function getStatus() {
  const recording = !!(screenProc && screenProc.exitCode === null) ||
                    !!(webcamProc && webcamProc.exitCode === null);
  const duration = recording && startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  let screenSize = 0, webcamSize = 0;
  try { if (screenFile) screenSize = fs.statSync(screenFile).size; } catch (e) {}
  try { if (webcamFile) webcamSize = fs.statSync(webcamFile).size; } catch (e) {}

  return {
    recording,
    duration,
    screenFile,
    webcamFile,
    screenSize,
    webcamSize,
    errors: lastErrors,
  };
}

module.exports = { start, stop, getStatus };
