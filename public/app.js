'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const projectSelect = document.getElementById('project-select');
const newProjectBtn = document.getElementById('new-project-btn');
const treeContainer = document.getElementById('tree-container');
const newFileBtn = document.getElementById('new-file-btn');
const newFolderBtn = document.getElementById('new-folder-btn');
const activeFileNameEl = document.getElementById('active-file-name');
const dirtyIndicator = document.getElementById('dirty-indicator');
const saveBtn = document.getElementById('save-btn');
const compileBtn = document.getElementById('compile-btn');
const compileStateEl = document.getElementById('compile-state');
const toolbarEl = document.getElementById('preview-toolbar');
const pdfContainer = document.getElementById('pdf-container');
const logPanel = document.getElementById('log-panel');
const logContent = document.getElementById('log-content');
const logClose = document.getElementById('log-close');
const statusPill = document.getElementById('tectonic-status');

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
const cm = CodeMirror.fromTextArea(document.getElementById('source'), {
  mode: 'stex',
  theme: 'eclipse',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentUnit: 2,
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentProject = null;
let currentFile = null; // { path, editable }
let dirty = false;
let suppressChangeEvents = false;

cm.on('change', () => {
  if (suppressChangeEvents) return;
  if (currentFile && currentFile.editable) setDirty(true);
});

function setDirty(value) {
  dirty = value;
  dirtyIndicator.classList.toggle('hidden', !dirty);
  saveBtn.disabled = !dirty;
  saveBtn.classList.toggle('dirty', dirty);
}

// ---------------------------------------------------------------------------
// tectonic status
// ---------------------------------------------------------------------------
async function refreshTectonicStatus() {
  try {
    const res = await fetch('/api/tectonic-status');
    const data = await res.json();
    if (data.available) {
      statusPill.textContent = 'tectonic ready';
      statusPill.className = 'status-pill status-ok';
    } else {
      statusPill.textContent = 'tectonic NOT installed';
      statusPill.className = 'status-pill status-missing';
    }
  } catch {
    statusPill.textContent = 'status unknown';
    statusPill.className = 'status-pill status-unknown';
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
async function loadProjects(selectName) {
  const res = await fetch('/api/projects');
  const data = await res.json();
  const projects = data.projects || [];

  projectSelect.innerHTML = '';
  for (const name of projects) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    projectSelect.appendChild(opt);
  }

  const toSelect = selectName && projects.includes(selectName) ? selectName : projects[0];
  if (toSelect) {
    projectSelect.value = toSelect;
    await switchProject(toSelect);
  }
}

async function switchProject(name) {
  currentProject = name;
  currentFile = null;
  setDirty(false);
  activeFileNameEl.textContent = 'No file open';
  suppressChangeEvents = true;
  cm.setValue('');
  suppressChangeEvents = false;
  cm.setOption('readOnly', true);
  await loadTree();
}

projectSelect.addEventListener('change', () => switchProject(projectSelect.value));

newProjectBtn.addEventListener('click', async () => {
  const name = prompt('New project name (letters, numbers, - and _ only):');
  if (!name) return;
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not create project.');
    return;
  }
  await loadProjects(name);
});

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------
async function loadTree() {
  if (!currentProject) return;
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/tree`);
  const data = await res.json();
  treeContainer.innerHTML = '';
  if (!res.ok) {
    treeContainer.textContent = data.error || 'Could not load project tree.';
    return;
  }
  treeContainer.appendChild(renderNodeChildren(data.children));
}

function renderNodeChildren(children) {
  const wrap = document.createElement('div');
  for (const node of children) {
    wrap.appendChild(renderNode(node));
  }
  return wrap;
}

function renderNode(node) {
  const container = document.createElement('div');
  container.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  if (node.type === 'file' && !node.editable) row.classList.add('non-editable');
  if (node.type === 'file' && currentFile && currentFile.path === node.path) row.classList.add('active');

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = node.type === 'dir' ? '📁' : '📄';
  row.appendChild(icon);

  const label = document.createElement('span');
  label.textContent = node.name;
  row.appendChild(label);

  container.appendChild(row);

  if (node.type === 'dir') {
    const childrenWrap = renderNodeChildren(node.children);
    childrenWrap.className = 'tree-children';
    container.appendChild(childrenWrap);

    row.addEventListener('click', () => {
      childrenWrap.style.display = childrenWrap.style.display === 'none' ? '' : 'none';
      icon.textContent = childrenWrap.style.display === 'none' ? '📁' : '📂';
    });
  } else {
    row.addEventListener('click', () => openFile(node));
  }

  return container;
}

// ---------------------------------------------------------------------------
// Open / save file
// ---------------------------------------------------------------------------
async function openFile(node) {
  if (dirty) {
    const proceed = confirm(`Discard unsaved changes to "${currentFile.path}"?`);
    if (!proceed) return;
  }

  if (!node.editable) {
    currentFile = { path: node.path, editable: false };
    activeFileNameEl.textContent = `${node.path} (not editable)`;
    suppressChangeEvents = true;
    cm.setValue(`"${node.name}" is not a text file this app can edit (binary or unrecognized type).`);
    suppressChangeEvents = false;
    cm.setOption('readOnly', true);
    setDirty(false);
    loadTree();
    return;
  }

  const res = await fetch(
    `/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(node.path)}`
  );
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not open file.');
    return;
  }

  currentFile = { path: node.path, editable: true };
  activeFileNameEl.textContent = node.path;
  suppressChangeEvents = true;
  cm.setValue(data.content);
  suppressChangeEvents = false;
  cm.setOption('readOnly', false);
  setDirty(false);
  loadTree();
}

async function saveCurrentFile() {
  if (!currentFile || !currentFile.editable || !currentProject) return false;
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentFile.path, content: cm.getValue() }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not save file.');
    return false;
  }
  setDirty(false);
  return true;
}

saveBtn.addEventListener('click', saveCurrentFile);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    compile();
  }
});

// ---------------------------------------------------------------------------
// New file / folder
// ---------------------------------------------------------------------------
async function createEntry(type) {
  if (!currentProject) return;
  const label = type === 'dir' ? 'folder' : 'file';
  const relPath = prompt(`Path for new ${label} (relative to project root, e.g. "sections/new.tex"):`);
  if (!relPath) return;

  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, type }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || `Could not create ${label}.`);
    return;
  }
  await loadTree();
  if (type === 'file' && isTextEditableClientSide(relPath)) {
    openFile({ path: relPath, editable: true, name: relPath.split('/').pop() });
  }
}

function isTextEditableClientSide(relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  return ['.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log'].includes(ext);
}

newFileBtn.addEventListener('click', () => createEntry('file'));
newFolderBtn.addEventListener('click', () => createEntry('dir'));

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------
function setToolbar(text, kind) {
  toolbarEl.textContent = text;
  toolbarEl.className = kind || '';
}

function showLog(text) {
  logContent.textContent = text || '(empty)';
  logPanel.classList.remove('hidden');
}

function hideLog() {
  logPanel.classList.add('hidden');
}

logClose.addEventListener('click', hideLog);

async function renderPdf(arrayBuffer) {
  pdfContainer.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.4 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    pdfContainer.appendChild(canvas);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

async function compile() {
  if (!currentProject) return;

  // Compiling stale disk content while the editor shows unsaved changes
  // would be confusing, so save first if needed.
  if (dirty) {
    const saved = await saveCurrentFile();
    if (!saved) return;
  }

  compileBtn.disabled = true;
  compileBtn.textContent = 'Compiling…';
  setToolbar('Compiling…', '');
  hideLog();

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/compile`, {
      method: 'POST',
    });
    const contentType = res.headers.get('Content-Type') || '';

    if (res.ok && contentType.includes('application/pdf')) {
      const entry = res.headers.get('X-Compiled-Entry') || '';
      const buf = await res.arrayBuffer();
      document.getElementById('pdf-placeholder')?.remove();
      await renderPdf(buf);
      setToolbar(`Compiled ${entry} successfully.`, 'ok');
      hideLog();
    } else {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}`, log: '' }));
      setToolbar(data.error || 'Compile failed.', 'error');
      showLog(data.log || '');
      refreshTectonicStatus();
    }
  } catch (err) {
    setToolbar(`Request failed: ${err.message}`, 'error');
    showLog(String(err.stack || err));
  } finally {
    compileBtn.disabled = false;
    compileBtn.textContent = 'Compile';
  }
}

compileBtn.addEventListener('click', compile);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
refreshTectonicStatus();
loadProjects();
