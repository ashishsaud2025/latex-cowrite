'use strict';

import { dom } from './dom.js';
import { state } from './state.js';

export function setToolbar(text, kind) {
  dom.toolbarEl.textContent = text;
  dom.toolbarEl.className = kind || '';
}

export function setPreviewTab(view) {
  state.activePreviewTab = view;
  const isPdf = view === 'pdf';
  dom.pdfTab.classList.toggle('active', isPdf);
  dom.logTab.classList.toggle('active', !isPdf);
  dom.pdfTab.setAttribute('aria-selected', String(isPdf));
  dom.logTab.setAttribute('aria-selected', String(!isPdf));
  dom.pdfView.classList.toggle('active', isPdf);
  dom.logView.classList.toggle('active', !isPdf);
}

export function showLog(text) {
  dom.logContent.textContent = text || '(empty)';
  setPreviewTab('log');
}

export function appendLog(text) {
  const existing = dom.logContent.textContent || '';
  const next = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + text;
  dom.logContent.textContent = next;
  dom.logContent.scrollTop = dom.logContent.scrollHeight;
  if (state.activePreviewTab === 'log') {
    setPreviewTab('log');
  }
}

export function hideLog() {
  setPreviewTab('pdf');
}
