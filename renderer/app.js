// ── State ──
let isRecording = false;
let encoder = 'libx264';
let outputDir = '';
let screenStream = null;
let webcamStream = null;

// ── DOM refs ──
const $ = (s) => document.querySelector(s);
const webcamSelect = $('#webcam');
const micSelect = $('#mic');
const resolutionSelect = $('#resolution');
const encoderBadge = $('#encoderBadge');
const screenPreview = $('#screenPreview');
const webcamPreview = $('#webcamPreview');
const screenPlaceholder = $('#screenPlaceholder');
const webcamPlaceholder = $('#webcamPlaceholder');
const screenPanel = $('#screenPanel');
const recordBtn = $('#recordBtn');
const recordLabel = $('#recordLabel');
const timer = $('#timer');
const fileInfo = $('#fileInfo');
const folderBtn = $('#folderBtn');

// ── Init ──
async function init() {
  const [deviceData, configData] = await Promise.all([
    window.api.getDevices(),
    window.api.getConfig(),
  ]);

  outputDir = configData.outputDir;
  encoder = deviceData.encoder;

  // Populate webcam dropdown
  webcamSelect.innerHTML = '<option value="">None</option>';
  for (const cam of deviceData.cameras) {
    const name = typeof cam === 'string' ? cam : cam.name;
    const val = typeof cam === 'string' ? cam : cam.id;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = name;
    webcamSelect.appendChild(opt);
  }

  // Populate mic dropdown
  micSelect.innerHTML = '<option value="">None (no audio)</option>';
  for (const mic of deviceData.audio) {
    const name = typeof mic === 'string' ? mic : mic.name;
    const val = typeof mic === 'string' ? mic : mic.id;
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = name;
    micSelect.appendChild(opt);
  }
  // Auto-select first mic
  if (deviceData.audio.length > 0) micSelect.selectedIndex = 1;

  // Encoder badge
  const isHW = encoder !== 'libx264';
  encoderBadge.textContent = `Encoder: ${encoder}${isHW ? ' (hardware)' : ' (software)'}`;
  encoderBadge.className = `encoder-badge ${isHW ? 'hw' : 'sw'}`;

  recordBtn.disabled = false;

  // Auto-select first webcam
  if (deviceData.cameras.length > 0) {
    webcamSelect.selectedIndex = 1;
    startWebcamPreview();
  }
}

// ── Screen preview via desktopCapturer ──
async function startScreenPreview() {
  try {
    const sources = await window.api.getScreenSources();
    if (sources.length === 0) return;

    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sources[0].id,
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
  }
}

// ── Webcam preview via getUserMedia ──
async function startWebcamPreview() {
  // Stop existing stream
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }

  const deviceId = webcamSelect.value;
  if (!deviceId) {
    webcamPreview.classList.remove('active');
    webcamPlaceholder.classList.remove('hidden');
    webcamPlaceholder.textContent = 'Select a webcam above';
    return;
  }

  try {
    // On Windows, we can't use deviceId constraint for dshow devices
    // Instead, enumerate browser media devices and match by label
    const browserDevices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = browserDevices.filter(d => d.kind === 'videoinput');

    // Try to find matching device by label containing the selected name
    let constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    const matchedDevice = videoDevices.find(d => d.label.includes(deviceId) || deviceId.includes(d.label));
    if (matchedDevice) {
      constraints.video.deviceId = { exact: matchedDevice.deviceId };
    } else if (videoDevices.length > 0) {
      // Fall back to first available device
      constraints.video.deviceId = { exact: videoDevices[0].deviceId };
    }

    webcamStream = await navigator.mediaDevices.getUserMedia(constraints);
    webcamPreview.srcObject = webcamStream;
    webcamPreview.classList.add('active');
    webcamPlaceholder.classList.add('hidden');
  } catch (e) {
    console.error('Webcam preview failed:', e);
    webcamPlaceholder.textContent = 'Webcam preview failed';
    webcamPlaceholder.classList.remove('hidden');
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

// ── Recording ──
async function toggleRecording() {
  if (isRecording) {
    // Stop
    recordBtn.disabled = true;
    recordLabel.textContent = 'Stopping...';

    const result = await window.api.stopRecording();
    isRecording = false;
    recordBtn.classList.remove('recording');
    recordBtn.disabled = false;
    recordLabel.textContent = 'Record';
    timer.classList.remove('recording');

    // Show final files
    const parts = [];
    if (result.screenFile) parts.push(basename(result.screenFile));
    if (result.webcamFile) parts.push(basename(result.webcamFile));
    fileInfo.textContent = parts.length ? `Saved: ${parts.join(' + ')}` : '';
  } else {
    // Start
    const opts = {
      encoder,
      webcamDevice: webcamSelect.value || null,
      audioDevice: micSelect.value || null,
      resolution: resolutionSelect.value,
    };

    recordBtn.disabled = true;
    recordLabel.textContent = 'Starting...';

    try {
      await window.api.startRecording(opts);
      isRecording = true;
      recordBtn.classList.add('recording');
      recordLabel.textContent = 'Stop';
      timer.classList.add('recording');
      fileInfo.textContent = '';
    } catch (e) {
      console.error('Start failed:', e);
      fileInfo.textContent = `Error: ${e.message || e}`;
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
folderBtn.addEventListener('click', () => window.api.openFolder(outputDir));
screenPanel.addEventListener('click', () => {
  if (!screenStream) startScreenPreview();
});

// ── Keyboard shortcut: Space to toggle recording ──
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'SELECT') {
    e.preventDefault();
    if (!recordBtn.disabled) toggleRecording();
  }
});

// Boot
init();
