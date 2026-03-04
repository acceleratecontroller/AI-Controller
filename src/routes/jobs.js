const express = require('express');
const router = express.Router();
const { getDb, generateJobNumber } = require('../models/database');

// Get all jobs (with optional status filter)
router.get('/', (req, res) => {
  const db = getDb();
  const { status, search } = req.query;

  let query = 'SELECT * FROM jobs';
  const conditions = [];
  const params = [];

  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }

  if (search) {
    conditions.push('(title LIKE ? OR job_number LIKE ? OR customer_name LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC';

  const jobs = db.prepare(query).all(...params);
  res.json(jobs);
});

// Get single job
router.get('/:id', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const history = db.prepare(
    'SELECT * FROM job_history WHERE job_id = ? ORDER BY created_at DESC'
  ).all(req.params.id);

  res.json({ ...job, history });
});

// Create a new job
router.post('/', (req, res) => {
  const db = getDb();
  const jobNumber = generateJobNumber();
  const {
    title, description, source = 'manual', priority = 'normal',
    customer_name, customer_email, customer_phone, site_address,
    scheduled_date, assigned_to, estimated_hours, notes, created_by = 'system'
  } = req.body;

  if (!title) return res.status(400).json({ error: 'Title is required' });

  const result = db.prepare(`
    INSERT INTO jobs (job_number, title, description, source, priority,
      customer_name, customer_email, customer_phone, site_address,
      scheduled_date, assigned_to, estimated_hours, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobNumber, title, description, source, priority,
    customer_name, customer_email, customer_phone, site_address,
    scheduled_date, assigned_to, estimated_hours, notes, created_by
  );

  // Log creation
  db.prepare(
    'INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, ?, ?, ?)'
  ).run(result.lastInsertRowid, 'created', created_by, `Job ${jobNumber} created via ${source}`);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(job);
});

// Update a job
router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const fields = [
    'title', 'description', 'priority', 'customer_name', 'customer_email',
    'customer_phone', 'site_address', 'scheduled_date', 'assigned_to',
    'estimated_hours', 'notes'
  ];

  const updates = [];
  const params = [];

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      params.push(req.body[field]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);

  db.prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  db.prepare(
    'INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, ?, ?, ?)'
  ).run(req.params.id, 'updated', req.body.updated_by || 'system', 'Job details updated');

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  res.json(job);
});

// Change job status (the approval workflow)
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status, changed_by = 'system', comment } = req.body;

  const validTransitions = {
    draft: ['submitted'],
    submitted: ['in_review'],
    in_review: ['approved', 'rejected', 'draft'],
    rejected: ['draft'],
    approved: ['in_progress'],
    in_progress: ['completed', 'on_hold'],
    on_hold: ['in_progress'],
    completed: []
  };

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const allowed = validTransitions[job.status] || [];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: `Cannot move from "${job.status}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}`
    });
  }

  const extraFields = {};
  if (status === 'in_review') extraFields.reviewed_by = changed_by;
  if (status === 'approved') extraFields.approved_by = changed_by;

  const setClauses = ["status = ?", "updated_at = datetime('now')"];
  const setParams = [status];

  for (const [key, val] of Object.entries(extraFields)) {
    setClauses.push(`${key} = ?`);
    setParams.push(val);
  }
  setParams.push(req.params.id);

  db.prepare(`UPDATE jobs SET ${setClauses.join(', ')} WHERE id = ?`).run(...setParams);

  db.prepare(
    'INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, ?, ?, ?)'
  ).run(req.params.id, `status_${status}`, changed_by, comment || `Status changed to ${status}`);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete a job (only drafts)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'draft') {
    return res.status(400).json({ error: 'Only draft jobs can be deleted' });
  }

  db.prepare('DELETE FROM job_history WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Job deleted' });
});

module.exports = router;
