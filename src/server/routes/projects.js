'use strict';

const path = require('path');
const express = require('express');
const fs = require('fs/promises');
const {
  MAX_FILE_BYTES,
  DEFAULT_PROJECT_SETTINGS,
} = require('../constants');
const {
  PROJECTS_ROOT,
  projectRootFor,
  projectExists,
  resolveSafePath,
  isTextEditable,
  buildTree,
  listProjectNames,
} = require('../projects');
const { writeProjectSettings } = require('../settings');

const router = express.Router();

async function requireProjectRoot(req, res) {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    res.status(404).json({ error: 'Project not found.' });
    return null;
  }
  return root;
}

// GET /api/projects -> list of project names
router.get('/', async (req, res) => {
  try {
    const names = await listProjectNames();
    res.json({ projects: names });
  } catch (err) {
    res.status(500).json({ error: `Could not list projects: ${err.message}` });
  }
});

// POST /api/projects -> create a new, empty (seeded) project
router.post('/', async (req, res) => {
  const name = req.body && req.body.name;
  const root = projectRootFor(name);
  if (!root) {
    return res.status(400).json({ error: 'Project name must be non-empty and use only letters, numbers, "-", "_".' });
  }
  if (await projectExists(root)) {
    return res.status(409).json({ error: `Project "${name}" already exists.` });
  }
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n',
      'utf8'
    );
    await writeProjectSettings(name, DEFAULT_PROJECT_SETTINGS);
    res.status(201).json({ name });
  } catch (err) {
    res.status(500).json({ error: `Could not create project: ${err.message}` });
  }
});

// GET /api/projects/:project/tree -> nested file/folder listing
router.get('/:project/tree', async (req, res) => {
  const name = req.params.project;
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  try {
    const children = await buildTree(root, '');
    res.json({ name, path: '', type: 'dir', children });
  } catch (err) {
    res.status(500).json({ error: `Could not read project tree: ${err.message}` });
  }
});

// GET /api/projects/:project/file?path=relPath -> { path, content }
router.get('/:project/file', async (req, res) => {
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  const relPath = req.query.path;
  const abs = resolveSafePath(root, relPath);
  if (!abs) return res.status(400).json({ error: 'Invalid path.' });
  if (!isTextEditable(relPath)) {
    return res.status(415).json({ error: 'This file type is not editable as text in this app.' });
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file.' });
    if (stat.size > MAX_FILE_BYTES) {
      return res.status(413).json({ error: `File exceeds ${MAX_FILE_BYTES} byte limit.` });
    }
    const content = await fs.readFile(abs, 'utf8');
    res.json({ path: relPath, content });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
    res.status(500).json({ error: `Could not read file: ${err.message}` });
  }
});

// PUT /api/projects/:project/file -> save file content
router.put('/:project/file', async (req, res) => {
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  const { path: relPath, content } = req.body || {};
  const abs = resolveSafePath(root, relPath);
  if (!abs) return res.status(400).json({ error: 'Invalid path.' });
  if (!isTextEditable(relPath)) {
    return res.status(415).json({ error: 'This file type is not editable as text in this app.' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: '"content" must be a string.' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    return res.status(413).json({ error: `Content exceeds ${MAX_FILE_BYTES} byte limit.` });
  }
  try {
    await fs.writeFile(abs, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not save file: ${err.message}` });
  }
});

// POST /api/projects/:project/entries -> create an empty file or folder
router.post('/:project/entries', async (req, res) => {
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  const { path: relPath, type } = req.body || {};
  const abs = resolveSafePath(root, relPath);
  if (!abs || (type !== 'file' && type !== 'dir')) {
    return res.status(400).json({ error: 'Invalid path or type.' });
  }
  try {
    const already = await fs
      .access(abs)
      .then(() => true)
      .catch(() => false);
    if (already) return res.status(409).json({ error: 'That path already exists.' });

    if (type === 'dir') {
      await fs.mkdir(abs, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, '', 'utf8');
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Could not create entry: ${err.message}` });
  }
});

// PATCH /api/projects/:project/entries -> rename a file or folder
router.patch('/:project/entries', async (req, res) => {
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  const { path: oldRelPath, newPath } = req.body || {};
  const oldAbs = resolveSafePath(root, oldRelPath);
  const newAbs = resolveSafePath(root, newPath);
  if (!oldAbs || !newAbs || oldAbs === root || newAbs === root) {
    return res.status(400).json({ error: 'Invalid path.' });
  }
  try {
    const oldStat = await fs.stat(oldAbs);
    if (await fs.access(newAbs).then(() => true).catch(() => false)) {
      return res.status(409).json({ error: 'That path already exists.' });
    }
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);
    res.json({ ok: true, type: oldStat.isDirectory() ? 'dir' : 'file' });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Entry not found.' });
    res.status(500).json({ error: `Could not rename entry: ${err.message}` });
  }
});

// DELETE /api/projects/:project/entries -> delete a file or folder
router.delete('/:project/entries', async (req, res) => {
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  const relPath = req.body && req.body.path;
  const abs = resolveSafePath(root, relPath);
  if (!abs || abs === root) return res.status(400).json({ error: 'Invalid path.' });
  try {
    const stat = await fs.stat(abs);
    await fs.rm(abs, { recursive: stat.isDirectory(), force: false });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Entry not found.' });
    res.status(500).json({ error: `Could not delete entry: ${err.message}` });
  }
});

module.exports = router;
