/**
 * Deploy site/ folder to Netlify via API
 * Usage: node site/deploy.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const NETLIFY_TOKEN = 'nfp_2r8NMnaW5BxpaWHWXXu6ZbePvQAQjqkp682b';
const SITE_NAME = 'screen-recorder-app';
const SITE_DIR = path.join(__dirname);

// ── Helpers ──

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.netlify.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/json',
      },
    };

    if (body && typeof body !== 'string') {
      body = JSON.stringify(body);
    }
    if (body && typeof body === 'string' && opts.headers['Content-Type'] === 'application/json') {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function uploadFile(urlPath, fileBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.netlify.com',
      path: urlPath,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': contentType,
        'Content-Length': fileBuffer.length,
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain',
  };
  return types[ext] || 'application/octet-stream';
}

function collectFiles(dir, base = dir) {
  const files = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === 'deploy.js') continue; // skip this script
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      Object.assign(files, collectFiles(fullPath, base));
    } else {
      const relativePath = '/' + path.relative(base, fullPath).replace(/\\/g, '/');
      const content = fs.readFileSync(fullPath);
      files[relativePath] = { content, sha1: sha1(content), contentType: getContentType(fullPath) };
    }
  }
  return files;
}

// ── Main ──

async function main() {
  console.log('Collecting site files...');
  const files = collectFiles(SITE_DIR);
  console.log(`Found ${Object.keys(files).length} files:`);
  for (const f of Object.keys(files)) console.log(`  ${f}`);

  // Check if site exists
  console.log(`\nLooking for existing site "${SITE_NAME}"...`);
  let siteId;
  const listRes = await request('GET', `/api/v1/sites?filter=all&name=${SITE_NAME}`);
  const existing = Array.isArray(listRes.data) && listRes.data.find(s => s.name === SITE_NAME);

  if (existing) {
    siteId = existing.id;
    console.log(`Found existing site: ${siteId} (${existing.ssl_url || existing.url})`);
  } else {
    console.log('Site not found, creating...');
    const createRes = await request('POST', '/api/v1/sites', { name: SITE_NAME });
    if (createRes.status >= 400) {
      console.error('Failed to create site:', createRes.data);
      process.exit(1);
    }
    siteId = createRes.data.id;
    console.log(`Created site: ${siteId} (${createRes.data.ssl_url || createRes.data.url})`);
  }

  // Create deploy with file digests
  console.log('\nCreating deploy...');
  const fileDigests = {};
  for (const [filePath, info] of Object.entries(files)) {
    fileDigests[filePath] = info.sha1;
  }

  const deployRes = await request('POST', `/api/v1/sites/${siteId}/deploys`, {
    files: fileDigests,
  });

  if (deployRes.status >= 400) {
    console.error('Failed to create deploy:', deployRes.data);
    process.exit(1);
  }

  const deployId = deployRes.data.id;
  const required = deployRes.data.required || [];
  console.log(`Deploy ${deployId} created. ${required.length} files need uploading.`);

  // Upload required files
  for (const [filePath, info] of Object.entries(files)) {
    if (required.length === 0 || required.includes(info.sha1)) {
      process.stdout.write(`  Uploading ${filePath}...`);
      const uploadRes = await uploadFile(
        `/api/v1/deploys/${deployId}/files${filePath}`,
        info.content,
        info.contentType
      );
      console.log(uploadRes.status < 400 ? ' OK' : ` FAILED (${uploadRes.status})`);
    }
  }

  // Final status
  const statusRes = await request('GET', `/api/v1/deploys/${deployId}`);
  const url = statusRes.data.ssl_url || statusRes.data.url || `https://${SITE_NAME}.netlify.app`;
  console.log(`\nDeploy complete!`);
  console.log(`Live at: ${url}`);
}

main().catch((err) => {
  console.error('Deploy failed:', err);
  process.exit(1);
});
