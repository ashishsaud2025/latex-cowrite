'use strict';

// Mutable singleton holding shared application state. Kept dependency-free so
// any module can read/write it without creating import cycles.

export const state = {
  currentProject: null,
  currentFile: null, // { path, editable }
  currentProjectSettings: {
    collaboration: { allowSharedClipboard: false },
    editor: { theme: 'eclipse', lineNumbers: true, lineWrapping: true, tabSize: 2, indentUnit: 2 },
    pdfViewer: { defaultTab: 'pdf' },
  },
  projectTree: [],
  expandedFolders: new Set(),
  activePreviewTab: 'pdf',
  suppressChangeEvents: false,
  dirty: false,
};

export const defaultSettings = () => ({
  collaboration: { allowSharedClipboard: false },
  editor: { theme: 'eclipse', lineNumbers: true, lineWrapping: true, tabSize: 2, indentUnit: 2 },
  pdfViewer: { defaultTab: 'pdf' },
});
