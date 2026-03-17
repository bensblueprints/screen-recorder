// Test script that mimics exactly what the Electron app does
// Run: node test-record.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FFMPEG = 'C:\\Users\\admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe';
const OUTPUT_DIR = path.join(__dirname, 'recordings');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// === Screen args (exactly as recorder.js builds them) ===
const screenFile = path.join(OUTPUT_DIR, `test_node_screen_${ts}.mp4`);
const screenArgs = [
  '-probesize', '10M', '-thread_queue_size', '1024',
  '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '1', '-i', 'desktop',
  '-thread_queue_size', '1024', '-f', 'dshow', '-rtbufsize', '256M',
  '-i', 'audio=Microphone (Shure MV7+)',
  '-map', '0:v', '-map', '1:a',
  '-pix_fmt', 'yuv420p',
  '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20',
  '-c:a', 'aac', '-b:a', '192k',
  '-movflags', '+faststart', '-y', screenFile
];

// === Webcam args ===
const webcamFile = path.join(OUTPUT_DIR, `test_node_webcam_${ts}.mp4`);
const webcamArgs = [
  '-thread_queue_size', '1024',
  '-f', 'dshow', '-video_size', '1280x720', '-framerate', '30',
  '-rtbufsize', '256M',
  '-i', 'video=HP True Vision FHD Camera',
  '-pix_fmt', 'yuv420p',
  '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20',
  '-an', '-movflags', '+faststart', '-y', webcamFile
];

console.log('FFmpeg path:', FFMPEG);
console.log('Exists:', fs.existsSync(FFMPEG));
console.log('');
console.log('Screen command:');
console.log(FFMPEG, screenArgs.join(' '));
console.log('');
console.log('Webcam command:');
console.log(FFMPEG, webcamArgs.join(' '));
console.log('');

function spawnAndLog(label, args, outputFile) {
  return new Promise((resolve) => {
    console.log(`[${label}] Spawning...`);
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.stdout.on('data', (chunk) => {
      console.log(`[${label}] stdout:`, chunk.toString().trim());
    });

    proc.on('error', (e) => {
      console.error(`[${label}] SPAWN ERROR:`, e.message);
      resolve(false);
    });

    proc.on('close', (code) => {
      console.log(`[${label}] Exited with code: ${code}`);
      if (code !== 0) {
        // Print last 500 chars of stderr for errors
        const lastLines = stderr.slice(-800);
        console.log(`[${label}] STDERR (last 800 chars):\n${lastLines}`);
      }
      const exists = fs.existsSync(outputFile);
      const size = exists ? fs.statSync(outputFile).size : 0;
      console.log(`[${label}] Output file: ${exists ? `${size} bytes` : 'NOT CREATED'}`);
      resolve(code === 0);
    });

    // Record for 5 seconds then stop
    setTimeout(() => {
      console.log(`[${label}] Sending 'q' to stop...`);
      try {
        proc.stdin.write('q');
      } catch (e) {
        console.log(`[${label}] stdin.write failed: ${e.message}`);
        proc.kill();
      }
    }, 5000);
  });
}

async function main() {
  console.log('=== Starting screen recording test ===');
  const screenOk = await spawnAndLog('SCREEN', screenArgs, screenFile);
  console.log('');

  console.log('=== Starting webcam recording test ===');
  const webcamOk = await spawnAndLog('WEBCAM', webcamArgs, webcamFile);
  console.log('');

  console.log('=== RESULTS ===');
  console.log('Screen:', screenOk ? 'OK' : 'FAILED');
  console.log('Webcam:', webcamOk ? 'OK' : 'FAILED');
}

main();
