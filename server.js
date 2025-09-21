// server.js — unified backend with external-download proxy
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const streamifier = require('streamifier');
const { v2: cloudinary } = require('cloudinary');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const {
  MONGODB_URI,
  ADMIN_PASSWORD = 'letmein',
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  PORT = 3000
} = process.env;

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true
});

const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) app.use(express.static(publicPath));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 300 * 1024 * 1024 } });

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=> console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connect error:', err && err.message));

const fileSchema = new mongoose.Schema({
  originalName: String,
  filename: String,
  url: String,
  type: String,
  mimeType: String,
  size: Number,
  publicId: String,
  uploadedAt: { type: Date, default: Date.now },
});
const File = mongoose.models.File || mongoose.model('File', fileSchema);

const billboardSchema = new mongoose.Schema({
  message: String,
  updatedAt: { type: Date, default: Date.now }
});
const Billboard = mongoose.models.Billboard || mongoose.model('Billboard', billboardSchema);

const deviceLogSchema = new mongoose.Schema({
  name: String,
  normalizedName: String,
  timestamp: { type: Date, default: Date.now },
  ip: String,
  userAgent: String
});
const DeviceLog = mongoose.models.DeviceLog || mongoose.model('DeviceLog', deviceLogSchema);

function sendUnauthorized(res){ return res.status(403).json({ ok:false, error:'Unauthorized' }); }
function getAdminPassword(req) { return req.headers['x-admin-password'] || req.body.password || ''; }

async function probeUrlMetadata(url){
  try {
    const r = await axios.head(url, { timeout: 8000, maxRedirects: 5 });
    return { mimeType: r.headers['content-type'] || null, size: r.headers['content-length'] ? parseInt(r.headers['content-length'],10) : null };
  } catch(e){
    try {
      const r2 = await axios.get(url, { timeout: 8000, responseType: 'stream', headers: { Range: 'bytes=0-1023' }, maxRedirects: 5 });
      const ct = r2.headers['content-type'] || null;
      const cl = r2.headers['content-length'] ? parseInt(r2.headers['content-length'],10) : null;
      if (r2 && r2.data && typeof r2.data.destroy === 'function') r2.data.destroy();
      return { mimeType: ct, size: cl };
    } catch(e2){
      return { mimeType: null, size: null };
    }
  }
}

/* ========== API ========== */

app.get('/api/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/files', async (req, res) => {
  try {
    const files = await File.find({}).sort({ uploadedAt: -1 }).limit(1000).lean();
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.post('/api/file', async (req, res) => {
  try {
    const pw = getAdminPassword(req);
    if (!pw || pw !== ADMIN_PASSWORD) return res.status(403).json({ ok:false, error:'Unauthorized' });
    const { url, originalName, type, mimeType: bodyMime, size: bodySize, publicId } = req.body || {};
    if (!url) return res.status(400).json({ ok:false, error:'url is required' });

    let filename = originalName;
    if (!filename) {
      try { const u = new URL(url); filename = u.pathname.split('/').filter(Boolean).pop() || 'external'; } catch(e) { filename = 'external'; }
    }

    let mimeType = bodyMime || null;
    let size = bodySize || null;
    if (!mimeType || !size) {
      try {
        const meta = await probeUrlMetadata(url);
        if (!mimeType && meta.mimeType) mimeType = meta.mimeType;
        if (!size && meta.size) size = meta.size;
      } catch(e){}
    }

    const doc = await File.create({
      originalName: originalName || filename,
      filename,
      url,
      type: type || 'other',
      mimeType: mimeType || 'application/octet-stream',
      size: size || 0,
      publicId: publicId || null
    });

    return res.json({ ok:true, file: doc });
  } catch (err) {
    console.error('POST /api/file error', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);
    if (!req.file) return res.status(400).json({ ok:false, error:'No file provided' });

    const type = req.body.type || 'images';
    const folder = `privatesite/${type}`;
    const resourceType = (type === 'videos') ? 'video' : (type === 'pdfs' ? 'raw' : 'auto');

    const streamUpload = (buffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({
          folder,
          resource_type: resourceType,
          use_filename: true,
          unique_filename: true,
          overwrite: false
        }, (error, result) => {
          if (result) resolve(result);
          else reject(error);
        });
        streamifier.createReadStream(buffer).pipe(stream);
      });
    };

    const result = await streamUpload(req.file.buffer);
    const fileDoc = await File.create({
      originalName: req.file.originalname,
      filename: result.original_filename || result.public_id,
      url: result.secure_url,
      type,
      mimeType: req.file.mimetype,
      size: req.file.size,
      publicId: result.public_id,
    });

    res.json({
      ok:true, id:fileDoc._id, filename:fileDoc.filename, originalName:fileDoc.originalName, url:fileDoc.url, mimeType:fileDoc.mimeType, type:fileDoc.type, size:fileDoc.size
    });
  } catch (err) {
    console.error('POST /api/upload error', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.delete('/api/file/:id', async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);
    const id = req.params.id;
    const doc = await File.findById(id);
    if (!doc) return res.status(404).json({ ok:false, error:'Not found' });

    const resourceType = (doc.type === 'videos') ? 'video' : (doc.type === 'pdfs' ? 'raw' : 'image');
    try { if (doc.publicId) await cloudinary.uploader.destroy(doc.publicId, { resource_type: resourceType }); } catch(e){ console.warn('cloudinary destroy failed', e && e.message); }
    await doc.remove();
    res.json({ ok:true });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.patch('/api/file/:id', async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);
    const id = req.params.id;
    const update = {};
    if (req.body.originalName) update.originalName = String(req.body.originalName).trim();
    if (req.body.description) update.description = String(req.body.description).trim();
    if (Object.keys(update).length === 0) return res.status(400).json({ ok:false, error:'No data to update' });
    const doc = await File.findByIdAndUpdate(id, update, { new: true });
    if (!doc) return res.status(404).json({ ok:false, error:'Not found' });
    res.json({ ok:true, file: doc });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/download/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await File.findById(id);
    if (!doc) return res.status(404).send('Not found');

    const r = await axios.get(doc.url, { responseType: 'stream', timeout: 20000 });
    const filename = doc.originalName || doc.filename || 'download';
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g,'')}"`);
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    r.data.pipe(res);
  } catch (err) {
    console.error('Download error', err && err.message);
    res.status(500).send('Download failed');
  }
});

