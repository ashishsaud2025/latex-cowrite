'use strict';

import { dom } from './dom.js';

const mainEl = document.querySelector('main');

// Editor instance. `cm` is created here and shared with the rest of the app.
export const cm = CodeMirror.fromTextArea(dom.sourceTextarea, {
  mode: 'stex',
  theme: 'eclipse',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentUnit: 2,
});

// CodeMirror themes need their CSS loaded, which is not present by default.
function ensureCodeMirrorThemeStylesheet(themeName) {
  const normalized = typeof themeName === 'string' && themeName.trim() ? themeName.trim() : 'eclipse';
  const existing = document.getElementById('codemirror-theme-stylesheet');
  if (existing && existing.getAttribute('data-theme') === normalized) {
    return;
  }

  const next = document.createElement('link');
  next.id = 'codemirror-theme-stylesheet';
  next.setAttribute('data-theme', normalized);
  next.rel = 'stylesheet';
  next.href = `https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/${normalized}.min.css`;

  if (existing) {
    existing.remove();
  }
  document.head.appendChild(next);
}

export function applyEditorSettings(editorSettings) {
  const themeName = typeof editorSettings.theme === 'string' ? editorSettings.theme : 'eclipse';
  ensureCodeMirrorThemeStylesheet(themeName);
  cm.setOption('theme', themeName);
  cm.setOption('lineNumbers', editorSettings.lineNumbers !== false);
  cm.setOption('lineWrapping', editorSettings.lineWrapping !== false);
  cm.setOption('tabSize', Number.isInteger(editorSettings.tabSize) && editorSettings.tabSize > 0 ? editorSettings.tabSize : 2);
  cm.setOption('indentUnit', Number.isInteger(editorSettings.indentUnit) && editorSettings.indentUnit > 0 ? editorSettings.indentUnit : 2);
}

export function setDirty(value) {
  dom.dirtyIndicator.classList.toggle('hidden', !value);
  dom.saveBtn.disabled = !value;
  dom.saveBtn.classList.toggle('dirty', value);
}

// ---------------------------------------------------------------------------
// Workspace layout / resizing
// ---------------------------------------------------------------------------

function loadWorkspaceSize(name, fallback) {
  const value = Number(localStorage.getItem(`longtex-${name}`));
  return Number.isFinite(value) ? value : fallback;
}

function saveWorkspaceSize(name, value) {
  localStorage.setItem(`longtex-${name}`, String(Math.round(value)));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setupResizeHandle(handle, direction, getBounds, applySize, storageName, initialSize) {
  const setSize = (size, persist = false) => {
    const bounds = getBounds();
    const nextSize = clamp(size, bounds.min, bounds.max);
    applySize(nextSize);
    handle.setAttribute('aria-valuenow', Math.round(nextSize));
    if (persist) saveWorkspaceSize(storageName, nextSize);
  };

  setSize(loadWorkspaceSize(storageName, initialSize));
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startPosition = direction === 'x' ? event.clientX : event.clientY;
    const startSize = direction === 'x'
      ? handle.previousElementSibling.getBoundingClientRect().width
      : handle.parentElement.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');

    const move = (moveEvent) => {
      const position = direction === 'x' ? moveEvent.clientX : moveEvent.clientY;
      setSize(startSize + position - startPosition);
    };
    const stop = () => {
      const size = direction === 'x'
        ? handle.previousElementSibling.getBoundingClientRect().width
        : handle.parentElement.getBoundingClientRect().height;
      setSize(size, true);
      document.body.classList.remove('is-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });

  handle.addEventListener('keydown', (event) => {
    const increment = event.shiftKey ? 50 : 10;
    const change = ['ArrowRight', 'ArrowDown'].includes(event.key) ? increment
      : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -increment : 0;
    if (!change) return;
    event.preventDefault();
    const currentSize = direction === 'x'
      ? handle.previousElementSibling.getBoundingClientRect().width
      : handle.parentElement.getBoundingClientRect().height;
    setSize(currentSize + change, true);
  });
}

export function setupLayout() {
  setupResizeHandle(dom.treeResizer, 'x', () => ({
    min: 150,
    max: Math.max(260, dom.editorPane.clientWidth - 220),
  }), (size) => {
    dom.treeSidebar.style.width = `${size}px`;
  }, 'tree-width', 220);

  setupResizeHandle(dom.paneResizer, 'x', () => ({
    min: 320,
    max: Math.max(420, mainEl.clientWidth - 320),
  }), (size) => {
    dom.editorPane.style.flexBasis = `${size}px`;
  }, 'editor-width', mainEl.clientWidth / 2);

  if (dom.logResizer) {
    setupResizeHandle(dom.logResizer, 'y', () => ({
      min: 70,
      max: Math.max(140, dom.previewPane.clientHeight * 0.7),
    }), (size) => {
      dom.logPanel.style.height = `${size}px`;
    }, 'log-height', 220);
  }
}
