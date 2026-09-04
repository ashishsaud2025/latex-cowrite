'use strict';

import { dom } from './dom.js';
import { applyEditorSettings } from './editor.js';
import { state, defaultSettings } from './state.js';

// Canonicalize project settings, accepting the legacy flat allowSharedClipboard
// key for backward compatibility.
export function normalizeProjectSettings(raw) {
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

export function getAllowSharedClipboard(settings = state.currentProjectSettings) {
  const collaboration = settings && settings.collaboration && typeof settings.collaboration === 'object'
    ? settings.collaboration
    : {};
  return collaboration.allowSharedClipboard === true || settings.allowSharedClipboard === true;
}

export function applyProjectSettingsToEditor() {
  applyEditorSettings(state.currentProjectSettings.editor || {});
}

// Refresh the active project's settings from the server. Falls back to
// defaults when no project is open or the request fails.
export async function refreshProjectSettings() {
  if (!state.currentProject) {
    state.currentProjectSettings = defaultSettings();
    syncClipboardToggle();
    applyProjectSettingsToEditor();
    return;
  }

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/settings`);
    const data = await res.json();
    state.currentProjectSettings = data && data.settings ? normalizeProjectSettings(data.settings) : defaultSettings();
  } catch {
    state.currentProjectSettings = defaultSettings();
  }

  syncClipboardToggle();
  applyProjectSettingsToEditor();
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

function populateSettingsForm() {
  if (!dom.settingsTheme || !dom.settingsLineNumbers || !dom.settingsLineWrapping || !dom.settingsTabSize || !dom.settingsDefaultTab) return;
  const editorSettings = state.currentProjectSettings.editor || {};
  dom.settingsTheme.value = typeof editorSettings.theme === 'string' ? editorSettings.theme : 'eclipse';
  dom.settingsLineNumbers.checked = editorSettings.lineNumbers !== false;
  dom.settingsLineWrapping.checked = editorSettings.lineWrapping !== false;
  const tabSize = Number.isInteger(editorSettings.tabSize) && editorSettings.tabSize > 0 ? editorSettings.tabSize : 2;
  dom.settingsTabSize.value = String(tabSize);
  const defaultTab = state.currentProjectSettings.pdfViewer && state.currentProjectSettings.pdfViewer.defaultTab === 'log' ? 'log' : 'pdf';
  dom.settingsDefaultTab.value = defaultTab;
}

export function openSettingsModal() {
  if (!state.currentProject) return;
  populateSettingsForm();
  dom.settingsModal.classList.remove('hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'false');
}

export function closeSettingsModal() {
  dom.settingsModal.classList.add('hidden');
  dom.settingsModal.setAttribute('aria-hidden', 'true');
  if (dom.settingsRawPanel) dom.settingsRawPanel.classList.add('hidden');
  if (dom.settingsForm) dom.settingsForm.classList.remove('hidden');
}

function showSettingsRawEditor() {
  if (!dom.settingsRawPanel || !dom.settingsRawJson || !dom.settingsForm) return;
  dom.settingsRawJson.value = JSON.stringify(state.currentProjectSettings, null, 2);
  dom.settingsForm.classList.add('hidden');
  dom.settingsRawPanel.classList.remove('hidden');
}

function showSettingsFormEditor() {
  if (!dom.settingsRawPanel || !dom.settingsForm) return;
  dom.settingsRawPanel.classList.add('hidden');
  dom.settingsForm.classList.remove('hidden');
}

// Re-render the shared clipboard toggle from the current settings.
export function syncClipboardToggle() {
  if (dom.projectClipboardToggle) {
    dom.projectClipboardToggle.checked = getAllowSharedClipboard();
  }
}

export { showSettingsFormEditor };

// ---------------------------------------------------------------------------
// Event wiring for the settings modal
// ---------------------------------------------------------------------------

export function setupSettingsView() {
  if (dom.projectSettingsBtn) {
    dom.projectSettingsBtn.addEventListener('click', openSettingsModal);
  }
  if (dom.settingsCloseBtn) {
    dom.settingsCloseBtn.addEventListener('click', closeSettingsModal);
  }
  if (dom.settingsCancelBtn) {
    dom.settingsCancelBtn.addEventListener('click', closeSettingsModal);
  }
  if (dom.settingsRawBtn) {
    dom.settingsRawBtn.addEventListener('click', showSettingsRawEditor);
  }
  if (dom.settingsRawCloseBtn) {
    dom.settingsRawCloseBtn.addEventListener('click', showSettingsFormEditor);
  }
  if (dom.settingsRawApplyBtn) {
    dom.settingsRawApplyBtn.addEventListener('click', async () => {
      if (!state.currentProject || !dom.settingsRawJson) return;
      let parsed;
      try {
        parsed = JSON.parse(dom.settingsRawJson.value);
      } catch {
        alert('Invalid JSON. Please fix the syntax before applying the project settings.');
        return;
      }

      const nextSettings = normalizeProjectSettings(parsed);
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextSettings),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Could not apply project settings.');
        }
        state.currentProjectSettings = normalizeProjectSettings(data.settings || nextSettings);
        syncClipboardToggle();
        applyProjectSettingsToEditor();
        showSettingsFormEditor();
        populateSettingsForm();
      } catch (err) {
        alert(err.message || 'Could not apply project settings.');
      }
    });
  }

  if (dom.settingsModal) {
    dom.settingsModal.addEventListener('click', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.closeSettings === 'true') {
        closeSettingsModal();
      }
    });
  }

  if (dom.settingsForm) {
    dom.settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.currentProject) return;

      const nextSettings = normalizeProjectSettings({
        ...state.currentProjectSettings,
        collaboration: {
          allowSharedClipboard: dom.projectClipboardToggle ? dom.projectClipboardToggle.checked : getAllowSharedClipboard(state.currentProjectSettings),
        },
        editor: {
          ...state.currentProjectSettings.editor,
          theme: dom.settingsTheme.value,
          lineNumbers: dom.settingsLineNumbers.checked,
          lineWrapping: dom.settingsLineWrapping.checked,
          tabSize: Number(dom.settingsTabSize.value) || 2,
          indentUnit: Number(dom.settingsTabSize.value) || 2,
        },
        pdfViewer: {
          ...state.currentProjectSettings.pdfViewer,
          defaultTab: dom.settingsDefaultTab.value === 'log' ? 'log' : 'pdf',
        },
      });

      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nextSettings),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Could not save settings.');
        }
        state.currentProjectSettings = normalizeProjectSettings(data.settings || nextSettings);
        syncClipboardToggle();
        applyProjectSettingsToEditor();
        closeSettingsModal();
      } catch (err) {
        alert(err.message || 'Could not save settings.');
      }
    });
  }
}
