const express = require('express');
const multer = require('multer');
const ws = require('ws');
const archiver = require('archiver');
const mime = require('mime-types');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

const PORT = process.env.PORT || 3000;
let isHostProcess = false; // set to true when this process IS the host server

// Determine paths dynamically for Electron or packaged CLI environments
let ROOT_DIR = __dirname;
try {
  const { app: electronApp } = require('electron');
  if (electronApp && electronApp.isPackaged) {
    ROOT_DIR = path.resolve(process.resourcesPath, '..');
  }
} catch (e) {
  const isPackaged = typeof process.pkg !== 'undefined';
  ROOT_DIR = isPackaged ? path.dirname(process.execPath) : __dirname;
}

const SHARED_DIR = path.resolve(ROOT_DIR, 'shared_files');
const COMMENTS_FILE = path.resolve(ROOT_DIR, 'comments.json');
const TEMP_UPLOAD_DIR = path.resolve(ROOT_DIR, 'temp_uploads');
const METADATA_FILE = path.resolve(ROOT_DIR, 'metadata.json');


// Ensure directories and data files exist
if (!fs.existsSync(SHARED_DIR)) {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
  fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(COMMENTS_FILE)) {
  fs.writeFileSync(COMMENTS_FILE, '[]', 'utf8');
}
if (!fs.existsSync(METADATA_FILE)) {
  fs.writeFileSync(METADATA_FILE, '{}', 'utf8');
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for temp uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    // Save with a unique name to avoid conflicts in temp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Helper: Safely resolve and check path inside SHARED_DIR
function getSafePath(relativePath) {
  if (!relativePath) return SHARED_DIR;
  const resolved = path.resolve(SHARED_DIR, relativePath);
  if (!resolved.startsWith(SHARED_DIR)) {
    throw new Error('Access Denied: Path traversal detected.');
  }
  return resolved;
}

// Helper: Read comments
function readComments() {
  try {
    if (fs.existsSync(COMMENTS_FILE)) {
      const data = fs.readFileSync(COMMENTS_FILE, 'utf8');
      return JSON.parse(data || '[]');
    }
  } catch (err) {
    console.error('Error reading comments:', err);
  }
  return [];
}

// Helper: Save comments
function saveComments(comments) {
  try {
    fs.writeFileSync(COMMENTS_FILE, JSON.stringify(comments, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving comments:', err);
  }
}

// Helper: Read metadata
function readMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = fs.readFileSync(METADATA_FILE, 'utf8');
      return JSON.parse(data || '{}');
    }
  } catch (err) {
    console.error('Error reading metadata:', err);
  }
  return {};
}

// Helper: Save metadata
function saveMetadata(metadata) {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving metadata:', err);
  }
}

// Broadcast to all WS clients
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === ws.OPEN) {
      client.send(payload);
    }
  });
}

// Helper: recursively list all files in a directory as a flat manifest
function buildSyncManifest(dir, baseDir) {
  const manifest = [];
  if (!fs.existsSync(dir)) return manifest;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      const children = buildSyncManifest(fullPath, baseDir);
      manifest.push(...children);
    } else {
      manifest.push({
        path: relPath,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      });
    }
  }
  return manifest;
}

