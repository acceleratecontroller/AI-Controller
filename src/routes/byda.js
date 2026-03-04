/**
 * BYDA / DBYD Routes
 *
 * Mounted under /api/jobs in server.js
 * All routes are /api/jobs/:id/byda/*
 */

const express = require('express');
const router = express.Router();
const byda = require('../services/byda');

// GET /api/jobs/:id/byda — Get BYDA enquiry details for a job
router.get('/:id/byda', (req, res) => {
  try {
    const result = byda.getEnquiry(parseInt(req.params.id));
    if (!result) return res.status(404).json({ error: 'Job not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/byda/assess — Run rules engine to determine if BYDA is required
router.post('/:id/byda/assess', (req, res) => {
  try {
    const result = byda.assess(parseInt(req.params.id));
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Job not found' ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/byda/polygon — Save work area polygon
router.post('/:id/byda/polygon', (req, res) => {
  try {
    const { polygon } = req.body;
    if (!polygon) return res.status(400).json({ error: 'polygon (GeoJSON) is required' });
    const result = byda.savePolygon(parseInt(req.params.id), polygon);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Job not found' ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/byda/lodge — Attempt to lodge (reuse or new)
router.post('/:id/byda/lodge', async (req, res) => {
  try {
    const { triggered_by = 'user' } = req.body;
    const result = await byda.lodge(parseInt(req.params.id), triggered_by);
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Job not found' ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/byda/manual-link — User pastes external enquiry ID
router.post('/:id/byda/manual-link', (req, res) => {
  try {
    const { external_enquiry_id, triggered_by = 'user' } = req.body;
    if (!external_enquiry_id) {
      return res.status(400).json({ error: 'external_enquiry_id is required' });
    }
    const result = byda.manualLink(parseInt(req.params.id), external_enquiry_id, triggered_by);
    res.json(result);
  } catch (err) {
    res.status(err.message === 'Job not found' ? 404 : 500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/byda/geocode — Geocode the job's site address
router.post('/:id/byda/geocode', async (req, res) => {
  try {
    const { getDb } = require('../models/database');
    const db = getDb();
    const job = db.prepare('SELECT site_address FROM jobs WHERE id = ?').get(parseInt(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const address = req.body.address || job.site_address;
    if (!address) return res.status(400).json({ error: 'No address to geocode' });

    const coords = await byda.geocode(address);
    if (!coords) {
      return res.json({ success: false, message: 'Could not geocode address. Position the map manually.' });
    }
    res.json({ success: true, ...coords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: BYDA Rules ──

// GET /api/byda/rules — List all rules
router.get('/rules', (req, res) => {
  res.json(byda.getRules());
});

// PUT /api/byda/rules — Replace all rules
router.put('/rules', (req, res) => {
  try {
    const { rules } = req.body;
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules array is required' });
    const updated = byda.saveRules(rules);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
