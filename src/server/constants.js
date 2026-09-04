'use strict';

const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// Fresh ID per process start, used by clients to detect a server restart and
// force a hard-resync instead of letting Yjs merge against a re-seeded doc.
const SERVER_INSTANCE_ID = crypto.randomBytes(8).toString('hex');
const COMPILE_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;        // cap for a single text file read/write
const MAX_PROJECT_BYTES = 25 * 1024 * 1024;    // cap for total project size when compiling
const PROJECT_SETTINGS_FILE = '.longtex.json';
const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  collaboration: { allowSharedClipboard: false },
  editor: {
    theme: 'eclipse',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2,
  },
  pdfViewer: { defaultTab: 'pdf' },
});

// Where all projects live on disk. Each subdirectory is one project, shown
// as-is in the UI file tree and compiled directly, so \input/\include work.
const PROJECTS_ROOT = path.join(__dirname, '..', '..', 'projects');

// Extensions treated as editable text. Other files still show in the tree
// but aren't opened as text, since reading/writing them as utf8 would corrupt them.
const TEXT_EXTENSIONS = new Set([
  '.tex', '.bib', '.cls', '.sty', '.txt', '.md', '.json', '.yml', '.yaml', '.log',
]);

// If true, blocks tectonic from fetching uncached packages (app-level only,
// not OS network sandboxing). Off by default since a fresh install needs one
// online compile to warm the cache.
const ONLY_CACHED = process.env.TECTONIC_ONLY_CACHED === '1';

// How long to wait after the last edit before persisting a room to disk;
// Yjs updates themselves are still sent to peers immediately, undebounced.
const PERSIST_DEBOUNCE_MS = 500;

// Valid project name characters: letters, digits, dash, underscore.
const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

module.exports = {
  PORT,
  SERVER_INSTANCE_ID,
  COMPILE_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_PROJECT_BYTES,
  PROJECT_SETTINGS_FILE,
  DEFAULT_PROJECT_SETTINGS,
  PROJECTS_ROOT,
  TEXT_EXTENSIONS,
  ONLY_CACHED,
  PERSIST_DEBOUNCE_MS,
  PROJECT_NAME_RE,
};
