'use strict';

import { dom } from './dom.js';
import { cm } from './editor.js';
import { state } from './state.js';
import { applyProjectSettingsToEditor, syncClipboardToggle, normalizeProjectSettings, getAllowSharedClipboard, refreshProjectSettings } from './settings.js';
import { openFile } from './projects.js';

// Yjs pieces (Y, WebsocketProvider, CodemirrorBinding, Awareness) come from
// the pre-bundled public/collab-bundle.js, exposed as window.Collab.
const { Y, WebsocketProvider, CodemirrorBinding } = window.Collab;

// Same palette the old server-assigned colors used, but now picked
// client-side (deterministically from each tab's Yjs client ID).
const COLLABORATOR_COLORS = ['#d6336c', '#1971c2', '#2f9e44', '#e67700', '#7048e8', '#0c8599', '#c2255c', '#5f3dc4'];
const COLLABORATOR_ICONS = ['✦', '◆', '●', '▲', '■', '✚', '★', '⬢'];
// A short, friendly label shown next to remote cursors -- purely cosmetic,
// unrelated to the Yjs/websocket protocol itself.
const collaboratorLabel = Math.random().toString(36).slice(2, 8);
const collaboratorIcon = COLLABORATOR_ICONS[Math.floor(Math.random() * COLLABORATOR_ICONS.length)];

// The live Yjs pieces for whatever file is open; torn down before the next
// file/project opens so no WebsocketProvider connection leaks.
let currentYDoc = null;
let currentProvider = null;
let currentBinding = null;
let currentUndoManager = null;
let settingsYDoc = null;
let settingsProvider = null;
let settingsMap = null;
let settingsRefreshTimer = null;
let projectAwareness = null;
let followedCollaboratorId = null;
let followedCollaboratorFile = null;
let followOpenInProgress = false;
// The server's per-process ID (GET /api/server-instance-id), checked before
// letting a dropped connection auto-reconnect so a restart can be told apart
// from a brief blip before Yjs re-syncs. null means not yet checked.
let knownServerInstanceId = null;

function setCollaborationStatus(text, kind = 'unknown') {
  dom.collaborationStatus.textContent = text;
  dom.collaborationStatus.className = `status-pill status-${kind}`;
}

export { setCollaborationStatus };

// Tears down the Yjs doc/provider/binding for whatever file was previously
// open, if any. Safe to call even when nothing is open.
function teardownCollaboration() {
  if (currentBinding) {
    currentBinding.destroy();
    currentBinding = null;
  }
  if (currentUndoManager) {
    currentUndoManager.destroy();
    currentUndoManager = null;
  }
  if (currentProvider) {
    currentProvider.destroy(); // also closes the underlying WebSocket
    currentProvider = null;
  }
  if (currentYDoc) {
    currentYDoc.destroy();
    currentYDoc = null;
  }
}

function teardownProjectSettingsSync() {
  if (settingsRefreshTimer) {
    clearInterval(settingsRefreshTimer);
    settingsRefreshTimer = null;
  }
  if (settingsProvider) {
    settingsProvider.destroy();
    settingsProvider = null;
  }
  if (settingsYDoc) {
    settingsYDoc.destroy();
    settingsYDoc = null;
  }
  projectAwareness = null;
  followedCollaboratorId = null;
  followedCollaboratorFile = null;
  followOpenInProgress = false;
  renderCollaborators();
  settingsMap = null;
}

// ---------------------------------------------------------------------------
// Presence and collaborator following
// ---------------------------------------------------------------------------

function updateProjectPresence(filePath = null, scrollTop = 0) {
  if (!projectAwareness) return;
  projectAwareness.setLocalStateField('file', filePath);
  projectAwareness.setLocalStateField('scrollTop', filePath ? scrollTop : null);
}

function renderCollaborators() {
  if (!dom.collaboratorsEl) return;
  dom.collaboratorsEl.replaceChildren();
  if (!projectAwareness) return;

  const collaborators = [...projectAwareness.getStates().entries()]
    .map(([clientId, collabState]) => ({ clientId, ...collabState }))
    .filter(({ user }) => user && user.name && user.icon);
  if (!collaborators.some(({ clientId }) => clientId === followedCollaboratorId)) {
    followedCollaboratorId = null;
  }
  for (const collaborator of collaborators) {
    const button = document.createElement('button');
    const isCurrentUser = collaborator.clientId === settingsYDoc.clientID;
    const isFollowed = collaborator.clientId === followedCollaboratorId;
    const file = collaborator.file || '';
    button.className = `collaborator-profile${isCurrentUser ? ' current' : ''}${isFollowed ? ' following' : ''}`;
    button.type = 'button';
    button.textContent = collaborator.user.icon;
    button.style.setProperty('--collaborator-color', collaborator.user.color);
    button.title = isCurrentUser
      ? `${collaborator.user.name} (you)`
      : file ? `Follow ${collaborator.user.name} in ${file}` : `Follow ${collaborator.user.name}`;
    button.setAttribute('aria-label', button.title);
    if (!isCurrentUser && file) {
      button.addEventListener('click', () => {
        followedCollaboratorId = collaborator.clientId;
        renderCollaborators();
        followCollaboratorFile(collaborator.clientId, file);
      });
    }
    dom.collaboratorsEl.appendChild(button);
  }
}

