'use strict';

// DOM refs
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
const editorPane = document.getElementById('editor-pane');
const previewPane = document.getElementById('preview-pane');
const treeSidebar = document.getElementById('tree-sidebar');
const treeResizer = document.getElementById('tree-resizer');
const paneResizer = document.getElementById('pane-resizer');
const logResizer = document.getElementById('log-resizer');
const collaborationStatus = document.getElementById('collaboration-status');
let pdfObjectUrl = null;

function loadWorkspaceSize(name, fallback) {
  const value = Number(localStorage.getItem(`longtex-${name}`));
  return Number.isFinite(value) ? value : fallback;
}

function saveWorkspaceSize(name, value) {
  localStorage.setItem(`longtex-${name}`, String(Math.round(value)));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setupResizeHandle(handle, direction, getBounds, applySize, storageName, initialSize) {
  const setSize = (size, persist = false) => {
    const bounds = getBounds();
    const nextSize = clamp(size, bounds.min, bounds.max);
    applySize(nextSize);
    handle.setAttribute('aria-valuenow', Math.round(nextSize));
    if (persist) saveWorkspaceSize(storageName, nextSize);
  };

  setSize(loadWorkspaceSize(storageName, initialSize));
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startPosition = direction === 'x' ? event.clientX : event.clientY;
    const startSize = direction === 'x'
      ? handle.previousElementSibling.getBoundingClientRect().width
      : handle.parentElement.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');

    const move = (moveEvent) => {
      const position = direction === 'x' ? moveEvent.clientX : moveEvent.clientY;
      setSize(startSize + position - startPosition);
    };
    const stop = () => {
      const size = direction === 'x'
        ? handle.previousElementSibling.getBoundingClientRect().width
        : handle.parentElement.getBoundingClientRect().height;
      setSize(size, true);
      document.body.classList.remove('is-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });

  handle.addEventListener('keydown', (event) => {
    const increment = event.shiftKey ? 50 : 10;
    const change = ['ArrowRight', 'ArrowDown'].includes(event.key) ? increment
      : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -increment : 0;
    if (!change) return;
    event.preventDefault();
    const currentSize = direction === 'x'
      ? handle.previousElementSibling.getBoundingClientRect().width
      : handle.parentElement.getBoundingClientRect().height;
    setSize(currentSize + change, true);
  });
}

const mainEl = document.querySelector('main');
setupResizeHandle(treeResizer, 'x', () => ({
  min: 150,
  max: Math.max(260, editorPane.clientWidth - 220),
}), (size) => {
  treeSidebar.style.width = `${size}px`;
}, 'tree-width', 220);

setupResizeHandle(paneResizer, 'x', () => ({
  min: 320,
  max: Math.max(420, mainEl.clientWidth - 320),
}), (size) => {
  editorPane.style.flexBasis = `${size}px`;
}, 'editor-width', mainEl.clientWidth / 2);

setupResizeHandle(logResizer, 'y', () => ({
  min: 70,
  max: Math.max(140, previewPane.clientHeight * 0.7),
}), (size) => {
  logPanel.style.height = `${size}px`;
}, 'log-height', 220);

// Editor
const cm = CodeMirror.fromTextArea(document.getElementById('source'), {
  mode: 'stex',
  theme: 'eclipse',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentUnit: 2,
});

// State
let currentProject = null;
let currentFile = null; // { path, editable }
let expandedFolders = new Set();
let dirty = false;
let suppressChangeEvents = false;

// Real-time collaboration (Yjs)
// Loaded from the pre-bundled public/collab-bundle.js as window.Collab.
const { Y, WebsocketProvider, CodemirrorBinding } = window.Collab;

// Same collaborator color palette as before; colors are now chosen client-side
// from each tab's Yjs client ID instead of being assigned by the server.
const COLLABORATOR_COLORS = ['#d6336c', '#1971c2', '#2f9e44', '#e67700', '#7048e8', '#0c8599', '#c2255c', '#5f3dc4'];

// Short cosmetic label shown next to remote cursors.
const collaboratorLabel = Math.random().toString(36).slice(2, 8);

// Yjs state for the currently open file; only one set exists at a time.
let currentYDoc = null;
let currentProvider = null;
let currentBinding = null;

function setCollaborationStatus(text, kind = 'unknown') {
  collaborationStatus.textContent = text;
  collaborationStatus.className = `status-pill status-${kind}`;
}

// Clean up the current Yjs document, binding, and WebSocket connection.
function teardownCollaboration() {
  if (currentBinding) {
    currentBinding.destroy();
    currentBinding = null;
  }

  if (currentProvider) {
    currentProvider.destroy(); // Also closes the underlying WebSocket.
    currentProvider = null;
  }

  if (currentYDoc) {
    currentYDoc.destroy();
    currentYDoc = null;
  }
}

// Open real-time collaboration for a file using a dedicated Yjs room.
// The room matches the server's project/file key.
function openCollaboration(projectName, filePath) {
  teardownCollaboration();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseUrl = `${protocol}//${location.host}/collaboration/${encodeURIComponent(projectName)}`;

  currentYDoc = new Y.Doc();
  currentProvider = new WebsocketProvider(baseUrl, encodeURIComponent(filePath), currentYDoc);

  currentProvider.awareness.setLocalStateField('user', {
    name: collaboratorLabel,
    color: COLLABORATOR_COLORS[currentYDoc.clientID % COLLABORATOR_COLORS.length],
  });

  const thisProvider = currentProvider;

  currentProvider.on('status', ({ status }) => {
    if (currentProvider !== thisProvider) return;

    if (status === 'connected') setCollaborationStatus('collaborating', 'ok');
    else if (status === 'connecting') setCollaborationStatus('connecting…', 'unknown');
    else setCollaborationStatus('reconnecting…', 'unknown');
  });

  currentProvider.on('connection-error', () => {
    if (currentProvider !== thisProvider) return;
    setCollaborationStatus('offline', 'missing');
  });

  const ytext = currentYDoc.getText('content');

  // CodemirrorBinding initially sets the editor content from Y.Text.
  // Suppress dirty tracking so opening a file does not mark it as unsaved.
  suppressChangeEvents = true;
  currentBinding = new CodemirrorBinding(ytext, cm, currentProvider.awareness);
  suppressChangeEvents = false;
}

function setDirty(value) {
  dirty = value;
  dirtyIndicator.classList.toggle('hidden', !dirty);
  saveBtn.disabled = !dirty;
  saveBtn.classList.toggle('dirty', dirty);
}

// y-codemirror uses this origin for remote edits, so they don't mark the file dirty.
// Only edits made locally should trigger the "unsaved changes" indicator.
const REMOTE_EDIT_ORIGIN = 'y-codemirror';

cm.on('change', (instance, changeObj) => {
  if (suppressChangeEvents) return;
  if (changeObj && changeObj.origin === REMOTE_EDIT_ORIGIN) return;

  if (currentFile && currentFile.editable) {
    setDirty(true);
  }
});

// tectonic status
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

// Projects
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
  teardownCollaboration();
  setCollaborationStatus('no file open', 'unknown');
  currentProject = name;
  currentFile = null;
  expandedFolders = new Set();
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

// File tree
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

  const actions = document.createElement('span');
  actions.className = 'tree-row-actions';
  if (node.type === 'dir') {
    const addFileButton = createTreeActionButton('+', `Create file in ${node.path}`);
    addFileButton.addEventListener('click', (event) => {
      event.stopPropagation();
      createEntry('file', node.path);
    });
    actions.appendChild(addFileButton);
  }
  const renameButton = createTreeActionButton('R', `Rename ${node.name}`);
  renameButton.addEventListener('click', (event) => {
    event.stopPropagation();
    renameEntry(node);
  });
  actions.appendChild(renameButton);
  const deleteButton = createTreeActionButton('x', `Delete ${node.name}`);
  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteEntry(node);
  });
  actions.appendChild(deleteButton);
  row.appendChild(actions);

  container.appendChild(row);

  if (node.type === 'dir') {
    const childrenWrap = renderNodeChildren(node.children);
    childrenWrap.className = 'tree-children';
    const expanded = expandedFolders.has(node.path);
    childrenWrap.style.display = expanded ? '' : 'none';
    icon.textContent = expanded ? '📂' : '📁';
    container.appendChild(childrenWrap);

    row.addEventListener('click', () => {
      const isExpanded = childrenWrap.style.display !== 'none';
      childrenWrap.style.display = isExpanded ? 'none' : '';
      icon.textContent = isExpanded ? '📁' : '📂';
      if (isExpanded) expandedFolders.delete(node.path);
      else expandedFolders.add(node.path);
    });
  } else {
    row.addEventListener('click', () => openFile(node));
  }

  return container;
}

