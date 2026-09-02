const assert = require('node:assert/strict');
const { normalizeProjectSettings } = require('../server.js');

assert.deepEqual(normalizeProjectSettings(undefined), { allowSharedClipboard: false });
assert.deepEqual(normalizeProjectSettings({ allowSharedClipboard: true }), { allowSharedClipboard: true });
assert.deepEqual(normalizeProjectSettings({ allowSharedClipboard: false }), { allowSharedClipboard: false });
assert.deepEqual(normalizeProjectSettings({ allowSharedClipboard: 'yes' }), { allowSharedClipboard: false });

console.log('project-settings tests passed');