async function followCollaboratorFile(clientId, filePath) {
  if (!filePath || followOpenInProgress) return;
  followedCollaboratorFile = filePath;
  followOpenInProgress = true;
  try {
    await openFile({
      path: filePath,
      editable: isTextEditableClientSide(filePath),
      name: filePath.split('/').pop(),
    });
  } finally {
    followOpenInProgress = false;
    const collabState = projectAwareness && projectAwareness.getStates().get(clientId);
    const latestFile = collabState && collabState.file;
    if (collabState && latestFile === followedCollaboratorFile && Number.isFinite(collabState.scrollTop)
      && state.currentFile && state.currentFile.path === latestFile) {
      cm.scrollTo(null, collabState.scrollTop);
    }
    if (latestFile && latestFile !== followedCollaboratorFile) {
      followCollaboratorFile(clientId, latestFile);
    }
  }
}

function handleProjectAwarenessChange() {
  renderCollaborators();
  if (!projectAwareness || !followedCollaboratorId || followOpenInProgress) return;
  const collabState = projectAwareness.getStates().get(followedCollaboratorId);
  if (collabState && collabState.file === followedCollaboratorFile && Number.isFinite(collabState.scrollTop)
    && state.currentFile && state.currentFile.path === collabState.file) {
    cm.scrollTo(null, collabState.scrollTop);
  }
  if (collabState && collabState.file && collabState.file !== followedCollaboratorFile) {
    followCollaboratorFile(followedCollaboratorId, collabState.file);
  }
}

export function stopFollowingCollaborator() {
  if (followedCollaboratorId === null) return;
  followedCollaboratorId = null;
  followedCollaboratorFile = null;
  renderCollaborators();
}

// Writes the shared-clipboard toggle into the settings room, which fans the
// change out to all open tabs and to the server for persistence.
export function setSharedClipboardEnabled(enabled) {
  if (!state.currentProject || !settingsYDoc || !settingsMap) return;
  const nextSettings = normalizeProjectSettings({
    ...normalizeProjectSettings(state.currentProjectSettings),
    collaboration: { allowSharedClipboard: enabled },
  });
  settingsYDoc.transact(() => {
    for (const [key, value] of Object.entries(nextSettings)) {
      settingsMap.set(key, value);
    }
  });
}

function startProjectSettingsPolling() {
  if (!state.currentProject) return;
  if (settingsRefreshTimer) clearInterval(settingsRefreshTimer);
  settingsRefreshTimer = setInterval(() => {
    // Polling is a fallback refresh; the real-time settings room handles most
    // updates, but this catches missed ones after transient disconnects.
    refreshProjectSettings().catch(() => {});
  }, 2000);
}

// ---------------------------------------------------------------------------
// Settings sync room (also carries project-wide presence/awareness)
// ---------------------------------------------------------------------------

export function openProjectSettingsSync(projectName) {
  teardownProjectSettingsSync();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseUrl = `${protocol}//${location.host}/collaboration/${encodeURIComponent(projectName)}`;
  settingsYDoc = new Y.Doc();
  settingsProvider = new WebsocketProvider(baseUrl, '__settings__', settingsYDoc);
  settingsMap = settingsYDoc.getMap('settings');
  projectAwareness = settingsProvider.awareness;
  projectAwareness.setLocalStateField('user', {
    name: collaboratorLabel,
    icon: collaboratorIcon,
    color: COLLABORATOR_COLORS[settingsYDoc.clientID % COLLABORATOR_COLORS.length],
  });
  projectAwareness.on('change', handleProjectAwarenessChange);
  renderCollaborators();

  settingsMap.observe(() => {
    state.currentProjectSettings = normalizeProjectSettings(Object.fromEntries(settingsMap.entries()));
    syncClipboardToggle();
    applyProjectSettingsToEditor();
    applySharedUndoMode();
  });

  startProjectSettingsPolling();
}

