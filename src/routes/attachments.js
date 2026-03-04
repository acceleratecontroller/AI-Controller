const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('../models/database');
const sharepoint = require('../services/sharepoint');

const router = express.Router();

// Storage config — each job gets its own folder
const ATTACHMENTS_DIR = path.join(__dirname, '..', '..', 'attachments');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobDir = path.join(ATTACHMENTS_DIR, `job-${req.params.jobId}`);
    fs.mkdirSync(jobDir, { recursive: true });
    cb(null, jobDir);
  },
  filename: (req, file, cb) => {
    // Unique name to avoid collisions, preserve extension
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .substring(0, 100);
    const unique = crypto.randomBytes(6).toString('hex');
    cb(null, `${base}_${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

// GET /api/jobs/:jobId/attachments — list attachments for a job
router.get('/:jobId/attachments', (req, res) => {
  const db = getDb();
  const attachments = db.prepare(
    'SELECT * FROM attachments WHERE job_id = ? ORDER BY created_at DESC'
  ).all(req.params.jobId);

  res.json(attachments);
});

// POST /api/jobs/:jobId/attachments — upload one or more files
router.post('/:jobId/attachments', upload.array('files', 20), async (req, res) => {
  const db = getDb();
  const jobId = req.params.jobId;

  // Verify job exists
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) {
    // Clean up uploaded files
    (req.files || []).forEach(f => fs.unlinkSync(f.path));
    return res.status(404).json({ error: 'Job not found' });
  }

  const insertStmt = db.prepare(`
    INSERT INTO attachments (job_id, original_name, stored_name, file_path, file_size, mime_type, source, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const historyStmt = db.prepare(`
    INSERT INTO job_history (job_id, action, changed_by, details)
    VALUES (?, 'attachment_added', ?, ?)
  `);

  const source = req.body.source || 'upload';
  const uploadedBy = req.body.uploaded_by || 'user';
  const saved = [];

  const insertMany = db.transaction((files) => {
    for (const file of files) {
      const result = insertStmt.run(
        jobId,
        file.originalname,
        file.filename,
        file.path,
        file.size,
        file.mimetype,
        source,
        uploadedBy
      );

      historyStmt.run(
        jobId,
        uploadedBy,
        `Attached file: ${file.originalname} (${formatSize(file.size)})`
      );

      saved.push({
        id: result.lastInsertRowid,
        original_name: file.originalname,
        stored_name: file.filename,
        file_size: file.size,
        mime_type: file.mimetype,
        source
      });
    }
  });

  insertMany(req.files || []);

  // Sync to SharePoint in the background (non-blocking)
  if (sharepoint.isConfigured()) {
    sharepoint.syncJobAttachments(jobId, job.job_number).catch(err => {
      console.error(`SharePoint sync failed for job ${jobId}:`, err.message);
    });
  }

  res.json({ uploaded: saved.length, attachments: saved });
});

// GET /api/jobs/:jobId/attachments/:attachmentId/download — download a file
router.get('/:jobId/attachments/:attachmentId/download', (req, res) => {
  const db = getDb();
  const attachment = db.prepare(
    'SELECT * FROM attachments WHERE id = ? AND job_id = ?'
  ).get(req.params.attachmentId, req.params.jobId);

  if (!attachment) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  if (!fs.existsSync(attachment.file_path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.download(attachment.file_path, attachment.original_name);
});

// DELETE /api/jobs/:jobId/attachments/:attachmentId — remove an attachment
router.delete('/:jobId/attachments/:attachmentId', (req, res) => {
  const db = getDb();
  const attachment = db.prepare(
    'SELECT * FROM attachments WHERE id = ? AND job_id = ?'
  ).get(req.params.attachmentId, req.params.jobId);

  if (!attachment) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  // Delete file from disk
  if (fs.existsSync(attachment.file_path)) {
    fs.unlinkSync(attachment.file_path);
  }

  // Delete DB record
  db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id);

  // Log history
  db.prepare(
    "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'attachment_removed', 'user', ?)"
  ).run(req.params.jobId, `Removed file: ${attachment.original_name}`);

  res.json({ success: true });
});

// POST /api/jobs/:jobId/attachments/sync-sharepoint — manually trigger SharePoint sync
router.post('/:jobId/attachments/sync-sharepoint', async (req, res) => {
  if (!sharepoint.isConfigured()) {
    return res.status(400).json({ error: 'SharePoint is not configured. Set SHAREPOINT_* environment variables.' });
  }

  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  try {
    const results = await sharepoint.syncJobAttachments(req.params.jobId, job.job_number);
    res.json({ success: true, synced: results.synced, errors: results.errors });
  } catch (err) {
    res.status(500).json({ error: `SharePoint sync failed: ${err.message}` });
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = router;
