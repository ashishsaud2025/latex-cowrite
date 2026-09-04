'use strict';

const path = require('path');
const fs = require('fs/promises');
const { PROJECTS_ROOT, TEXT_EXTENSIONS, PROJECT_NAME_RE } = require('./constants');

// Returns the absolute project root for a name, or null if the name is unsafe.
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
  return require('crypto').createHash('sha256').update(files.join('\n')).digest('hex');
}

// Recursive listing of all project folder names.
async function listProjectNames() {
  const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

module.exports = {
  PROJECTS_ROOT,
  projectRootFor,
  projectExists,
  resolveSafePath,
  isTextEditable,
  buildTree,
  findEntryFile,
  dirSizeBytes,
  getProjectFingerprint,
  listProjectNames,
};
