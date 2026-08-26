'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const COMPILE_TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024; // 2MB of LaTeX source is already a lot

// If true, adds --only-cached so tectonic refuses to reach out to the network
// for *any* package it doesn't already have cached, instead of silently
// fetching. This does NOT sandbox the network at the OS level (see README /
// the note at the bottom of this file) -- it only stops tectonic itself from
// trying. Off by default because most fresh installs need one online
// compile to warm the bundle cache; flip it on once you've done that.
const ONLY_CACHED = process.env.TECTONIC_ONLY_CACHED === '1';

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Startup check: does `tectonic` exist on PATH at all? We check once at boot
// so the failure is loud and obvious in server logs, and again lazily on
// every compile request so the frontend gets a clear error instead of a
// generic 500 if it's missing or gets uninstalled later.
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
  console.warn(' (macOS: brew install tectonic | Debian/Ubuntu: check your distro repo');
  console.warn('  or grab a release binary from the GitHub releases page.)');
  console.warn('=================================================================');
} else {
  console.log(`tectonic found: ${startupCheck.detail}`);
}

// Lets the frontend show a banner instead of just failing the first compile.
app.get('/api/tectonic-status', (req, res) => {
  const status = checkTectonicAvailable();
  res.json(status);
});

// POST /api/compile
// Body: { source: string }
// Success: 200, Content-Type: application/pdf, raw PDF bytes
// Failure: 4xx/5xx, JSON: { error: string, log: string }
app.post('/api/compile', async (req, res) => {
  const source = req.body && req.body.source;

  if (typeof source !== 'string' || source.trim().length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "source" string.', log: '' });
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return res.status(413).json({ error: `Source exceeds ${MAX_SOURCE_BYTES} byte limit.`, log: '' });
  }

  const status = checkTectonicAvailable();
  if (!status.available) {
    return res.status(500).json({
      error: 'tectonic is not installed or not on PATH on the server. See server logs.',
      log: '',
    });
  }

  // One temp dir per compile. This is our sandbox boundary: tectonic is
  // pointed at this directory as both cwd and output dir, and it's the only
  // thing we delete/rely on afterwards -- we never touch a user-supplied
  // path.
  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `texcomp-${jobId}-`));
  const texPath = path.join(tmpDir, 'main.tex');
  const pdfPath = path.join(tmpDir, 'main.pdf');
  const logPath = path.join(tmpDir, 'main.log');

  try {
    await fs.writeFile(texPath, source, 'utf8');

    const args = [
      '--untrusted',   // hard-disables shell-escape and other unsafe features,
                        // overriding anything the document itself requests
      '-o', tmpDir,
      '--keep-logs',
      '--reruns', '1',
    ];
    if (ONLY_CACHED) args.push('--only-cached');
    args.push(texPath);

    const result = await runTectonic(args, tmpDir);

    if (result.timedOut) {
      const log = await readIfExists(logPath);
      return res.status(504).json({
        error: `Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s.`,
        log: combineLog(result.stdout, result.stderr, log),
      });
    }

    if (result.code !== 0) {
      const log = await readIfExists(logPath);
      return res.status(422).json({
        error: `tectonic exited with code ${result.code}.`,
        log: combineLog(result.stdout, result.stderr, log),
      });
    }

    const pdfExists = await fs
      .access(pdfPath)
      .then(() => true)
      .catch(() => false);

    if (!pdfExists) {
      const log = await readIfExists(logPath);
      return res.status(422).json({
        error: 'tectonic reported success but produced no PDF.',
        log: combineLog(result.stdout, result.stderr, log),
      });
    }

    const pdf = await fs.readFile(pdfPath);
    res.set('Content-Type', 'application/pdf');
    return res.status(200).send(pdf);
  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}`, log: '' });
  } finally {
    // Always clean up, success or failure.
    fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      console.error(`Failed to remove temp dir ${tmpDir}:`, err.message);
    });
  }
});

/**
 * Spawn tectonic with no shell, a fixed cwd, and a hard timeout.
 * shell:false (the default for spawn) is important -- it means args are
 * passed straight to execve, not interpreted by /bin/sh, so nothing in the
 * LaTeX source or filenames can smuggle in extra shell commands.
 */
function runTectonic(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('tectonic', args, {
      cwd,
      shell: false,
      // Own process group so a timeout can kill tectonic *and* anything it
      // spawns (e.g. if a package ever shells out). Killing just child.pid
      // only gets the direct child -- any grandchild keeps running, and
      // since it inherits the stdout/stderr pipes, node's 'close' event
      // would then hang until that grandchild exits on its own, defeating
      // the timeout. Listening on 'exit' + killing the group avoids both
      // problems.
      detached: true,
      env: {
        // Minimal env. Keep PATH so tectonic can find its own resources;
        // drop everything else the parent process happens to have.
        PATH: process.env.PATH,
        HOME: process.env.HOME, // tectonic caches its bundle under $HOME/.cache
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL'); // negative pid = whole group
      } catch {
        child.kill('SIGKILL'); // fallback if the group is already gone
      }
    }, COMPILE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
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
  if (texLog) parts.push('--- main.log ---\n' + texLog);
  if (stdout) parts.push('--- stdout ---\n' + stdout);
  if (stderr) parts.push('--- stderr ---\n' + stderr);
  return parts.join('\n\n') || '(no output captured)';
}

app.listen(PORT, () => {
  console.log(`latex-editor-mvp listening on http://localhost:${PORT}`);
});
