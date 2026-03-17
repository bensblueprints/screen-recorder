/**
 * Build script for Screen Recorder Electron app
 * Usage: node build.js
 *
 * Prerequisites:
 *   npm install --save-dev electron-builder
 *
 * What this does:
 *   1. Copies icon.svg into the build staging area
 *   2. Runs electron-builder for Windows (NSIS installer)
 *
 * Note: electron-builder requires icon.ico for Windows builds.
 * If you only have icon.svg, you'll need to convert it first.
 * You can use an online converter or install sharp/svg2img.
 * The build config in package.json already references icon.ico for Windows
 * and icon.icns for Mac.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function log(msg) {
  console.log(`[build] ${msg}`);
}

// ── Step 1: Verify icon exists ──
const svgPath = path.join(ROOT, 'icon.svg');
if (!fs.existsSync(svgPath)) {
  console.error('[build] ERROR: icon.svg not found in project root');
  process.exit(1);
}
log('icon.svg found');

// Copy SVG to public/ for renderer access
const publicDir = path.join(ROOT, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
fs.copyFileSync(svgPath, path.join(publicDir, 'icon.svg'));
log('Copied icon.svg to public/');

// ── Step 2: Check for ICO (Windows needs .ico) ──
const icoPath = path.join(ROOT, 'icon.ico');
if (!fs.existsSync(icoPath)) {
  log('WARNING: icon.ico not found. Windows build requires .ico format.');
  log('Convert icon.svg to icon.ico (256x256) before building.');
  log('Online tool: https://convertio.co/svg-ico/');
  log('Or install sharp: npm i sharp && node -e "require(\'sharp\')(\'icon.svg\').resize(256,256).toFile(\'icon.ico\')"');
  log('');
  log('Continuing build attempt anyway...');
}

// ── Step 3: Run electron-builder ──
log('Running electron-builder for Windows...');
try {
  execSync('npx electron-builder --win', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });
  log('Build complete! Check the dist/ folder.');
} catch (err) {
  console.error('[build] electron-builder failed. See output above.');
  process.exit(1);
}
