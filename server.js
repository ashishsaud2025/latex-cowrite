'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const fsSync = require('fs'); // used only to seed a new room's content synchronously, see below
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// Server-side sync + awareness helpers for Yjs's WebSocket protocol. Pinned to
// y-websocket 1.5.x since 2.x/3.x dropped these server utilities.
const { setupWSConnection, getYDoc, docs: yDocs } = require('y-websocket/bin/utils');

const PORT = process.env.PORT || 3000;
// Fresh ID per process start, used by clients to detect a server restart and
// force a hard-resync instead of letting Yjs merge against a re-seeded doc.
const SERVER_INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const COMPILE_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;        // cap for a single text file read/write
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;    // cap for total project size when compiling
const PROJECT_SETTINGS_FILE = '.longtex.json';
const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  collaboration: { allowSharedClipboard: false },
  editor: {
    theme: 'eclipse',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2,
  },
  pdfViewer: { defaultTab: 'pdf' },
});

// Where all projects live on disk. Each subdirectory is one project, shown
// as-is in the UI file tree and compiled directly, so \input/\include work.
const PROJECTS_ROOT = path.join(__dirname, 'projects');

// Extensions treated as editable text. Other files still show in the tree
// but aren't opened as text, since reading/writing them as utf8 would corrupt them.
const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log',
]);

// If true, blocks tectonic from fetching uncached packages (app-level only,
// not OS network sandboxing). Off by default since a fresh install needs one
// online compile to warm the cache.
const ONLY_CACHED = process.env.TECTONIC_ONLY_CACHED === '1';
const compileWorkspaces = new Map();
const compileLocks = new Map();
const compileCache = new Map();
const compileJobs = new Map();

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const collaborationServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FILE_BYTES });

// Real-time collaborative editing (Yjs)
// Each file gets its own Y.Doc (keyed by project+path) with a Y.Text "content".
// Sync and presence are handled by y-websocket's server helpers, which also
// auto-reconnect/resync clients, replacing the old manual broadcast/heartbeat logic.
function roomKeyFor(projectName, filePath) {
  return `${projectName}::${filePath}`;
}

function settingsRoomKeyFor(projectName) {
  return `${projectName}::__settings__`;
}

function normalizeProjectSettings(raw) {
  const normalized = raw && typeof raw === 'object' ? raw : {};
  const collaboration = normalized.collaboration && typeof normalized.collaboration === 'object' ? normalized.collaboration : {};
  const editor = normalized.editor && typeof normalized.editor === 'object' ? normalized.editor : {};
  const pdfViewer = normalized.pdfViewer && typeof normalized.pdfViewer === 'object' ? normalized.pdfViewer : {};

  const legacyAllowSharedClipboard = normalized.allowSharedClipboard === true;
  const allowSharedClipboard = typeof collaboration.allowSharedClipboard === 'boolean'
    ? collaboration.allowSharedClipboard
    : legacyAllowSharedClipboard;

  const editorTheme = typeof editor.theme === 'string' ? editor.theme : 'eclipse';
  const editorLineNumbers = editor.lineNumbers !== false;
  const editorLineWrapping = editor.lineWrapping !== false;
  const editorTabSize = Number.isInteger(editor.tabSize) && editor.tabSize > 0 ? editor.tabSize : 2;
  const editorIndentUnit = Number.isInteger(editor.indentUnit) && editor.indentUnit > 0 ? editor.indentUnit : editorTabSize;

  return {
    collaboration: {
      allowSharedClipboard: allowSharedClipboard === true,
    },
    editor: {
      theme: editorTheme,
      lineNumbers: editorLineNumbers,
      lineWrapping: editorLineWrapping,
      tabSize: editorTabSize,
      indentUnit: editorIndentUnit,
    },
    pdfViewer: {
      defaultTab: pdfViewer.defaultTab === 'log' ? 'log' : 'pdf',
    },
  };
}

async function readProjectSettings(projectName) {
  const root = projectRootFor(projectName);
  if (!root || !(await projectExists(root))) {
    return { ...DEFAULT_PROJECT_SETTINGS };
  }

  const settingsPath = path.join(root, PROJECT_SETTINGS_FILE);
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    return normalizeProjectSettings(JSON.parse(raw));
  } catch {
    const defaultSettings = { ...DEFAULT_PROJECT_SETTINGS };
    await fs.writeFile(settingsPath, `${JSON.stringify(defaultSettings, null, 2)}\n`, 'utf8');
    return defaultSettings;
  }
}

