'use strict';

const fs = require('fs'); // used only to seed a new room's content synchronously
const { WebSocketServer } = require('ws');
const { setupWSConnection, getYDoc, docs: yDocs } = require('y-websocket/bin/utils');
const { MAX_FILE_BYTES } = require('./constants');
const { projectRootFor, projectExists, resolveSafePath, isTextEditable } = require('./projects');
const { readProjectSettings, normalizeProjectSettings } = require('./settings');
const { schedulePersist, schedulePersistSettings } = require('./persistence');

function roomKeyFor(projectName, filePath) {
  return `${projectName}::${filePath}`;
}

function settingsRoomKeyFor(projectName) {
  return `${projectName}::__settings__`;
}

// Builds the WebSocket server and wires room setup for file and settings sync.
// Returns the collaboration server used for HTTP upgrade handling.
function createCollaborationServer() {
  const collaborationServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FILE_BYTES });

  collaborationServer.on('connection', (client, request, { projectName, filePath, isSettingsRoom = false }) => {
    const roomKey = isSettingsRoom ? settingsRoomKeyFor(projectName) : roomKeyFor(projectName, filePath);
    const isNewRoom = !yDocs.has(roomKey);
    // getYDoc creates/registers the doc synchronously, so a concurrent second
    // connection to the same new room sees isNewRoom === false and skips reseeding.
    const doc = getYDoc(roomKey);

    if (isSettingsRoom) {
      if (isNewRoom) {
        const settingsMap = doc.getMap('settings');
        readProjectSettings(projectName)
          .then((initial) => {
            const nextSettings = normalizeProjectSettings(initial);
            doc.transact(() => {
              for (const [key, value] of Object.entries(nextSettings)) {
                settingsMap.set(key, value);
              }
            });
            doc.on('update', () => schedulePersistSettings(roomKey, projectName));
          })
          .catch(() => {
            doc.on('update', () => schedulePersistSettings(roomKey, projectName));
          });
      }
    } else if (isNewRoom) {
      // Seed the Y.Text from disk once, at room creation (not every connection).
      // Must be synchronous, before setupWSConnection attaches its listener below,
      // or an early client sync message could arrive and be dropped.
      const root = projectRootFor(projectName);
      const abs = resolveSafePath(root, filePath);
      let initialContent = '';
      try {
        initialContent = fs.readFileSync(abs, 'utf8');
      } catch {
        // File doesn't exist yet (e.g. a brand-new file); start empty.
      }
      const ytext = doc.getText('content');
      if (ytext.length === 0 && initialContent) {
        ytext.insert(0, initialContent);
      }
      doc.on('update', () => schedulePersist(roomKey, projectName, filePath));
    }

    setupWSConnection(client, request, { docName: roomKey });
  });

  return collaborationServer;
}

// Handles an HTTP upgrade request, validating the room path, then hands the
// socket to the collaboration server if allowed. Otherwise destroys it.
function handleUpgrade(collaborationServer, server, request, socket, head) {
  let projectName;
  let filePath;
  let isSettingsRoom = false;
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const settingsMatch = requestUrl.pathname.match(/^\/collaboration\/([^/]+)\/__settings__$/);
    const fileMatch = requestUrl.pathname.match(/^\/collaboration\/([^/]+)\/([^/]+)$/);

    if (settingsMatch) {
      isSettingsRoom = true;
      projectName = settingsMatch && decodeURIComponent(settingsMatch[1]);
    } else {
      projectName = fileMatch && decodeURIComponent(fileMatch[1]);
      filePath = fileMatch && decodeURIComponent(fileMatch[2]);
    }
  } catch {
    projectName = null;
    filePath = null;
    isSettingsRoom = false;
  }

  const root = projectRootFor(projectName);
  if (!root) {
    socket.destroy();
    return;
  }

  if (isSettingsRoom) {
    projectExists(root)
      .then((exists) => {
        if (!exists) {
          socket.destroy();
          return;
        }
        collaborationServer.handleUpgrade(request, socket, head, (client) => {
          collaborationServer.emit('connection', client, request, { projectName, filePath: null, isSettingsRoom: true });
        });
      })
      .catch(() => {
        socket.destroy();
      });
    return;
  }

  if (!filePath || !isTextEditable(filePath) || !resolveSafePath(root, filePath)) {
    socket.destroy();
    return;
  }

  collaborationServer.handleUpgrade(request, socket, head, (client) => {
    collaborationServer.emit('connection', client, request, { projectName, filePath });
  });
}

module.exports = {
  roomKeyFor,
  settingsRoomKeyFor,
  createCollaborationServer,
  handleUpgrade,
};
