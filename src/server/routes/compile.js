'use strict';

const express = require('express');
const {
  MAX_PROJECT_BYTES,
} = require('../constants');
const { projectRootFor, projectExists, findEntryFile, dirSizeBytes } = require('../projects');
const { checkTectonicAvailable, beginCompileJob, compileJobs } = require('../compile');

const router = express.Router();

// POST /api/projects/:project/compile/start
router.post('/:project/compile/start', async (req, res) => {
  const projectName = req.params.project;
  const root = projectRootFor(projectName);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.', log: '', entry: null, jobId: null });
  }

  const status = checkTectonicAvailable();
  if (!status.available) {
    return res.status(500).json({
      error: 'tectonic is not installed or not on PATH on the server. See server logs.',
      log: '',
      entry: null,
      jobId: null,
    });
  }

  let entryRel;
  try {
    entryRel = await findEntryFile(root);
  } catch (err) {
    return res.status(500).json({ error: `Could not inspect project: ${err.message}`, log: '', entry: null, jobId: null });
  }
  if (!entryRel) {
    return res.status(400).json({
      error: 'No .tex entry file found. Add a main.tex (or any top-level .tex file) to compile.',
      log: '',
      entry: null,
      jobId: null,
    });
  }

  const projectSize = await dirSizeBytes(root, MAX_PROJECT_BYTES + 1);
  if (projectSize > MAX_PROJECT_BYTES) {
    return res.status(413).json({
      error: `Project exceeds ${MAX_PROJECT_BYTES} byte limit.`,
      log: '',
      entry: entryRel,
      jobId: null,
    });
  }

  const job = await beginCompileJob(projectName, entryRel);
  res.status(202).json({
    jobId: job.id,
    entry: entryRel,
    status: job.status,
  });
});

// Look up a job, verifying it belongs to the project named in the URL.
function findJob(req, res) {
  const job = compileJobs.get(req.params.jobId);
  if (!job || job.projectName !== req.params.project) {
    res.status(404).json({ error: 'Compile job not found.' });
    return null;
  }
  return job;
}

// GET /api/projects/:project/compile/:jobId/status
router.get('/:project/compile/:jobId/status', (req, res) => {
  const job = findJob(req, res);
  if (!job) return;

  res.json({
    jobId: job.id,
    status: job.status,
    entry: job.entry,
    error: job.error || null,
    log: job.log || '',
    cached: !!job.cached,
    hasPdf: !!job.pdf,
    durationMs: job.durationMs,
  });
});

// GET /api/projects/:project/compile/:jobId/logs (SSE stream)
router.get('/:project/compile/:jobId/logs', (req, res) => {
  const job = findJob(req, res);
  if (!job) return;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  job.clients.add(res);
  if (job.status === 'running') {
    res.write(`event: status\ndata: ${JSON.stringify({ status: 'running', entry: job.entry })}\n\n`);
  }
  if (job.log) {
    res.write(`event: log\ndata: ${JSON.stringify({ text: job.log })}\n\n`);
  }

  req.on('close', () => {
    job.clients.delete(res);
  });
});

// GET /api/projects/:project/compile/:jobId/pdf
router.get('/:project/compile/:jobId/pdf', async (req, res) => {
  const job = findJob(req, res);
  if (!job) return;

  if (!job.pdf) {
    return res.status(409).json({ error: 'Compile result is not ready yet.' });
  }

  res.set('Content-Type', 'application/pdf');
  if (job.entry) res.set('X-Compiled-Entry', job.entry);
  if (job.cached) res.set('X-Compile-Cached', 'true');
  return res.status(200).send(job.pdf);
});

// GET /api/projects/:project/compile/:jobId/synctex
router.get('/:project/compile/:jobId/synctex', (req, res) => {
  const job = findJob(req, res);
  if (!job) return;
  if (!job.synctex) {
    return res.status(404).json({ error: 'SyncTeX data is not available.' });
  }
  res.set('Content-Type', 'application/gzip');
  return res.status(200).send(job.synctex);
});

module.exports = router;