// Get file list for a directory
app.get('/api/files', (req, res) => {
  try {
    const relativePath = req.query.path || '';
    const targetDir = getSafePath(relativePath);

    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Target is not a directory' });
    }

    const items = fs.readdirSync(targetDir);
    const metadata = readMetadata();
    const result = items.map((item) => {
      const fullPath = path.join(targetDir, item);
      const itemStat = fs.statSync(fullPath);
      const isDir = itemStat.isDirectory();
      const relPath = path.relative(SHARED_DIR, fullPath).replace(/\\/g, '/');
      const meta = metadata[relPath] || {};

      return {
        name: item,
        path: relPath,
        type: isDir ? 'directory' : 'file',
        size: isDir ? 0 : itemStat.size,
        mime: isDir ? null : (mime.lookup(fullPath) || 'application/octet-stream'),
        updatedAt: itemStat.mtime,
        uploadedBy: meta.uploadedBy || 'System',
        uploadedAt: meta.uploadedAt || itemStat.mtime.toISOString()
      };
    });

    // Sort: directories first, then files alphabetically
    result.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    res.json({ files: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync manifest - returns flat list of all files for auto-download
app.get('/api/sync', (req, res) => {
  try {
    const manifest = buildSyncManifest(SHARED_DIR, SHARED_DIR);
    res.json({ files: manifest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Is-host endpoint - guests use this to know if auto-sync should happen
app.get('/api/ishost', (req, res) => {
  res.json({ isHost: isHostProcess });
});

// Handle multiple file & folder uploads
app.post('/api/upload', upload.array('files'), (req, res) => {
  try {
    const destPath = req.body.destPath || '';
    const targetDir = getSafePath(destPath);

    // Relative paths mapped to each file (sent by client)
    let paths = req.body.paths || [];
    if (typeof paths === 'string') {
      paths = [paths];
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedDetails = [];

    files.forEach((file, index) => {
      // Determine relative destination path
      // If client sent relative path, use it. Otherwise, use the file originalname.
      const relFilePath = paths[index] || file.originalname;

      const finalFullPath = path.resolve(targetDir, relFilePath);

      // Ensure we don't write outside the SHARED_DIR
      if (!finalFullPath.startsWith(SHARED_DIR)) {
        throw new Error('Access Denied: Invalid file destination path.');
      }

      // Create directories if they don't exist
      const parentDir = path.dirname(finalFullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Rename/move file from temp to final destination
      fs.renameSync(file.path, finalFullPath);

      uploadedDetails.push({
        name: path.basename(finalFullPath),
        path: path.relative(SHARED_DIR, finalFullPath).replace(/\\/g, '/')
      });
    });

    // Save uploaded files metadata
    const uploadByNick = req.body.nickname || 'System';
    const metadata = readMetadata();
    uploadedDetails.forEach(detail => {
      metadata[detail.path] = {
        uploadedBy: uploadByNick,
        uploadedAt: new Date().toISOString()
      };
    });
    saveMetadata(metadata);

    // Clean up empty files in temp dir if any left
    fs.readdir(TEMP_UPLOAD_DIR, (err, tempFiles) => {
      if (!err) {
        tempFiles.forEach(file => {
          const fp = path.join(TEMP_UPLOAD_DIR, file);
          fs.stat(fp, (err, stats) => {
            if (!err && stats.isFile()) {
              // Delete old temp files (older than 1 hour)
              if (Date.now() - stats.mtimeMs > 3600000) {
                fs.unlink(fp, () => { });
              }
            }
          });
        });
      }
    });

    // Add upload comments to chat dynamically
    const comments = readComments();
    const nickname = req.body.nickname || 'System';
    const uploadMsg = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      user: nickname,
      text: files.length === 1
        ? `shared a file: "${uploadedDetails[0].name}"`
        : `shared ${files.length} items to "${destPath || 'Root'}"`,
      timestamp: new Date().toISOString(),
      type: 'notification'
    };
    comments.push(uploadMsg);
    saveComments(comments);
    broadcast(uploadMsg);

    // Broadcast individual file_added events for auto-sync on guest clients
    uploadedDetails.forEach(detail => {
      const fullPath = path.join(SHARED_DIR, detail.path);
      let fileSize = 0;
      try { fileSize = fs.statSync(fullPath).size; } catch(e) {}
      broadcast({
        type: 'file_added',
        path: detail.path,
        name: detail.name,
        size: fileSize
      });
    });

    res.json({ success: true, files: uploadedDetails });
  } catch (err) {
    // Attempt clean up of any uploaded temp files in this request
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// Create empty folder
app.post('/api/create-folder', (req, res) => {
  try {
    const { name, parentPath } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const parentDir = getSafePath(parentPath || '');
    const newFolderFullPath = path.resolve(parentDir, name);

    if (!newFolderFullPath.startsWith(SHARED_DIR)) {
      throw new Error('Access Denied: Path traversal detected.');
    }

    if (fs.existsSync(newFolderFullPath)) {
      return res.status(400).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(newFolderFullPath, { recursive: true });

    // Save folder metadata
    const relFolderPath = path.relative(SHARED_DIR, newFolderFullPath).replace(/\\/g, '/');
    const metadata = readMetadata();
    metadata[relFolderPath] = {
      uploadedBy: req.body.nickname || 'System',
      uploadedAt: new Date().toISOString()
    };
    saveMetadata(metadata);

    // Post to chat
    const comments = readComments();
    const nickname = req.body.nickname || 'System';
    const newFolderMsg = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      user: nickname,
      text: `created a folder: "${name}"`,
      timestamp: new Date().toISOString(),
      type: 'notification'
    };
    comments.push(newFolderMsg);
    saveComments(comments);
    broadcast(newFolderMsg);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download a file or folder (zipped)
app.get('/api/download', (req, res) => {
  try {
    const relativePath = req.query.path || '';
    const fullPath = getSafePath(relativePath);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('File or folder not found');
    }

    const stat = fs.statSync(fullPath);
    const name = path.basename(fullPath);

    if (stat.isFile()) {
      res.download(fullPath, name);
    } else if (stat.isDirectory()) {
      // Dynamic ZIP of folder
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
      });

      archive.pipe(res);
      archive.directory(fullPath, false); // Add folder contents directly
      archive.finalize();
    }
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Delete file or folder
app.delete('/api/delete', (req, res) => {
  try {
    const relativePath = req.body.path || '';
    if (!relativePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const fullPath = getSafePath(relativePath);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const name = path.basename(fullPath);
    const isDir = fs.statSync(fullPath).isDirectory();

    // Delete
    fs.rmSync(fullPath, { recursive: true, force: true });

    // Remove metadata
    try {
      const relPath = relativePath.replace(/\\/g, '/');
      const metadata = readMetadata();
      delete metadata[relPath];
      // Also delete sub-paths
      for (const key in metadata) {
        if (key.startsWith(relPath + '/')) {
          delete metadata[key];
        }
      }
      saveMetadata(metadata);
    } catch (e) {
      console.error('Error removing file metadata:', e);
    }

    // Post to chat
    const comments = readComments();
    const nickname = req.body.nickname || 'System';
    const deleteMsg = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      user: nickname,
      text: `deleted ${isDir ? 'folder' : 'file'}: "${name}"`,
      timestamp: new Date().toISOString(),
      type: 'notification'
    };
    comments.push(deleteMsg);
    saveComments(comments);
    broadcast(deleteMsg);

    // Also broadcast file_deleted event
    broadcast({
      type: 'file_deleted',
      path: relativePath.replace(/\\/g, '/')
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get comment history
app.get('/api/comments', (req, res) => {
  try {
    const comments = readComments();
    res.json(comments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket Server Handler
wss.on('connection', (wsConn) => {
  console.log('New client connected to real-time chat');

  wsConn.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'comment') {
        const comments = readComments();
        const newComment = {
          id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
          user: data.user || 'Anonymous',
          text: data.text,
          timestamp: new Date().toISOString(),
          type: 'comment',
          taggedFile: data.taggedFile || null
        };
        comments.push(newComment);
        saveComments(comments);
        broadcast(newComment);
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  wsConn.on('close', () => {
    console.log('Client disconnected');
  });
});

// Mark this process as the host
isHostProcess = true;

// Start Server and log all local network IP addresses
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`🚀 Folder Sharing Server started successfully!`);
  console.log(`=================================================`);
  console.log(`Local Access:   http://localhost:${PORT}`);

  // Find local IP addresses
  const interfaces = os.networkInterfaces();
  for (const interfaceName in interfaces) {
    for (const iface of interfaces[interfaceName]) {
      // Look for IPv4 non-internal addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`Network Access: http://${iface.address}:${PORT}`);
      }
    }
  }
  console.log(`=================================================`);
});

// UDP discovery responder
const dgram = require('dgram');
const udpSocket = dgram.createSocket('udp4');

udpSocket.on('message', (msg, rinfo) => {
  if (msg.toString() === 'AIRBRIDGE_DISCOVER') {
    // Find the primary IP address to respond with
    let localIp = 'localhost';
    const interfaces = os.networkInterfaces();
    for (const interfaceName in interfaces) {
      for (const iface of interfaces[interfaceName]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
      if (localIp !== 'localhost') break;
    }

    const responseMsg = `AIRBRIDGE_HOST|http://${localIp}:${PORT}`;
    udpSocket.send(responseMsg, rinfo.port, rinfo.address, (err) => {
      if (err) console.error('Error sending UDP discovery response:', err);
    });
  }
});

udpSocket.on('error', (err) => {
  console.error('UDP socket error:', err.message);
});

// Bind to UDP port 3001 on all interfaces
udpSocket.bind(3001, '0.0.0.0', () => {
  try {
    udpSocket.setBroadcast(true);
  } catch (e) { }
  console.log('📡 UDP discovery service listening on port 3001');
});
