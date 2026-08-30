// Entry point bundled by esbuild into public/collab-bundle.js.
//
// yjs, y-websocket, and y-codemirror are published as ES modules meant to be
// consumed by a bundler. The rest of this app's frontend intentionally has
// no build step (CodeMirror itself is loaded via a CDN <script> tag), so
// this is the one piece that gets bundled, then exposed as a single global
// (`window.Collab`), letting a plain script consume it without becoming a
// module itself.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { CodemirrorBinding } from 'y-codemirror';
import { Awareness } from 'y-protocols/awareness';

window.Collab = { Y, WebsocketProvider, CodemirrorBinding, Awareness };