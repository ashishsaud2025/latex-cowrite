'use strict';

const fs = require('fs/promises');
const { docs: yDocs } = require('y-websocket/bin/utils');
const { PERSIST_DEBOUNCE_MS } = require('./constants');
const { projectRootFor, projectExists, resolveSafePath } = require('./projects');
const { normalizeProjectSettings, writeProjectSettings } = require('./settings');

const persistTimers = new Map(); // roomKey -> Timeout

// Debounced persist of a file Y.Text room to disk. Yjs updates go to peers
// immediately; this only batches the disk write.
function schedulePersist(roomKey, projectName, filePath) {
  clearTimeout(persistTimers.get(roomKey));
  persistTimers.set(roomKey, setTimeout(async () => {
    persistTimers.delete(roomKey);
    const doc = yDocs.get(roomKey);
    if (!doc) return; // room was torn down before this fired
    const root = projectRootFor(projectName);
    const abs = root && resolveSafePath(root, filePath);
    if (!abs) return;
    try {
      // The project or the file itself may have been deleted/renamed out
      // from under an active room; skip the write rather than recreate it.
      if (!(await projectExists(root))) return;
      await fs.writeFile(abs, doc.getText('content').toString(), 'utf8');
    } catch {
      // The next edit (or an explicit Save) will retry.
    }
  }, PERSIST_DEBOUNCE_MS));
}

// Debounced persist of a Yjs settings room to disk. Yjs updates go straight to
// peers; this only batches the disk write.
function schedulePersistSettings(roomKey, projectName) {
  clearTimeout(persistTimers.get(roomKey));
  persistTimers.set(roomKey, setTimeout(async () => {
    persistTimers.delete(roomKey);
    const doc = yDocs.get(roomKey);
    if (!doc) return;
    const root = projectRootFor(projectName);
    if (!root || !(await projectExists(root))) return;
    try {
      const settingsMap = doc.getMap('settings');
      const nextSettings = normalizeProjectSettings(Object.fromEntries(settingsMap.entries()));
      await writeProjectSettings(projectName, nextSettings);
    } catch {
      // The next update (or an explicit settings write) will retry.
    }
  }, PERSIST_DEBOUNCE_MS));
}

module.exports = {
  schedulePersist,
  schedulePersistSettings,
};