async function writeProjectSettings(projectName, nextSettings) {
  const root = projectRootFor(projectName);
  if (!root || !(await projectExists(root))) {
    return { ...DEFAULT_PROJECT_SETTINGS };
  }

  const settings = normalizeProjectSettings(nextSettings);
  const settingsPath = path.join(root, PROJECT_SETTINGS_FILE);
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

// How long to wait after the last edit before persisting a room to disk;
// Yjs updates themselves are still sent to peers immediately, undebounced.
const PERSIST_DEBOUNCE_MS = 500;
const persistTimers = new Map(); // roomKey -> Timeout

function schedulePersist(roomKey, projectName, filePath) {
  clearTimeout(persistTimers.get(roomKey));
  persistTimers.set(roomKey, setTimeout(async () => {
    persistTimers.delete(roomKey);
    const doc = yDocs.get(roomKey);
    if (!doc) return; // room was torn down before this fired
    const root = projectRootFor(projectName);
    const abs = root && resolveSafePath(root, filePath);
    if (!abs) return;
    try {
      // The project or the file itself may have been deleted/renamed out
      // from under an active room; skip the write rather than recreate it.
      if (!(await projectExists(root))) return;
      await fs.writeFile(abs, doc.getText('content').toString(), 'utf8');
    } catch {
      // The next edit (or an explicit Save) will retry.
    }
  }, PERSIST_DEBOUNCE_MS));
}

function schedulePersistSettings(roomKey, projectName, settingsMap) {
  clearTimeout(persistTimers.get(roomKey));
  persistTimers.set(roomKey, setTimeout(async () => {
    persistTimers.delete(roomKey);
    const doc = yDocs.get(roomKey);
    if (!doc || !settingsMap) return;
    const root = projectRootFor(projectName);
    if (!root || !(await projectExists(root))) return;
    try {
      const nextSettings = normalizeProjectSettings(Object.fromEntries(settingsMap.entries()));
      await writeProjectSettings(projectName, nextSettings);
    } catch {
      // The next update (or an explicit settings write) will retry.
    }
  }, PERSIST_DEBOUNCE_MS));
}

server.on('upgrade', (request, socket, head) => {
  let projectName;
  let filePath;
  let isSettingsRoom = false;
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const settingsMatch = requestUrl.pathname.match(/^\/collaboration\/([^/]+)\/__settings__$/);
    const fileMatch = requestUrl.pathname.match(/^\/collaboration\/([^/]+)\/([^/]+)$/);

    if (settingsMatch) {
      isSettingsRoom = true;
      projectName = settingsMatch && decodeURIComponent(settingsMatch[1]);
    } else {
      projectName = fileMatch && decodeURIComponent(fileMatch[1]);
      filePath = fileMatch && decodeURIComponent(fileMatch[2]);
    }
  } catch {
    projectName = null;
    filePath = null;
    isSettingsRoom = false;
  }

  const root = projectRootFor(projectName);
  if (!root) {
    socket.destroy();
    return;
  }

  if (isSettingsRoom) {
    projectExists(root)
      .then((exists) => {
        if (!exists) {
          socket.destroy();
          return;
        }
        collaborationServer.handleUpgrade(request, socket, head, (client) => {
          collaborationServer.emit('connection', client, request, { projectName, filePath: null, isSettingsRoom: true });
        });
      })
      .catch(() => {
        socket.destroy();
      });
    return;
  }

  if (!filePath || !isTextEditable(filePath) || !resolveSafePath(root, filePath)) {
    socket.destroy();
    return;
  }

  collaborationServer.handleUpgrade(request, socket, head, (client) => {
    collaborationServer.emit('connection', client, request, { projectName, filePath });
  });
});

collaborationServer.on('connection', (client, request, { projectName, filePath, isSettingsRoom = false }) => {
  const roomKey = isSettingsRoom ? settingsRoomKeyFor(projectName) : roomKeyFor(projectName, filePath);
  const isNewRoom = !yDocs.has(roomKey);
  // getYDoc creates/registers the doc synchronously, so a concurrent second
  // connection to the same new room sees isNewRoom === false and skips reseeding.
  const doc = getYDoc(roomKey);

  if (isSettingsRoom) {
    if (isNewRoom) {
      const settingsMap = doc.getMap('settings');
      readProjectSettings(projectName)
        .then((initial) => {
          const nextSettings = normalizeProjectSettings(initial);
          doc.transact(() => {
            for (const [key, value] of Object.entries(nextSettings)) {
              settingsMap.set(key, value);
            }
          });
          doc.on('update', () => schedulePersistSettings(roomKey, projectName, settingsMap));
        })
        .catch(() => {
          doc.on('update', () => schedulePersistSettings(roomKey, projectName, doc.getMap('settings')));
        });
    }
  } else if (isNewRoom) {
    // Seed the Y.Text from disk once, at room creation (not every connection).
    // Must be synchronous, before setupWSConnection attaches its listener below,
    // or an early client sync message could arrive and be dropped.
    const root = projectRootFor(projectName);
    const abs = resolveSafePath(root, filePath);
    let initialContent = '';
    try {
      initialContent = fsSync.readFileSync(abs, 'utf8');
    } catch {
      // File doesn't exist yet (e.g. a brand-new file); start empty.
    }
    const ytext = doc.getText('content');
    if (ytext.length === 0 && initialContent) {
      ytext.insert(0, initialContent);
    }
    doc.on('update', () => schedulePersist(roomKey, projectName, filePath));
  }

  setupWSConnection(client, request, { docName: roomKey });
});

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

