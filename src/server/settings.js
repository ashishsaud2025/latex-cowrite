'use strict';

const path = require('path');
const fs = require('fs/promises');
const {
  DEFAULT_PROJECT_SETTINGS,
  PROJECT_SETTINGS_FILE,
} = require('./constants');
const { projectRootFor, projectExists } = require('./projects');

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

module.exports = {
  normalizeProjectSettings,
  readProjectSettings,
  writeProjectSettings,
};
