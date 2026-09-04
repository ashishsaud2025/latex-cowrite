'use strict';

import { dom } from './dom.js';
import { cm, setDirty, setupLayout } from './editor.js';
import { state } from './state.js';
import { setupSettingsView, syncClipboardToggle } from './settings.js';
import { stopFollowingCollaborator, updatePresence, setSharedClipboardEnabled } from './collaboration.js';
import { loadProjects, switchProject, saveCurrentFile, createEntry } from './projects.js';
import { setPreviewTab, hideLog, setToolbar } from './preview.js';
import { compile, refreshTectonicStatus } from './compile.js';
import { findPdfText, jumpToSourceText } from './pdf.js';

// y-codemirror tags remote-peer edits with this origin so they can be told
// apart from local typing; only local edits should mark the file dirty.
const REMOTE_EDIT_ORIGIN = 'y-codemirror';

function wireEditorEvents() {
  cm.on('change', (instance, changeObj) => {
    if (state.suppressChangeEvents) return;
    if (changeObj && changeObj.origin === REMOTE_EDIT_ORIGIN) return;
    if (state.currentFile && state.currentFile.editable) {
      setDirty(true);
    }
  });

  cm.getWrapperElement().addEventListener('click', (event) => {
    if (event.button === 0) stopFollowingCollaborator();
  });

  cm.on('scroll', () => {
    if (!state.currentFile || !state.currentFile.editable) return;
    updatePresence(state.currentFile.path, cm.getScrollInfo().top);
  });

  cm.on('cursorActivity', () => {
    const selection = cm.getSelection();
    if (selection.length >= 2 && state.activePreviewTab === 'pdf') {
      findPdfText(selection);
    }
  });
}

function wireToolbarEvents() {
  dom.projectSelect.addEventListener('change', () => switchProject(dom.projectSelect.value));
  if (dom.projectClipboardToggle) {
    dom.projectClipboardToggle.addEventListener('change', () => {
      setSharedClipboardEnabled(dom.projectClipboardToggle.checked);
    });
  }

  dom.newProjectBtn.addEventListener('click', async () => {
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

  dom.saveBtn.addEventListener('click', saveCurrentFile);
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

  dom.newFileBtn.addEventListener('click', () => createEntry('file'));
  dom.newFolderBtn.addEventListener('click', () => createEntry('dir'));
  dom.compileBtn.addEventListener('click', compile);
}

function wirePreviewEvents() {
  dom.pdfTab.addEventListener('click', () => setPreviewTab('pdf'));
  dom.logTab.addEventListener('click', () => setPreviewTab('log'));
  dom.logClose.addEventListener('click', hideLog);

  let pdfSelectionTimer = null;
  dom.pdfContainer.addEventListener('mouseup', () => {
    clearTimeout(pdfSelectionTimer);
    pdfSelectionTimer = setTimeout(async () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const anchor = selection.anchorNode?.parentElement?.closest('.textLayer');
      const focus = selection.focusNode?.parentElement?.closest('.textLayer');
      if (!anchor || anchor !== focus) return;
      const text = selection.toString().trim();
      const sourceMatch = await jumpToSourceText(text);
      if (sourceMatch === 'matched') {
        setToolbar('PDF selection matched in the active source file.', 'ok');
      } else if (sourceMatch === 'ambiguous') {
        setToolbar('PDF selection matches multiple source files. Select more text.', '');
      } else {
        setToolbar('PDF text was not found in the active source file.', '');
      }
    }, 0);
  });
}

// Initialize the shared application (imported for side effects).
function wireInit() {
  setupLayout();
  setupSettingsView();
  syncClipboardToggle();
  wireEditorEvents();
  wireToolbarEvents();
  wirePreviewEvents();

  refreshTectonicStatus();
  loadProjects();
}

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

wireInit();
