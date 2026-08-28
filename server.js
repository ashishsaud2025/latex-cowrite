'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const COMPILE_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;        // cap for a single text file read/write
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;    // cap for total project size when compiling

// Where all projects live on disk -- a folder at the same level as
// server.js/public/. Each subdirectory of this is one project; each
// project's own subdirectory structure is shown as the file tree in the
// UI and is exactly what gets compiled (so \input, \include,
// \includegraphics, \bibliography etc. all resolve normally).
const PROJECTS_ROOT = path.join(__dirname, 'projects');

// Extensions we treat as editable text in the browser. Anything else
// (images, existing PDFs, etc.) still shows up in the tree so the folder
// layout is visible, but isn't opened as text -- reading/writing a binary
// file as utf8 would corrupt it.
const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log',
]);

// If true, adds --only-cached so tectonic refuses to reach out to the network
// for *any* package it doesn't already have cached, instead of silently
// fetching. This does NOT sandbox the network at the OS level -- it only
// stops tectonic itself from trying. Off by default because most fresh
// installs need one online compile to warm the bundle cache.
const ONLY_CACHED = process.env.TECTONIC_ONLY_CACHED === '1';
const compileWorkspaces = new Map();
const compileLocks = new Map();

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// tectonic availability check (unchanged from before)
function checkTectonicAvailable() {
  const result = spawnSync('tectonic', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { available: false, detail: result.error ? result.error.message : result.stderr };
  }
  return { available: true, detail: result.stdout.trim() };
}

const startupCheck = checkTectonicAvailable();
if (!startupCheck.available) {
  console.warn('=================================================================');
  console.warn(' WARNING: `tectonic` was not found on PATH.');
  console.warn(' Install it before compiling will work: https://tectonic-typesetting.github.io/');
  console.warn('=================================================================');
} else {
  console.log(`tectonic found: ${startupCheck.detail}`);
}

app.get('/api/tectonic-status', (req, res) => {
  res.json(checkTectonicAvailable());
});

