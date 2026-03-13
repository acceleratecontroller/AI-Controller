const express = require('express');
const router = express.Router();
const { getDb } = require('../models/database');
const sheets = require('../services/sheets');

// GET /api/sheets/status — check if Google Sheets is configured
router.get('/status', (req, res) => {
  res.json({ configured: sheets.isConfigured() });
});

// POST /api/sheets/preview/:jobId — dry-run: show what would be written + duplicates
router.post('/preview/:jobId', async (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (!sheets.isConfigured()) {
    return res.status(400).json({ error: 'Google Sheets credentials not configured' });
  }

  try {
    const preview = await sheets.previewWrite(job);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: `Sheets error: ${err.message}` });
  }
});

// POST /api/sheets/sync/:jobId — actually write to the sheet (requires confirmation)
router.post('/sync/:jobId', async (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (!sheets.isConfigured()) {
    return res.status(400).json({ error: 'Google Sheets credentials not configured' });
  }

  const { confirmed, duplicate_decision } = req.body;

  if (!confirmed) {
    return res.status(400).json({ error: 'Write must be explicitly confirmed (confirmed: true)' });
  }

  try {
    // Always append — never overwrite existing rows
    const result = await sheets.appendRow(job, req.body.confirmed_by || 'user');

    // Log to job history — include duplicate decision if relevant
    const detail = duplicate_decision
      ? `Synced to WIP sheet (${duplicate_decision})`
      : 'Synced to WIP sheet (new row appended)';
    db.prepare(
      "INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, 'sheet_synced', ?, ?)"
    ).run(job.id, req.body.confirmed_by || 'user', detail);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Sheets write failed: ${err.message}` });
  }
});

// GET /api/sheets/audit — view audit log
router.get('/audit', (req, res) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM sheet_audit_log ORDER BY created_at DESC LIMIT 100').all();
  res.json(logs);
});

module.exports = router;
