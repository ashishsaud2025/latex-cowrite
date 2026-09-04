'use strict';

import { dom } from './dom.js';
import { cm, setDirty } from './editor.js';
import { state } from './state.js';
import { refreshProjectSettings } from './settings.js';
import {
  openCollaboration,
  openProjectSettingsSync,
  teardownFileCollaboration,
  teardownProjectSettingsSync,
  updatePresence,
  setCollaborationStatus,
} from './collaboration.js';

export function isTextEditableClientSide(relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  return ['.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log'].includes(ext);
}

// ---------------------------------------------------------------------------
// Project listing and switching
// ---------------------------------------------------------------------------

export async function loadProjects(selectName) {
  const res = await fetch('/api/projects');
  const data = await res.json();
  const projects = data.projects || [];

  dom.projectSelect.innerHTML = '';
  for (const name of projects) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    dom.projectSelect.appendChild(opt);
  }

  const toSelect = selectName && projects.includes(selectName) ? selectName : projects[0];
  if (toSelect) {
    dom.projectSelect.value = toSelect;
    await switchProject(toSelect);
  }
}

export async function switchProject(name) {
  teardownFileCollaboration();
  teardownProjectSettingsSync();
  setCollaborationStatus('no file open', 'unknown');
  state.currentProject = name;
  state.currentFile = null;
  state.expandedFolders = new Set();
  state.dirty = false;
  setDirty(false);
  dom.activeFileNameEl.textContent = 'No file open';
  state.suppressChangeEvents = true;
  cm.setValue('');
  state.suppressChangeEvents = false;
  cm.setOption('readOnly', true);
  await refreshProjectSettings();
  openProjectSettingsSync(name);
  await loadTree();
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export async function loadTree() {
  if (!state.currentProject) return;
  const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/tree`);
  const data = await res.json();
  dom.treeContainer.innerHTML = '';
  if (!res.ok) {
    dom.treeContainer.textContent = data.error || 'Could not load project tree.';
    return;
  }
  state.projectTree = data.children || [];
  dom.treeContainer.appendChild(renderNodeChildren(data.children));
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
  if (node.type === 'file' && state.currentFile && state.currentFile.path === node.path) row.classList.add('active');

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
    const expanded = state.expandedFolders.has(node.path);
    childrenWrap.style.display = expanded ? '' : 'none';
    icon.textContent = expanded ? '📂' : '📁';
    container.appendChild(childrenWrap);

    row.addEventListener('click', () => {
      const isExpanded = childrenWrap.style.display !== 'none';
      childrenWrap.style.display = isExpanded ? 'none' : '';
      icon.textContent = isExpanded ? '📁' : '📂';
      if (isExpanded) state.expandedFolders.delete(node.path);
      else state.expandedFolders.add(node.path);
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

// ---------------------------------------------------------------------------
// Open / save file
// ---------------------------------------------------------------------------

export async function openFile(node) {
  if (state.dirty) {
    const saved = await saveCurrentFile();
    if (!saved) return;
  }

  if (!node.editable) {
    teardownFileCollaboration();
    updatePresence();
    setCollaborationStatus('not editable', 'unknown');
    state.currentFile = { path: node.path, editable: false };
    dom.activeFileNameEl.textContent = `${node.path} (not editable)`;
    state.suppressChangeEvents = true;
    cm.setValue(`"${node.name}" is not a text file this app can edit (binary or unrecognized type).`);
    state.suppressChangeEvents = false;
    cm.setOption('readOnly', true);
    setDirty(false);
    loadTree();
    return;
  }

  const res = await fetch(
    `/api/projects/${encodeURIComponent(state.currentProject)}/file?path=${encodeURIComponent(node.path)}`
  );
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not open file.');
    return;
  }

  state.currentFile = { path: node.path, editable: true };
  updatePresence(node.path);
  dom.activeFileNameEl.textContent = node.path;
  // Tear down the previous file's binding before touching cm's content --
  // otherwise a stray setValue() gets pushed into its shared Y.Text.
  teardownFileCollaboration();
  // Immediately superseded by openCollaboration's binding below; kept as a
  // same-tick fallback in case binding setup fails.
  state.suppressChangeEvents = true;
  cm.setValue(data.content);
  state.suppressChangeEvents = false;
  cm.setOption('readOnly', false);
  setDirty(false);
  openCollaboration(state.currentProject, node.path);
  updatePresence(node.path, cm.getScrollInfo().top);
  loadTree();
}

export async function saveCurrentFile() {
  if (!state.currentFile || !state.currentFile.editable || !state.currentProject) return false;
  const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.currentFile.path, content: cm.getValue() }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not save file.');
    return false;
  }
  setDirty(false);
  return true;
}

// ---------------------------------------------------------------------------
// New file / folder / rename / delete
// ---------------------------------------------------------------------------

export async function createEntry(type, parentPath = '') {
  if (!state.currentProject) return;
  const label = type === 'dir' ? 'folder' : 'file';
  const promptText = parentPath
    ? `Name for new ${label} inside "${parentPath}":`
    : `Path for new ${label} (relative to project root, e.g. "sections/new.tex"): `;
  const name = prompt(promptText);
  if (!name) return;
  const relPath = parentPath ? `${parentPath}/${name}` : name;

  const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: relPath, type }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || `Could not create ${label}.`);
    return;
  }
  if (parentPath) state.expandedFolders.add(parentPath);
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
  const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/entries`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: node.path, newPath }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not rename entry.');
    return;
  }
  if (state.currentFile && (state.currentFile.path === node.path || state.currentFile.path.startsWith(`${node.path}/`))) {
    state.currentFile.path = state.currentFile.path === node.path
      ? newPath
      : `${newPath}${state.currentFile.path.slice(node.path.length)}`;
    dom.activeFileNameEl.textContent = state.currentFile.path;
    if (state.currentFile.editable) {
      updatePresence(state.currentFile.path, cm.getScrollInfo().top);
      // Room key is `${project}::${path}`, so rename needs a fresh connection
      // under the new path or this tab keeps talking to the orphaned room.
      openCollaboration(state.currentProject, state.currentFile.path);
    }
  }
  await loadTree();
}

async function deleteEntry(node) {
  const suffix = node.type === 'dir' ? ' and everything inside it' : '';
  if (!confirm(`Delete "${node.path}"${suffix}?`)) return;
  const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/entries`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: node.path }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Could not delete entry.');
    return;
  }
  if (state.currentFile && (state.currentFile.path === node.path || state.currentFile.path.startsWith(`${node.path}/`))) {
    teardownFileCollaboration();
    setCollaborationStatus('no file open', 'unknown');
    state.currentFile = null;
    dom.activeFileNameEl.textContent = 'No file open';
    state.suppressChangeEvents = true;
    cm.setValue('');
    state.suppressChangeEvents = false;
    cm.setOption('readOnly', true);
    setDirty(false);
  }
  await loadTree();
}
