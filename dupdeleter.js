/*
Photo Deduplicator & Management Tool
*/

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { execSync } = require('child_process');
const os = require('os');
const exifr = require('exifr');
const Jimp = require('jimp');

const PORT = 3255;


const pickFolder = () => {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Select your photo folder'",
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
  ].join('; ');
  return execSync(`powershell -NoProfile -STA -Command "${ps}"`, { encoding: 'utf8' }).trim();
};

const PHOTO_DIR = process.argv[2] || pickFolder();
if (!PHOTO_DIR) {
  console.error('No folder selected. Usage: node dupdeleter.js "C:\\path\\to\\photos"');
  process.exit(1);
}

const SUPPORTED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.raw', '.arw', '.cr2', '.nef', '.orf', '.sr2'
];
const BROWSER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const PREVIEW_EXTENSIONS = new Set(['.heic', '.heif', '.raw', '.arw', '.cr2', '.nef', '.orf', '.sr2']);
const THUMB_CACHE_DIR = path.join(os.tmpdir(), 'dupdeleter-thumbs');
const DUP_WINDOW_SECONDS = 10;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Helper Functions ---

const photoId = (relPath) => Buffer.from(relPath, 'utf8').toString('base64url');
const decodePhotoId = (id) => Buffer.from(id, 'base64url').toString('utf8');

const safePhotoPath = (relPath) => {
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullP = path.resolve(PHOTO_DIR, normalized);
  const root = path.resolve(PHOTO_DIR);
  if (fullP !== root && !fullP.startsWith(root + path.sep)) return null;
  return fullP;
};

const thumbCachePath = (filePath) => {
  const key = Buffer.from(filePath).toString('base64url');
  return path.join(THUMB_CACHE_DIR, `${key}-v3.jpg`);
};

const PREVIEW_MIN_PX = 2800;

const upscalePreview = async (preview) => {
  try {
    const img = await Jimp.read(preview);
    const w = img.bitmap.width;
    const h = img.bitmap.height;
    const scale = Math.max(PREVIEW_MIN_PX / w, PREVIEW_MIN_PX / h, 1);
    if (scale > 1) img.scale(scale);
    return img.getBufferAsync(Jimp.MIME_JPEG);
  } catch {
    return preview;
  }
};

const getHeicPreview = async (filePath) => {
  const convertHeic = require('heic-convert');
  const input = await fs.readFile(filePath);
  const output = await convertHeic({
    buffer: input,
    format: 'JPEG',
    quality: 0.92,
  });
  return Buffer.from(output);
};

const getPreviewBuffer = async (filePath) => {
  const cached = thumbCachePath(filePath);
  try {
    return await fs.readFile(cached);
  } catch {}

  const ext = path.extname(filePath).toLowerCase();
  let preview = null;

  try {
    preview = await exifr.thumbnail(filePath);
  } catch {}

  if (!preview && (ext === '.heic' || ext === '.heif')) {
    try {
      preview = await getHeicPreview(filePath);
    } catch {}
  }

  if (!preview) return null;

  preview = await upscalePreview(preview);

  await fs.mkdir(THUMB_CACHE_DIR, { recursive: true });
  await fs.writeFile(cached, preview);
  return preview;
};

const getPhotoTimestamp = async (filePath) => {
  try {
    const data = await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTime'],
      reviveValues: true,
    });
    const taken = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate || data?.DateTime;
    if (taken instanceof Date && !Number.isNaN(+taken)) return +taken;
  } catch {}

  try {
    return +(await fs.stat(filePath)).mtime;
  } catch {
    return Date.now();
  }
};

const walkPhotos = async (dir, root, results = []) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkPhotos(fullPath, root, results);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

    const time = await getPhotoTimestamp(fullPath);
    results.push({
      name: entry.name,
      relPath: path.relative(root, fullPath).split(path.sep).join('/'),
      path: fullPath,
      time,
    });
  }
  return results;
};

const scanPhotos = async () => {
  const photos = await walkPhotos(PHOTO_DIR, PHOTO_DIR);
  photos.sort((a, b) => a.time - b.time || a.relPath.localeCompare(b.relPath));
  return photos;
};

const markDuplicateCandidates = (photos) => {
  const dupSet = new Set();
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      if (photos[j].time - photos[i].time > DUP_WINDOW_SECONDS * 1000) break;
      dupSet.add(photos[i].relPath);
      dupSet.add(photos[j].relPath);
    }
  }
  return dupSet;
};

