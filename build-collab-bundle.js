'use strict';

// Bundles yjs / y-websocket / y-codemirror / y-protocols (all published as
// ES modules meant for a bundler) into a single browser-ready script:
// public/collab-bundle.js. Re-run this after installing/updating any of
// those packages.
//
// Run with: npm run build

const path = require('path');
const esbuild = require('esbuild');

// y-codemirror imports the `codemirror` npm package only to reach the
// static `CodeMirror.Pos` helper. The rest of this app's frontend loads
// CodeMirror 5 from a CDN <script> tag instead of npm, so bundling the npm
// copy as well would (a) double the bundled CodeMirror code for no reason
// and (b) risk two slightly different CodeMirror instances disagreeing.
// This plugin redirects that one import to the CDN-loaded global instead.
const useGlobalCodemirrorPlugin = {
  name: 'use-global-codemirror',
  setup(build) {
    build.onResolve({ filter: /^codemirror$/ }, (args) => ({
      path: args.path,
      namespace: 'global-codemirror',
    }));
    build.onLoad({ filter: /.*/, namespace: 'global-codemirror' }, () => ({
      contents: 'module.exports = window.CodeMirror;',
      loader: 'js',
    }));
  },
};

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'collab-src', 'index.js')],
    outfile: path.join(__dirname, 'public', 'collab-bundle.js'),
    bundle: true,
    format: 'iife',
    target: ['es2019'],
    minify: true,
    sourcemap: true,
    plugins: [useGlobalCodemirrorPlugin],
    logLevel: 'info',
  })
  .catch(() => process.exit(1));