app.post('/api/projects/:project/compile/start', async (req, res) => {
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

app.get('/api/projects/:project/compile/:jobId/status', (req, res) => {
  const job = compileJobs.get(req.params.jobId);
  if (!job || job.projectName !== req.params.project) {
    return res.status(404).json({ error: 'Compile job not found.' });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    entry: job.entry,
    error: job.error || null,
    log: job.log || '',
    cached: !!job.cached,
    hasPdf: !!job.pdf,
  });
});

app.get('/api/projects/:project/compile/:jobId/logs', (req, res) => {
  const job = compileJobs.get(req.params.jobId);
  if (!job || job.projectName !== req.params.project) {
    return res.status(404).end('Compile job not found.');
  }

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

app.get('/api/projects/:project/compile/:jobId/pdf', async (req, res) => {
  const job = compileJobs.get(req.params.jobId);
  if (!job || job.projectName !== req.params.project) {
    return res.status(404).json({ error: 'Compile job not found.' });
  }

  if (!job.pdf) {
    return res.status(409).json({ error: 'Compile result is not ready yet.' });
  }

  res.set('Content-Type', 'application/pdf');
  if (job.entry) res.set('X-Compiled-Entry', job.entry);
  if (job.cached) res.set('X-Compile-Cached', 'true');
  return res.status(200).send(job.pdf);
});

// Lets a client check over plain HTTP whether it's still talking to the same
// server process, before allowing an auto WebSocket reconnect (see app.js).
app.get('/api/server-instance-id', (req, res) => {
  res.json({ id: SERVER_INSTANCE_ID });
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
  await writeProjectSettings('demo', DEFAULT_PROJECT_SETTINGS);
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

app.get('/api/projects/:project/settings', async (req, res) => {
  const projectName = req.params.project;
  const root = projectRootFor(projectName);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }

  const settings = await readProjectSettings(projectName);
  res.json({ settings });
});

app.patch('/api/projects/:project/settings', async (req, res) => {
  const projectName = req.params.project;
  const root = projectRootFor(projectName);
  if (!root || !(await projectExists(root))) {
    return res.status(404).json({ error: 'Project not found.' });
  }

  const settingsDoc = yDocs.get(settingsRoomKeyFor(projectName));
  if (settingsDoc) {
    const settingsMap = settingsDoc.getMap('settings');
    const nextSettings = normalizeProjectSettings(req.body || {});
    settingsDoc.transact(() => {
      for (const [key, value] of Object.entries(nextSettings)) {
        settingsMap.set(key, value);
      }
      for (const key of Array.from(settingsMap.keys())) {
        if (!(key in nextSettings)) {
          settingsMap.delete(key);
        }
      }
    });
    const settings = normalizeProjectSettings(Object.fromEntries(settingsMap.entries()));
    return res.json({ settings });
  }

  const settings = await writeProjectSettings(projectName, req.body || {});
  res.json({ settings });
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
    await writeProjectSettings(name, DEFAULT_PROJECT_SETTINGS);
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

function emitJobEvent(job, eventName, payload) {
  const serialized = JSON.stringify(payload);
  for (const response of [...job.clients]) {
    try {
      response.write(`event: ${eventName}\ndata: ${serialized}\n\n`);
    } catch {
      job.clients.delete(response);
    }
  }
}

function finalizeCompileJob(job, status, payload = {}) {
  job.status = status;
  Object.assign(job, payload);
  emitJobEvent(job, 'status', {
    status,
    entry: job.entry,
    error: job.error || null,
    log: job.log || '',
    cached: !!job.cached,
    hasPdf: !!job.pdf,
  });
  for (const response of [...job.clients]) {
    try {
      response.end();
    } catch {}
    job.clients.delete(response);
  }
  if (job.status !== 'running') {
    setTimeout(() => compileJobs.delete(job.id), 10 * 60 * 1000);
  }
}

async function beginCompileJob(projectName, entryRel) {
  const fingerprint = await getProjectFingerprint(projectRootFor(projectName));
  const cached = compileCache.get(projectName);
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    projectName,
    entry: entryRel,
    fingerprint,
    status: 'running',
    log: '',
    clients: new Set(),
    cached: false,
  };
  compileJobs.set(job.id, job);

  if (cached && cached.entry === entryRel && cached.fingerprint === fingerprint) {
    job.cached = true;
    job.pdf = cached.pdf;
    job.status = 'success';
    job.log = 'Using cached PDF.';
    finalizeCompileJob(job, 'success', { cached: true, pdf: cached.pdf, log: job.log });
    return job;
  }

  queueMicrotask(async () => {
    try {
      // Serialize compiles per project to prevent concurrent jobs from racing on the
      // shared workspace. Cache-hit checks stay outside the lock since they don't touch it.
      await withCompileLock(projectName, async () => {
        const root = projectRootFor(projectName);
        const jobId = job.id;
        const tmpDir = await getCompileWorkspace(projectName, root, jobId);
        const args = [
          '--untrusted',
          '-o', tmpDir,
          '--keep-logs',
          '--keep-intermediates',
          '--reruns', '1',
        ];
        if (ONLY_CACHED) args.push('--only-cached');
        args.push(path.join(tmpDir, entryRel));

        const result = await runTectonicStream(args, tmpDir, (chunk) => {
          const text = String(chunk);
          job.log += text;
          emitJobEvent(job, 'log', { text });
        });

        const logPath = path.join(tmpDir, `${path.basename(entryRel, '.tex')}.log`);
        const log = await readIfExists(logPath);
        const combined = combineLog(result.stdout, result.stderr, log);
        const pdfPath = path.join(tmpDir, `${path.basename(entryRel, '.tex')}.pdf`);

        try {
          await publishCompileArtifacts(tmpDir, root);
        } catch (err) {
          job.error = `Could not publish compile artifacts: ${err.message}`;
          finalizeCompileJob(job, 'error', { log: combined, error: job.error });
          return;
        }

        if (result.timedOut) {
          job.error = `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`;
          finalizeCompileJob(job, 'timeout', { log: combined, error: job.error });
          return;
        }
        if (result.code !== 0) {
          job.error = `tectonic exited with code ${result.code}.`;
          finalizeCompileJob(job, 'error', { log: combined, error: job.error });
          return;
        }

        const pdfExists = await fs.access(pdfPath).then(() => true).catch(() => false);
        if (!pdfExists) {
          job.error = 'tectonic reported success but produced no PDF.';
          finalizeCompileJob(job, 'error', { log: combined, error: job.error });
          return;
        }

        const pdf = await fs.readFile(pdfPath);
        if (await getProjectFingerprint(root) === job.fingerprint) {
          compileCache.set(projectName, {
            entry: entryRel,
            fingerprint: job.fingerprint,
            pdf,
          });
        }
        job.pdf = pdf;
        job.log = combined;
        finalizeCompileJob(job, 'success', { log: combined, cached: false, pdf });
      });
    } catch (err) {
      job.error = `Server error: ${err.message}`;
      finalizeCompileJob(job, 'error', { log: job.log || String(err.stack || err), error: job.error });
    }
  });

  return job;
}

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

async function getProjectFingerprint(projectRoot) {
  const files = [];
  async function collect(dirAbsPath) {
    const entries = await fs.readdir(dirAbsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'outputs') continue;
      const abs = path.join(dirAbsPath, entry.name);
      if (entry.isDirectory()) {
        await collect(abs);
      } else {
        const stat = await fs.stat(abs);
        files.push(`${path.relative(projectRoot, abs)}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await collect(projectRoot);
  files.sort();
  return crypto.createHash('sha256').update(files.join('\n')).digest('hex');
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

// tectonic process runner, with an optional onChunk callback used to stream
// stdout/stderr live to any connected SSE clients as the process runs (see
// beginCompileJob above).
function runTectonicStream(args, cwd, onChunk = null) {
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

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onChunk) onChunk(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (onChunk) onChunk(chunk);
    });

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

if (require.main === module) {
  ensureProjectsRoot()
    .catch((err) => {
      console.error('Failed to set up projects/ directory:', err.message);
    })
    .finally(() => {
      server.listen(PORT, () => {
        console.log(`latex-cowrite listening on http://localhost:${PORT}`);
      });
    });
}

module.exports = {
  normalizeProjectSettings,
};