// Projects root setup: create the folder if missing, seed a demo project
// if there are no projects at all yet (so the UI never opens to an empty
// state on a fresh checkout).
async function ensureProjectsRoot() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const hasAnyProject = entries.some((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (!hasAnyProject) {
    await seedDemoProject();
  }
}

async function seedDemoProject() {
  const demoRoot = path.join(PROJECTS_ROOT, 'demo');
  await fs.mkdir(path.join(demoRoot, 'sections'), { recursive: true });
  await fs.writeFile(
    path.join(demoRoot, 'main.tex'),
    `\\documentclass{article}
\\title{Hello, latex-cowrite}
\\author{You}
\\begin{document}
\\maketitle

\\input{sections/intro}

\\end{document}
`,
    'utf8'
  );
  await fs.writeFile(
    path.join(demoRoot, 'sections', 'intro.tex'),
    `\\section{Introduction}
This file lives at \\texttt{sections/intro.tex} and is pulled in from
\\texttt{main.tex} via \\verb|\\input|. Edit either file in the tree on the
left, hit Compile, and both are included in the build.
`,
    'utf8'
  );
}

// Path safety helpers
const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function projectRootFor(projectName) {
  if (typeof projectName !== 'string' || !PROJECT_NAME_RE.test(projectName)) return null;
  return path.join(PROJECTS_ROOT, projectName);
}

async function projectExists(projectRoot) {
  try {
    const st = await fs.stat(projectRoot);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// Resolves a client-supplied relative path against a project root and
// verifies the result can't escape that root (blocks "../../etc/passwd"
// style traversal). Returns null if unsafe.
function resolveSafePath(projectRoot, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').includes('..')) return null;
  const rootResolved = path.resolve(projectRoot);
  const abs = path.resolve(rootResolved, normalized);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

function isTextEditable(relPath) {
  return TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

// GET /api/projects -> list of project names
app.get('/api/projects', async (req, res) => {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    res.json({ projects: names });
  } catch (err) {
    res.status(500).json({ error: `Could not list projects: ${err.message}` });
  }
});

// POST /api/projects -> create a new, empty (seeded) project
// Body: { name: string }
app.post('/api/projects', async (req, res) => {
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
    res.status(201).json({ name });
  } catch (err) {
    res.status(500).json({ error: `Could not create project: ${err.message}` });
  }
});

// GET /api/projects/:project/tree -> nested file/folder listing
app.get('/api/projects/:project/tree', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }
  try {
    const children = await buildTree(root, '');
    res.json({ name: req.params.project, path: '', type: 'dir', children });
  } catch (err) {
    res.status(500).json({ error: `Could not read project tree: ${err.message}` });
  }
});

async function buildTree(dirAbsPath, relPath) {
  const entries = await fs.readdir(dirAbsPath, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const childAbs = path.join(dirAbsPath, entry.name);
    if (entry.isDirectory()) {
      out.push({
        name: entry.name,
        path: childRel,
        type: 'dir',
        children: await buildTree(childAbs, childRel),
      });
    } else {
      out.push({ name: entry.name, path: childRel, type: 'file', editable: isTextEditable(childRel) });
    }
  }
  return out;
}

// GET /api/projects/:project/file?path=relPath -> { path, content }
app.get('/api/projects/:project/file', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }
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
// Body: { path: string, content: string }
app.put('/api/projects/:project/file', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }
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
// Body: { path: string, type: 'file' | 'dir' }
app.post('/api/projects/:project/entries', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }
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
// Body: { path: string, newPath: string }
app.patch('/api/projects/:project/entries', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }
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
// Body: { path: string }
app.delete('/api/projects/:project/entries', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }
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

// POST /api/projects/:project/compile
// Compiles the project's entry file (main.tex if present, else the first
// top-level .tex file). Success: 200 application/pdf. Failure: JSON
// { error, log, entry }.
app.post('/api/projects/:project/compile', async (req, res) => {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.', log: '', entry: null });
  }

  const status = checkTectonicAvailable();
  if (!status.available) {
    return res.status(500).json({
      error: 'tectonic is not installed or not on PATH on the server. See server logs.',
      log: '',
      entry: null,
    });
  }

  let entryRel;
  try {
    entryRel = await findEntryFile(root);
  } catch (err) {
    return res.status(500).json({ error: `Could not inspect project: ${err.message}`, log: '', entry: null });
  }
  if (!entryRel) {
    return res.status(400).json({
      error: 'No .tex entry file found. Add a main.tex (or any top-level .tex file) to compile.',
      log: '',
      entry: null,
    });
  }

  const projectSize = await dirSizeBytes(root, MAX_PROJECT_BYTES + 1);
  if (projectSize > MAX_PROJECT_BYTES) {
    return res.status(413).json({
      error: `Project exceeds ${MAX_PROJECT_BYTES} byte limit.`,
      log: '',
      entry: entryRel,
    });
  }

  // Compile from a cached throwaway copy of the whole project, not the
  // project directory itself. Keeping this sandbox between builds lets
  // Tectonic reuse .aux, .toc, bibliography, and other intermediates.
  const entryBase = path.basename(entryRel, '.tex');
  let compileOutput;
  try {
    compileOutput = await withCompileLock(req.params.project, async () => {
      const jobId = crypto.randomBytes(8).toString('hex');
      const tmpDir = await getCompileWorkspace(req.params.project, root, jobId);
      const args = [
        '--untrusted',
        '-o', tmpDir,
        '--keep-logs',
        '--keep-intermediates',
        '--reruns', '1',
      ];
      if (ONLY_CACHED) args.push('--only-cached');
      args.push(path.join(tmpDir, entryRel));
      return {
        tmpDir,
        pdfPath: path.join(tmpDir, `${entryBase}.pdf`),
        logPath: path.join(tmpDir, `${entryBase}.log`),
        result: await runTectonic(args, tmpDir),
      };
    });
  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}`, log: '', entry: entryRel });
  }

  const { tmpDir, pdfPath, logPath, result } = compileOutput;
  try {
    await publishCompileArtifacts(tmpDir, root);
  } catch (err) {
    return res.status(500).json({ error: `Could not publish compile artifacts: ${err.message}`, log: '', entry: entryRel });
  }
  if (result.timedOut) {
    const log = await readIfExists(logPath);
    return res.status(504).json({
      error: `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`,
      log: combineLog(result.stdout, result.stderr, log),
      entry: entryRel,
    });
  }
  if (result.code !== 0) {
    const log = await readIfExists(logPath);
    return res.status(422).json({
      error: `tectonic exited with code ${result.code}.`,
      log: combineLog(result.stdout, result.stderr, log),
      entry: entryRel,
    });
  }

  const pdfExists = await fs.access(pdfPath).then(() => true).catch(() => false);
  if (!pdfExists) {
    const log = await readIfExists(logPath);
    return res.status(422).json({
      error: 'tectonic reported success but produced no PDF.',
      log: combineLog(result.stdout, result.stderr, log),
      entry: entryRel,
    });
  }

  const pdf = await fs.readFile(pdfPath);
  res.set('Content-Type', 'application/pdf');
  res.set('X-Compiled-Entry', entryRel);
  return res.status(200).send(pdf);
});

async function withCompileLock(projectName, operation) {
  const previous = compileLocks.get(projectName) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  compileLocks.set(projectName, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (compileLocks.get(projectName) === current) compileLocks.delete(projectName);
  }
}

async function getCompileWorkspace(projectName, projectRoot, jobId) {
  const previous = compileWorkspaces.get(projectName);
  if (previous) {
    await previous.ready;
    await fs.cp(projectRoot, previous.path, {
      recursive: true,
      force: true,
      filter: (source) => {
        const relative = path.relative(projectRoot, source);
        return relative === '' || !relative.split(path.sep).includes('outputs');
      },
    });
    return previous.path;
  }

  const workspace = {
    path: await fs.mkdtemp(path.join(os.tmpdir(), `texcomp-${projectName}-${jobId}-`)),
  };
  workspace.ready = fs.cp(projectRoot, workspace.path, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(projectRoot, source);
      return relative === '' || !relative.split(path.sep).includes('outputs');
    },
  });
  compileWorkspaces.set(projectName, workspace);
  await workspace.ready;
  return workspace.path;
}

async function publishCompileArtifacts(tmpDir, projectRoot) {
  const outputDir = path.join(projectRoot, 'outputs');
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const entries = await fs.readdir(tmpDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'outputs') continue;
    const sourcePath = path.join(projectRoot, entry.name);
    const sourceExists = await fs.access(sourcePath).then(() => true).catch(() => false);
    if (sourceExists) continue;
    await fs.cp(path.join(tmpDir, entry.name), path.join(outputDir, entry.name), { recursive: true });
  }
}

async function findEntryFile(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const topTexFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.tex'))
    .map((e) => e.name)
    .sort();
  if (topTexFiles.includes('main.tex')) return 'main.tex';
  return topTexFiles[0] || null;
}

async function dirSizeBytes(dirAbsPath, stopAfter) {
  let total = 0;
  async function walk(p) {
    if (total > stopAfter) return;
    const entries = await fs.readdir(p, { withFileTypes: true });
    for (const entry of entries) {
      if (total > stopAfter) return;
      const abs = path.join(p, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        const st = await fs.stat(abs);
        total += st.size;
      }
    }
  }
  await walk(dirAbsPath);
  return total;
}

// tectonic process runner (unchanged behavior from the single-file MVP)
function runTectonic(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('tectonic', args, {
      cwd,
      shell: false,
      detached: true, // own process group, so a timeout can kill the whole tree
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, COMPILE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function combineLog(stdout, stderr, texLog) {
  const parts = [];
  if (texLog) parts.push('--- log ---\n' + texLog);
  if (stdout) parts.push('--- stdout ---\n' + stdout);
  if (stderr) parts.push('--- stderr ---\n' + stderr);
  return parts.join('\n\n') || '(no output captured)';
}

ensureProjectsRoot()
  .catch((err) => {
    console.error('Failed to set up projects/ directory:', err.message);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`latex-cowrite listening on http://localhost:${PORT}`);
    });
  });