function createTreeActionButton(text, label) {
  const button = document.createElement('button');
  button.className = 'tree-action';
  button.type = 'button';
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

// Open / save file
async function openFile(node) {
  if (dirty) {
    const proceed = confirm(`Discard unsaved changes to "${currentFile.path}"?`);
    if (!proceed) return;
  }

  if (!node.editable) {
    teardownCollaboration();
    setCollaborationStatus('not editable', 'unknown');
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
  // Tear down the previous file's binding before changing cm's content.
  // Otherwise, the old binding could treat the new file's content as an edit.
  teardownCollaboration();

  // Temporary fallback content; openCollaboration() immediately replaces it
  // with the shared Y.Text content when the new binding is created.

  suppressChangeEvents = true;
  cm.setValue(data.content);
  suppressChangeEvents = false;
  cm.setOption('readOnly', false);
  setDirty(false);
  openCollaboration(currentProject, node.path);
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

// New file / folder
async function createEntry(type, parentPath = '') {
  if (!currentProject) return;
  const label = type === 'dir' ? 'folder' : 'file';
  const promptText = parentPath
    ? `Name for new ${label} inside "${parentPath}":`
    : `Path for new ${label} (relative to project root, e.g. "sections/new.tex"): `;
  const name = prompt(promptText);
  if (!name) return;
  const relPath = parentPath ? `${parentPath}/${name}` : name;

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
  if (parentPath) expandedFolders.add(parentPath);
  await loadTree();
  if (type === 'file' && isTextEditableClientSide(relPath)) {
    openFile({ path: relPath, editable: true, name: relPath.split('/').pop() });
  }
}

async function renameEntry(node) {
  const nextName = prompt(`Rename "${node.name}" to:`, node.name);
  if (!nextName || nextName === node.name) return;
  const parentPath = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
  const newPath = parentPath ? `${parentPath}/${nextName}` : nextName;
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/entries`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: node.path, newPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not rename entry.');
    return;
  }
  if (currentFile && (currentFile.path === node.path || currentFile.path.startsWith(`${node.path}/`))) {
    currentFile.path = currentFile.path === node.path
      ? newPath
      : `${newPath}${currentFile.path.slice(node.path.length)}`;
    activeFileNameEl.textContent = currentFile.path;
    if (currentFile.editable) {
      // The room key is `${project}::${path}`, so a rename needs a fresh
      // connection under the new path -- otherwise this tab would keep
      // talking to the (now-orphaned) room for the old path.
      openCollaboration(currentProject, currentFile.path);
    }
  }
  await loadTree();
}

async function deleteEntry(node) {
  const suffix = node.type === 'dir' ? ' and everything inside it' : '';
  if (!confirm(`Delete "${node.path}"${suffix}?`)) return;
  const res = await fetch(`/api/projects/${encodeURIComponent(currentProject)}/entries`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: node.path }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not delete entry.');
    return;
  }
  if (currentFile && (currentFile.path === node.path || currentFile.path.startsWith(`${node.path}/`))) {
    teardownCollaboration();
    setCollaborationStatus('no file open', 'unknown');
    currentFile = null;
    activeFileNameEl.textContent = 'No file open';
    suppressChangeEvents = true;
    cm.setValue('');
    suppressChangeEvents = false;
    cm.setOption('readOnly', true);
    setDirty(false);
  }
  await loadTree();
}

function isTextEditableClientSide(relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  return ['.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log'].includes(ext);
}

newFileBtn.addEventListener('click', () => createEntry('file'));
newFolderBtn.addEventListener('click', () => createEntry('dir'));

// Compile
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

function renderPdf(arrayBuffer) {
  pdfContainer.innerHTML = '';
  if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
  pdfObjectUrl = URL.createObjectURL(new Blob([arrayBuffer], { type: 'application/pdf' }));

  const viewer = document.createElement('iframe');
  viewer.className = 'pdf-viewer';
  viewer.title = 'Compiled PDF preview';
  viewer.src = pdfObjectUrl;
  pdfContainer.appendChild(viewer);
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
      const cached = res.headers.get('X-Compile-Cached') === 'true';
      const buf = await res.arrayBuffer();
      document.getElementById('pdf-placeholder')?.remove();
      renderPdf(buf);
      setToolbar(cached ? `Loaded cached ${entry}.` : `Compiled ${entry} successfully.`, 'ok');
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

// Init
refreshTectonicStatus();
loadProjects();