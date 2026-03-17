// ── State ──
let isRecording = false;
let encoder = 'libx264';
let outputDir = '';
let screenStream = null;
let webcamStream = null;
let displays = [];       // Electron display objects with bounds
let screenSources = [];  // desktopCapturer sources for preview

// ── DOM refs ──
const $ = (s) => document.querySelector(s);
const screenSelect = $('#screenSelect');
const webcamSelect = $('#webcam');
const micSelect = $('#mic');
const resolutionSelect = $('#resolution');
const encoderBadge = $('#encoderBadge');
const screenPreview = $('#screenPreview');
const webcamPreview = $('#webcamPreview');
const screenPlaceholder = $('#screenPlaceholder');
const webcamPlaceholder = $('#webcamPlaceholder');
const recordBtn = $('#recordBtn');
const recordLabel = $('#recordLabel');
const timer = $('#timer');
const fileInfo = $('#fileInfo');
const folderBtn = $('#folderBtn');
const refreshBtn = $('#refreshBtn');
const outputPath = $('#outputPath');
const changeOutputBtn = $('#changeOutputBtn');
const openOutputBtn = $('#openOutputBtn');

// ── Init ──
async function init() {
  await loadDevices();
  recordBtn.disabled = false;
}

async function loadDevices() {
  const [ffmpegDevices, configData, displayList, sources] = await Promise.all([
    window.api.getDevices(),
    window.api.getConfig(),
    window.api.getDisplays(),
    window.api.getScreenSources(),
  ]);

  outputDir = configData.outputDir;
  outputPath.textContent = outputDir;
  encoder = ffmpegDevices.encoder;
  displays = displayList;
  screenSources = sources;

  // Also get browser media devices (catches USB cameras/mics FFmpeg might miss)
  let browserVideos = [];
  let browserAudios = [];
  try {
    // Request permission first so labels are populated
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => null);
    if (tempStream) tempStream.getTracks().forEach(t => t.stop());

    const browserDevices = await navigator.mediaDevices.enumerateDevices();
    browserVideos = browserDevices.filter(d => d.kind === 'videoinput' && d.label);
    browserAudios = browserDevices.filter(d => d.kind === 'audioinput' && d.label);
  } catch (e) {
    console.warn('Browser device enumeration failed:', e);
  }

  // Browser appends USB vendor:product IDs like " (14ed:1019)" to labels
  // Strip these so names match FFmpeg's DirectShow names
  function stripUsbId(label) {
    return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
  }

  // ── Populate screen dropdown ──
  screenSelect.innerHTML = '';
  if (displays.length <= 1) {
    const opt = document.createElement('option');
    opt.value = '0';
    opt.textContent = displays[0] ? `${displays[0].name} (${displays[0].label})` : 'Entire Screen';
    opt.dataset.bounds = JSON.stringify(displays[0] || {});
    screenSelect.appendChild(opt);
  } else {
    displays.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${d.name} - ${d.label}`;
      opt.dataset.bounds = JSON.stringify(d);
      screenSelect.appendChild(opt);
    });
  }

  // ── Populate camera dropdown (merge FFmpeg + browser) ──
  const cameraNames = new Set();
  const cameras = [];

  // FFmpeg cameras first (these names are what FFmpeg needs for recording)
  for (const cam of ffmpegDevices.cameras) {
    const name = typeof cam === 'string' ? cam : cam.name;
    cameras.push({ name, ffmpegName: name });
    cameraNames.add(name.toLowerCase());
  }

  // Add browser cameras that FFmpeg didn't find (e.g. USB cameras like Osmo Pocket)
  for (const bd of browserVideos) {
    const cleanLabel = stripUsbId(bd.label);
    const alreadyListed = [...cameraNames].some(n =>
      cleanLabel.toLowerCase().includes(n) || n.includes(cleanLabel.toLowerCase())
    );
    if (!alreadyListed) {
      cameras.push({ name: cleanLabel, ffmpegName: cleanLabel });
      cameraNames.add(cleanLabel.toLowerCase());
    }
  }

  webcamSelect.innerHTML = '<option value="">None</option>';
  for (const cam of cameras) {
    const opt = document.createElement('option');
    opt.value = cam.ffmpegName;
    opt.textContent = cam.name;
    webcamSelect.appendChild(opt);
  }

  // ── Populate mic dropdown (merge FFmpeg + browser) ──
  const micNames = new Set();
  const mics = [];

  for (const mic of ffmpegDevices.audio) {
    const name = typeof mic === 'string' ? mic : mic.name;
    mics.push({ name, ffmpegName: name });
    micNames.add(name.toLowerCase());
  }

  for (const bd of browserAudios) {
    if (bd.label.toLowerCase().includes('default')) continue;
    const cleanLabel = stripUsbId(bd.label);
    const alreadyListed = [...micNames].some(n =>
      cleanLabel.toLowerCase().includes(n) || n.includes(cleanLabel.toLowerCase())
    );
    if (!alreadyListed) {
      mics.push({ name: cleanLabel, ffmpegName: cleanLabel });
      micNames.add(cleanLabel.toLowerCase());
    }
  }

  micSelect.innerHTML = '<option value="">None (no audio)</option>';
  for (const mic of mics) {
    const opt = document.createElement('option');
    opt.value = mic.ffmpegName;
    opt.textContent = mic.name;
    micSelect.appendChild(opt);
  }
  // Auto-select first mic
  if (mics.length > 0) micSelect.selectedIndex = 1;

  // Encoder badge
  const isHW = encoder !== 'libx264';
  encoderBadge.textContent = `Encoder: ${encoder}${isHW ? ' (hardware)' : ' (software)'} | ${cameras.length} cam, ${mics.length} mic, ${displays.length} display`;
  encoderBadge.className = `encoder-badge ${isHW ? 'hw' : 'sw'}`;

  // Auto-select first webcam and start preview
  if (cameras.length > 0) {
    webcamSelect.selectedIndex = 1;
    startWebcamPreview();
  }

  // Auto-start screen preview
  startScreenPreview();
}

// ── Screen preview via desktopCapturer ──
async function startScreenPreview() {
  // Stop existing
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  try {
    if (screenSources.length === 0) return;

    // Match the selected display to a desktopCapturer source
    const selectedIdx = parseInt(screenSelect.value) || 0;
    // desktopCapturer sources are ordered same as displays, pick matching one
    const source = screenSources[selectedIdx] || screenSources[0];

    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxFrameRate: 15,
        }
      }
    });

    screenPreview.srcObject = screenStream;
    screenPreview.classList.add('active');
    screenPlaceholder.classList.add('hidden');
  } catch (e) {
    console.error('Screen preview failed:', e);
    screenPlaceholder.textContent = 'Screen preview unavailable';
    screenPlaceholder.classList.remove('hidden');
    screenPreview.classList.remove('active');
  }
}

// ── Webcam preview via getUserMedia ──
async function startWebcamPreview() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }

  const selectedName = webcamSelect.value;
  if (!selectedName) {
    webcamPreview.classList.remove('active');
    webcamPlaceholder.classList.remove('hidden');
    webcamPlaceholder.textContent = 'Select a camera above';
    return;
  }

  try {
    const browserDevices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = browserDevices.filter(d => d.kind === 'videoinput');

    let constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };

    // Match by label (fuzzy: check if either contains the other)
    const matched = videoDevices.find(d => {
      const bl = d.label.toLowerCase();
      const sl = selectedName.toLowerCase();
      return bl.includes(sl) || sl.includes(bl) || bl === sl;
    });

    if (matched) {
      constraints.video.deviceId = { exact: matched.deviceId };
    } else if (videoDevices.length > 0) {
      // Fall back — try each device by index matching the dropdown position
      const idx = webcamSelect.selectedIndex - 1; // -1 for "None" option
      if (idx >= 0 && idx < videoDevices.length) {
        constraints.video.deviceId = { exact: videoDevices[idx].deviceId };
      }
    }

    webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    webcamPreview.srcObject = webcamStream;
    webcamPreview.classList.add('active');
    webcamPlaceholder.classList.add('hidden');
  } catch (e) {
    console.error('Webcam preview failed:', e);
    webcamPlaceholder.textContent = `Preview failed: ${e.message}`;
    webcamPlaceholder.classList.remove('hidden');
    webcamPreview.classList.remove('active');
  }
}

// ── Format helpers ──
function formatTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function basename(filepath) {
  return filepath ? filepath.replace(/\\/g, '/').split('/').pop() : '';
}

// ── Release WEBCAM preview only (screen preview stays — gdigrab doesn't conflict) ──
function releaseWebcamPreview() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
    webcamPreview.srcObject = null;
    webcamPreview.classList.remove('active');
    webcamPlaceholder.textContent = 'Recording...';
    webcamPlaceholder.classList.remove('hidden');
  }
}

// ── Restore webcam preview after recording stops ──
function restoreWebcamPreview() {
  if (webcamSelect.value) startWebcamPreview();
}

// ── Recording ──
async function toggleRecording() {
  if (isRecording) {
    recordBtn.disabled = true;
    recordLabel.textContent = 'Stopping...';

    // Timeout: if stop takes >12s, force reset the UI
    const stopTimeout = setTimeout(() => {
      console.warn('Stop timed out, resetting UI');
      isRecording = false;
      recordBtn.classList.remove('recording');
      recordBtn.disabled = false;
      recordLabel.textContent = 'Record';
      timer.classList.remove('recording');
      fileInfo.textContent = 'Stop timed out — files may be incomplete';
      restoreWebcamPreview();
    }, 12000);

    try {
      const result = await window.api.stopRecording();
      clearTimeout(stopTimeout);
      isRecording = false;
      recordBtn.classList.remove('recording');
      recordBtn.disabled = false;
      recordLabel.textContent = 'Record';
      timer.classList.remove('recording');

      if (result.sessionDir) {
        fileInfo.textContent = `Saved to: ${result.sessionDir}`;
      } else {
        fileInfo.textContent = 'Saved';
      }
    } catch (e) {
      clearTimeout(stopTimeout);
      isRecording = false;
      recordBtn.classList.remove('recording');
      recordBtn.disabled = false;
      recordLabel.textContent = 'Record';
      timer.classList.remove('recording');
      fileInfo.textContent = `Stop error: ${e.message || e}`;
    }

    // Restore webcam preview after FFmpeg releases the device
    setTimeout(restoreWebcamPreview, 500);
  } else {
    // Build display bounds for the selected screen
    const selectedIdx = parseInt(screenSelect.value) || 0;
    const display = displays[selectedIdx] || null;

    const opts = {
      encoder,
      webcamDevice: webcamSelect.value || null,
      audioDevice: micSelect.value || null,
      resolution: resolutionSelect.value,
      display: display ? {
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
      } : null,
    };

    recordBtn.disabled = true;
    recordLabel.textContent = 'Starting...';

    // Release webcam preview only — screen preview (desktopCapturer) doesn't
    // conflict with gdigrab since they use different capture APIs
    releaseWebcamPreview();

    // Brief pause for Windows to release the DirectShow device handle
    await new Promise(r => setTimeout(r, 200));

    try {
      const result = await window.api.startRecording(opts);
      isRecording = true;
      recordBtn.classList.add('recording');
      recordLabel.textContent = 'Stop';
      timer.classList.add('recording');
      fileInfo.textContent = '';
      console.log('Recording started:', result);

      // Try to reopen webcam preview after FFmpeg has the device
      // Many Windows camera drivers allow shared access
      if (opts.webcamDevice) {
        setTimeout(async () => {
          try {
            await startWebcamPreview();
            console.log('Webcam preview restored during recording');
          } catch (e) {
            console.log('Webcam preview not available during recording (exclusive lock)');
          }
        }, 1000);
      }
    } catch (e) {
      console.error('Start failed:', e);
      const msg = (e.message || String(e)).replace('Error invoking remote method \'start-recording\': Error: ', '');
      fileInfo.textContent = `Error: ${msg.slice(0, 200)}`;
      restoreWebcamPreview();
    }
    recordBtn.disabled = false;
  }
}

// ── Real-time updates ──
window.api.onRecordingUpdate((status) => {
  if (!isRecording) return;
  timer.textContent = formatTime(status.duration);

  const parts = [];
  if (status.screenFile) parts.push(`Screen: ${formatBytes(status.screenSize)}`);
  if (status.webcamFile) parts.push(`Webcam: ${formatBytes(status.webcamSize)}`);
  fileInfo.textContent = parts.join('  |  ');
});

// ── Event listeners ──
recordBtn.addEventListener('click', toggleRecording);
webcamSelect.addEventListener('change', startWebcamPreview);
screenSelect.addEventListener('change', startScreenPreview);
folderBtn.addEventListener('click', () => window.api.openFolder(outputDir));
openOutputBtn.addEventListener('click', () => window.api.openFolder(outputDir));
changeOutputBtn.addEventListener('click', async () => {
  const newPath = await window.api.chooseFolder();
  if (newPath) {
    outputDir = newPath;
    outputPath.textContent = newPath;
  }
});
refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.style.opacity = '0.4';
  await loadDevices();
  refreshBtn.disabled = false;
  refreshBtn.style.opacity = '1';
});

// Keyboard shortcut: Space to toggle recording
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    if (!recordBtn.disabled) toggleRecording();
  }
});

// Boot
init();
