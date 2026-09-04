'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const {
  COMPILE_TIMEOUT_MS,
  ONLY_CACHED,
  MAX_PROJECT_BYTES,
} = require('./constants');
const { projectRootFor, projectExists, getProjectFingerprint } = require('./projects');

const compileWorkspaces = new Map();
const compileLocks = new Map();
const compileCache = new Map();
const compileJobs = new Map();

// tectonic availability check
function checkTectonicAvailable() {
  const result = spawnSync('tectonic', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return { available: false, detail: result.error ? result.error.message : result.stderr };
  }
  return { available: true, detail: result.stdout.trim() };
}

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

function formatCompileDuration(durationMs) {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function finalizeCompileJob(job, status, payload = {}) {
  job.status = status;
  Object.assign(job, payload);
  if (job.durationMs == null) {
    job.durationMs = Number(process.hrtime.bigint() - job.startedAt) / 1e6;
  }
  if (job.log && !job.log.includes('Total compilation time:')) {
    job.log = `${job.log.replace(/\s*$/, '')}\n\nTotal compilation time: ${formatCompileDuration(job.durationMs)}`;
  }
  emitJobEvent(job, 'status', {
    status,
    entry: job.entry,
    error: job.error || null,
    log: job.log || '',
    cached: !!job.cached,
    hasPdf: !!job.pdf,
    durationMs: job.durationMs,
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
    startedAt: process.hrtime.bigint(),
    durationMs: null,
    clients: new Set(),
    cached: false,
  };
  compileJobs.set(job.id, job);

  if (cached && cached.entry === entryRel && cached.fingerprint === fingerprint && cached.synctex) {
    job.cached = true;
    job.pdf = cached.pdf;
    job.synctex = cached.synctex;
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
          '--synctex',
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
        const synctexPath = path.join(tmpDir, `${path.basename(entryRel, '.tex')}.synctex.gz`);

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
        const synctex = await fs.readFile(synctexPath).catch(() => null);
        if (await getProjectFingerprint(root) === job.fingerprint) {
          compileCache.set(projectName, {
            entry: entryRel,
            fingerprint: job.fingerprint,
            pdf,
            synctex,
          });
        }
        job.pdf = pdf;
        job.synctex = synctex;
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

// tectonic process runner, with an optional onChunk callback used to stream
// stdout/stderr live to any connected SSE clients as the process runs.
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

module.exports = {
  checkTectonicAvailable,
  beginCompileJob,
  compileJobs,
  MAX_PROJECT_BYTES,
};