// Toggles whether the shared undo history is enabled for the active file. The
// setting is project-scoped and synced live over the settings room.
function applySharedUndoMode() {
  if (!currentUndoManager || !currentProvider) return;
  if (getAllowSharedClipboard(state.currentProjectSettings)) {
    currentUndoManager.trackedOrigins.add(currentProvider);
  } else {
    currentUndoManager.trackedOrigins.delete(currentProvider);
  }
  currentUndoManager.clear();
}

// ---------------------------------------------------------------------------
// File collaboration room
// ---------------------------------------------------------------------------

// Opens/re-opens collaboration for a file: Y.Doc + WebsocketProvider on its
// room + CodemirrorBinding to the editor. Callers must tear down any previous binding first.
export function openCollaboration(projectName, filePath) {
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
  // Best-effort: record which server we're talking to now, so a later
  // reconnect can detect a restart. Not load-bearing if it fails.
  fetch('/api/server-instance-id')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => { if (data) knownServerInstanceId = data.id; })
    .catch(() => {});

  currentProvider.on('status', ({ status }) => {
    if (currentProvider !== thisProvider) return;
    if (status === 'connected') {
      setCollaborationStatus('collaborating', 'ok');
    } else if (status === 'connecting') {
      setCollaborationStatus('connecting…', 'unknown');
    } else if (status === 'disconnected') {
      setCollaborationStatus('reconnecting…', 'unknown');
      // Halt auto-reconnect and verify server identity over plain HTTP first,
      // since resuming blindly could duplicate content if the server restarted.
      thisProvider.disconnect();
      confirmServerIdentityBeforeReconnecting(thisProvider, projectName, filePath);
    }
  });
  currentProvider.on('connection-error', () => {
    if (currentProvider !== thisProvider) return;
    setCollaborationStatus('offline', 'missing');
  });

  const ytext = currentYDoc.getText('content');
  currentUndoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set() });
  // The binding's constructor immediately calls cm.setValue() to sync the
  // editor; suppress dirty-tracking for that one programmatic call.
  state.suppressChangeEvents = true;
  currentBinding = new CodemirrorBinding(ytext, cm, currentProvider.awareness, {
    yUndoManager: currentUndoManager,
  });
  state.suppressChangeEvents = false;
  applySharedUndoMode();
}

// Called after a provider disconnects, instead of letting it auto-reconnect
// unchecked. Polls a plain HTTP endpoint (not Yjs) to see if the server is
// still the same process, then either resumes or reopens the file fresh.
async function confirmServerIdentityBeforeReconnecting(provider, projectName, filePath, attempt = 0) {
  if (currentProvider !== provider) return; // superseded by a newer openCollaboration() call

  let currentId = null;
  try {
    const res = await fetch('/api/server-instance-id');
    if (res.ok) currentId = (await res.json()).id;
  } catch {
    // Server not reachable yet (still restarting, or a real outage) --
    // fall through to the retry below.
  }

  if (currentProvider !== provider) return; // could have changed while awaiting

  if (currentId === null) {
    const backoffMs = Math.min(2 ** attempt * 200, 5000);
    setTimeout(
      () => confirmServerIdentityBeforeReconnecting(provider, projectName, filePath, attempt + 1),
      backoffMs
    );
    return;
  }

  if (knownServerInstanceId === null || currentId === knownServerInstanceId) {
    knownServerInstanceId = currentId;
    provider.connect();
  } else {
    knownServerInstanceId = currentId;
    // Old edits may not have reached disk before the crash; capture content
    // and only prompt if it actually differs from the resynced server copy.
    const preRestartContent = cm.getValue();
    openCollaboration(projectName, filePath);
    const newProvider = currentProvider;
    newProvider.once('sync', () => {
      if (currentProvider !== newProvider) return; // switched files again meanwhile
      if (cm.getValue() === preRestartContent) return; // nothing lost, no need to bother anyone
      const keepLocal = confirm(
        `The real-time collaboration server restarted, and your local copy of ` +
        `"${filePath}" has content the server doesn't have -- most likely edits ` +
        `made in the last moment before the restart that hadn't been saved yet.\n\n` +
        `Click OK to keep YOUR version (it will be saved as new edits).\n` +
        `Click Cancel to use the server's current version instead.`
      );
      if (keepLocal) cm.setValue(preRestartContent);
    });
  }
}

export function getProjectAwareness() {
  return projectAwareness;
}

export function updatePresence(filePath, scrollTop) {
  updateProjectPresence(filePath, scrollTop);
}

export function teardownFileCollaboration() {
  teardownCollaboration();
}

export { teardownProjectSettingsSync };

function isTextEditableClientSide(relPath) {
  const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
  return ['.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log'].includes(ext);
}