/**
 * NEW: GET /api/external-download?url=<encoded-url>
 * Streams any http/https URL back to client with Content-Disposition attachment.
 * This avoids Google Drive opening preview pages and forces a download via the proxy.
 * WARNING: This is effectively a proxy. Consider restricting hosts in production.
 */
app.get('/api/external-download', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('url required');
    // basic validation: must be http(s)
    if (!/^https?:\/\//i.test(url)) return res.status(400).send('invalid url');

    // Use axios stream; timeouts/redirects configured
    const r = await axios.get(url, { responseType: 'stream', timeout: 20000, maxRedirects: 5 });

    // attempt to derive filename
    let filename = 'download';
    const cd = r.headers['content-disposition'];
    if (cd) {
      const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)["']?/i);
      if (m && m[1]) filename = decodeURIComponent(m[1]);
    } else {
      try {
        const u = new URL(url);
        const last = (u.pathname.split('/').filter(Boolean).pop() || '').trim();
        if (last) filename = last;
      } catch(e){}
    }

    // set headers for attachment
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g,'')}"`);
    res.setHeader('Content-Type', r.headers['content-type'] || 'application/octet-stream');

    // stream and pipe
    r.data.pipe(res);

    // handle stream errors
    r.data.on('error', (err)=> {
      console.warn('external-download stream error', err && err.message);
      try { res.end(); } catch(e){}
    });
  } catch (err) {
    console.error('external-download failed', err && err.message);
    res.status(500).send('External download failed');
  }
});

app.post('/api/log', async (req, res) => {
  try {
    const { name, normalizedName } = req.body || {};
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    const doc = await DeviceLog.create({ name, normalizedName, ip, userAgent: ua });
    res.json({ ok:true, id: doc._id });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);
    const logs = await DeviceLog.find({}).sort({ timestamp: -1 }).limit(1000).lean();
    res.json({ ok:true, logs });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/api/billboard', async (req, res) => {
  try {
    const doc = await Billboard.findOne({}).sort({ updatedAt: -1 }).lean();
    res.json({ ok:true, billboard: doc || null });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

app.post('/api/billboard', async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ ok:false, error:'message required' });
    let doc = await Billboard.findOne({});
    if (!doc) doc = await Billboard.create({ message });
    else { doc.message = message; doc.updatedAt = new Date(); await doc.save(); }
    res.json({ ok:true, billboard: doc });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

app.delete('/api/billboard', async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);
    await Billboard.deleteMany({});
    res.json({ ok:true });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

app.post('/api/reset', async (req, res) => {
  try {
    const password = getAdminPassword(req);
    if (password !== ADMIN_PASSWORD) return sendUnauthorized(res);

    const files = await File.find({}).lean();
    for (const f of files) {
      try {
        const resourceType = (f.type === 'videos') ? 'video' : (f.type === 'pdfs' ? 'raw' : 'image');
        if (f.publicId) await cloudinary.uploader.destroy(f.publicId, { resource_type: resourceType });
      } catch (err) {
        console.warn('Failed delete asset', f.publicId, err && err.message);
      }
    }

    await File.deleteMany({});
    await DeviceLog.deleteMany({});
    await Billboard.deleteMany({});
    res.json({ ok:true });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.get('/', (req,res)=> {
  const index = path.join(publicPath, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('index not found');
});
app.get('/admin.html', (req,res)=> {
  const adm = path.join(publicPath, 'admin.html');
  if (fs.existsSync(adm)) return res.sendFile(adm);
  res.status(404).send('admin not found');
});

app.get('*', (req,res,next)=> {
  if (req.path.startsWith('/api/')) return next();
  const index = path.join(publicPath, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('not found');
});

app.listen(PORT, ()=> console.log(`Server listening on http://localhost:${PORT}`));
