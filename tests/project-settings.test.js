const assert = require('node:assert/strict');
const { normalizeProjectSettings } = require('../server.js');

const defaultEditor = {
  theme: 'eclipse',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentUnit: 2,
};

const defaultPdfViewer = {
  defaultTab: 'pdf',
};

assert.deepEqual(normalizeProjectSettings(undefined), {
  collaboration: { allowSharedClipboard: false },
  editor: defaultEditor,
  pdfViewer: defaultPdfViewer,
});
assert.deepEqual(normalizeProjectSettings({ allowSharedClipboard: true }), {
  collaboration: { allowSharedClipboard: true },
  editor: defaultEditor,
  pdfViewer: defaultPdfViewer,
});
assert.deepEqual(normalizeProjectSettings({ allowSharedClipboard: false }), {
  collaboration: { allowSharedClipboard: false },
  editor: defaultEditor,
  pdfViewer: defaultPdfViewer,
});
assert.deepEqual(normalizeProjectSettings({ allowSharedClipboard: 'yes' }), {
  collaboration: { allowSharedClipboard: false },
  editor: defaultEditor,
  pdfViewer: defaultPdfViewer,
});
assert.deepEqual(normalizeProjectSettings({
  collaboration: { allowSharedClipboard: true },
  editor: { theme: 'dracula', tabSize: 4, indentUnit: 2 },
  pdfViewer: { defaultTab: 'log' },
}), {
  collaboration: { allowSharedClipboard: true },
  editor: {
    theme: 'dracula',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 4,
    indentUnit: 2,
  },
  pdfViewer: { defaultTab: 'log' },
});

console.log('project-settings tests passed');
