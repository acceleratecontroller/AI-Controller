const express = require('express');
const router = express.Router();
const { getDb, generateJobNumber } = require('../models/database');
const servicem8 = require('../services/servicem8');

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
    conditions.push('(title LIKE ? OR job_number LIKE ? OR customer_name LIKE ? OR client LIKE ? OR client_reference_number LIKE ? OR site_address LIKE ? OR client_contact LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term, term, term, term, term);
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
    initial_status = 'quote', depot, client, contract,
    finance_po_number, client_reference_number, client_contact,
    job_received_date,
    customer_name, customer_email, customer_phone, site_address,
    scheduled_date, assigned_to, estimated_hours, notes, created_by = 'system'
  } = req.body;

  if (!title) return res.status(400).json({ error: 'Title is required' });

  const result = db.prepare(`
    INSERT INTO jobs (job_number, title, description, source, priority,
      initial_status, depot, client, contract,
      finance_po_number, client_reference_number, client_contact,
      job_received_date,
      customer_name, customer_email, customer_phone, site_address,
      scheduled_date, assigned_to, estimated_hours, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobNumber, title, description, source, priority,
    initial_status, depot, client, contract,
    finance_po_number, client_reference_number, client_contact,
    job_received_date,
    customer_name, customer_email, customer_phone, site_address,
    scheduled_date, assigned_to, estimated_hours, notes, created_by
  );

  // Log creation
  db.prepare(
    'INSERT INTO job_history (job_id, action, changed_by, details) VALUES (?, ?, ?, ?)'
  ).run(result.lastInsertRowid, 'created', created_by, `Job ${jobNumber} created via ${source}`);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);

  // Auto-assess BYDA requirement for new jobs
  try {
    const byda = require('../services/byda');
    byda.assess(job.id);
  } catch (e) { /* non-blocking */ }

  const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(updatedJob);
});

// Update a job
router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const fields = [
    'title', 'description', 'priority', 'initial_status',
    'depot', 'client', 'contract', 'finance_po_number',
    'client_reference_number', 'client_contact', 'job_received_date',
    'customer_name', 'customer_email', 'customer_phone',
    'site_address', 'scheduled_date', 'assigned_to',
    'estimated_hours', 'notes', 'byda_required', 'byda_status'
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
router.post('/:id/status', async (req, res) => {
  const db = getDb();
  const { status, changed_by = 'system', comment, servicem8_jobs: sm8Jobs } = req.body;

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

  // On approval, create ServiceM8 job(s) — blocks approval if it fails
  if (status === 'approved') {
    if (servicem8.isConfigured()) {
      try {
        const result = await servicem8.createJobsForApproval(req.params.id, sm8Jobs || []);
        if (result.errors.length > 0) {
          return res.status(502).json({
            error: 'ServiceM8 job creation failed — approval blocked',
            servicem8_errors: result.errors,
            created: result.created
          });
        }
      } catch (err) {
        return res.status(502).json({
          error: `ServiceM8 integration error: ${err.message}`
        });
      }
    }
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

  // Include ServiceM8 jobs in the response when approving
  if (status === 'approved') {
    updated.servicem8_jobs = servicem8.getServiceM8Jobs(req.params.id);
  }

  res.json(updated);
});

// Get ServiceM8 jobs linked to a work order
router.get('/:id/servicem8', (req, res) => {
  const sm8Jobs = servicem8.getServiceM8Jobs(req.params.id);
  res.json(sm8Jobs);
});

// Delete a job (only drafts)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!['draft', 'submitted'].includes(job.status)) {
    return res.status(400).json({ error: 'Only draft or submitted jobs can be deleted' });
  }

  db.prepare('DELETE FROM job_history WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Job deleted' });
});

module.exports = router;