const servePhoto = async (relPath, res) => {
  const fullP = safePhotoPath(relPath);
  if (!fullP) return res.status(403).send('Forbidden');

  const ext = path.extname(fullP).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return res.status(400).send('Not an image');
  }

  try {
    await fs.access(fullP);
  } catch {
    return res.status(404).send('Not found');
  }

  if (BROWSER_EXTENSIONS.has(ext)) {
    return res.sendFile(fullP);
  }

  if (PREVIEW_EXTENSIONS.has(ext)) {
    try {
      const preview = await getPreviewBuffer(fullP);
      if (preview) {
        res.set('Content-Type', 'image/jpeg');
        return res.send(preview);
      }
    } catch {}
  }

  res.set('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
    <rect width="100%" height="100%" fill="#222"/>
    <text x="50%" y="45%" text-anchor="middle" font-size="24" fill="#aaa">No preview</text>
    <text x="50%" y="55%" text-anchor="middle" font-size="18" fill="#666">${ext.slice(1).toUpperCase()}</text>
  </svg>`);
};

// --- Routes ---

app.get('/', async (req, res) => {
  const photos = await scanPhotos();
  const dupSet = markDuplicateCandidates(photos);
  const startIndex = Math.max(0, Math.min(parseInt(req.query.i, 10) || 0, Math.max(0, photos.length - 1)));

  const photosJson = JSON.stringify(photos.map(p => ({
    id: photoId(p.relPath),
    relPath: p.relPath,
    name: p.name,
    time: p.time,
    isDup: dupSet.has(p.relPath),
  })));

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Photo Manager</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: system-ui, sans-serif;
      background: #000;
      color: #eee;
    }
    .viewer {
      position: fixed;
      inset: 0;
    }
    #photo-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #000;
    }
    #photo {
      width: 100vw;
      height: 100vh;
      object-fit: contain;
      display: block;
    }
    .overlay {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 8px 14px;
      background: linear-gradient(transparent, rgba(0,0,0,0.85));
      font-size: 0.8rem;
      line-height: 1.35;
      pointer-events: none;
    }
    .overlay .count { font-size: 0.95rem; font-weight: 600; }
    .overlay .path { color: #aaa; word-break: break-all; }
    .dup-badge {
      display: none;
      color: #ffb84d;
    }
    .dup-badge.show { display: inline; }
    .hint {
      position: fixed;
      top: 8px;
      right: 10px;
      color: rgba(255,255,255,0.35);
      font-size: 0.75rem;
      pointer-events: none;
    }
    .empty {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #888;
      text-align: center;
      padding: 20px;
    }
  </style>
</head>
<body>
  <div id="app" class="viewer"></div>

  <script>
    const photos = ${photosJson};
    let index = ${startIndex};

    const app = document.getElementById('app');

    function formatDate(ms) {
      return new Date(ms).toLocaleString();
    }

    function render() {
      if (photos.length === 0) {
        app.innerHTML = '<div class="empty">No photos found in this folder.<br>Supported: JPG, PNG, HEIC, ARW, and other RAW formats.</div>';
        return;
      }

      const p = photos[index];
      app.innerHTML = \`
        <div id="photo-wrap">
          <img id="photo" src="/photo/\${p.id}" alt="\${p.name}">
        </div>
        <div class="overlay">
          <div class="count">\${index + 1} / \${photos.length} · \${p.name}</div>
          <div>\${formatDate(p.time)}</div>
          <div class="path">\${p.relPath}</div>
          <div class="dup-badge \${p.isDup ? 'show' : ''}"> · possible duplicate</div>
        </div>
        <div class="hint">← → browse · ↓ delete</div>
      \`;
    }

    function go(delta) {
      const next = index + delta;
      if (next < 0 || next >= photos.length) return;
      index = next;
      history.replaceState(null, '', '?i=' + index);
      render();
    }

    async function deleteCurrent(skipConfirm) {
      const p = photos[index];
      if (!skipConfirm && !confirm('Delete "' + p.name + '"? This cannot be undone.')) return;

      const res = await fetch('/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relPath: p.relPath }),
      });

      if (!res.ok) {
        const msg = await res.text();
        console.error('Delete failed:', res.status, msg);
        alert('Could not delete: ' + msg); // remove skipConfirm gate so you actually see it
        return;
      }

      photos.splice(index, 1);
      if (index >= photos.length) index = Math.max(0, photos.length - 1);
      history.replaceState(null, '', photos.length ? '?i=' + index : '/');
      render();
    }

    document.addEventListener('keydown', (e) => {
      if (photos.length === 0) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); deleteCurrent(true); }
    });

    render();
  </script>
</body>
</html>`);
});

app.get('/photo/:id', async (req, res) => {
  const relPath = decodePhotoId(req.params.id);
  await servePhoto(relPath, res);
});

app.post('/delete', async (req, res) => {
  const relPath = req.body.relPath;
  if (!relPath) return res.status(400).send('Missing path');

  const fullP = safePhotoPath(relPath);
  if (!fullP) {
    console.error('Delete blocked (403):', relPath);
    return res.status(403).send('Forbidden');
  }
  if (!SUPPORTED_EXTENSIONS.includes(path.extname(fullP).toLowerCase())) {
    return res.status(400).send('Not an image');
  }

  console.log('Attempting delete:', fullP);
  try {
    await fs.unlink(fullP);
    console.log('Deleted:', fullP);
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete FAILED:', fullP, err.code, err.message);
    res.status(500).send(err.code || 'Delete failed');
  }
});

app.listen(PORT, async () => {
  try {
    await fs.access(PHOTO_DIR);
  } catch {
    console.error(`Folder not found: ${PHOTO_DIR}`);
    process.exit(1);
  }
  console.log(`Photo viewer running at http://localhost:${PORT}`);
  console.log(`Scanning folder (recursive): ${PHOTO_DIR}`);
});


