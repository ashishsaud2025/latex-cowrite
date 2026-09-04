'use strict';

import { dom } from './dom.js';
import { state } from './state.js';
import { setToolbar, setPreviewTab, showLog, appendLog } from './preview.js';
import { renderPdf } from './pdf.js';
import { saveCurrentFile, isTextEditableClientSide } from './projects.js';

export { isTextEditableClientSide };

let currentCompileJobId = null;
let currentCompileStream = null;
let currentCompilePollTimer = null;

// tectonic status indicator
export async function refreshTectonicStatus() {
  try {
    const res = await fetch('/api/tectonic-status');
    const data = await res.json();
    if (data.available) {
      dom.statusPill.textContent = 'tectonic ready';
      dom.statusPill.className = 'status-pill status-ok';
    } else {
      dom.statusPill.textContent = 'tectonic NOT installed';
      dom.statusPill.className = 'status-pill status-missing';
    }
  } catch {
    dom.statusPill.textContent = 'status unknown';
    dom.statusPill.className = 'status-pill status-unknown';
  }
}

function stopCompileStream() {
  if (currentCompileStream) {
    currentCompileStream.close();
    currentCompileStream = null;
  }
  if (currentCompilePollTimer) {
    clearTimeout(currentCompilePollTimer);
    currentCompilePollTimer = null;
  }
  currentCompileJobId = null;
}

function openCompileLogStream(projectName, jobId) {
  stopCompileStream();
  currentCompileJobId = jobId;
  const streamUrl = `/api/projects/${encodeURIComponent(projectName)}/compile/${encodeURIComponent(jobId)}/logs`;
  const stream = new EventSource(streamUrl);
  currentCompileStream = stream;

  stream.addEventListener('log', (event) => {
    try {
      const payload = JSON.parse(event.data);
      appendLog(payload.text || '');
    } catch {
      appendLog(String(event.data || ''));
    }
  });

  stream.addEventListener('status', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.status === 'running') {
        setToolbar('Compiling…', '');
      }
    } catch {
      // ignore malformed status updates
    }
  });

  stream.onerror = () => {
    stream.close();
    if (currentCompileStream === stream) {
      currentCompileStream = null;
    }
  };
}

async function pollCompileStatus(projectName, jobId) {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/compile/${encodeURIComponent(jobId)}/status`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not read compile status.');
    }

    if (data.status === 'success') {
      dom.logContent.textContent = data.log || '(empty)';
      const pdfRes = await fetch(`/api/projects/${encodeURIComponent(projectName)}/compile/${encodeURIComponent(jobId)}/pdf`);
      if (pdfRes.ok) {
        const buf = await pdfRes.arrayBuffer();
        dom.pdfPlaceholder?.remove();
        await renderPdf(buf);
        setToolbar(data.cached ? `Loaded cached ${data.entry}.` : `Compiled ${data.entry} successfully.`, 'ok');
        setPreviewTab('pdf');
      }
      stopCompileStream();
      return;
    }

    if (data.status === 'error' || data.status === 'timeout') {
      setToolbar(data.error || 'Compile failed.', 'error');
      showLog(data.log || '');
      stopCompileStream();
      return;
    }

    if (data.status === 'running') {
      currentCompilePollTimer = setTimeout(() => pollCompileStatus(projectName, jobId), 400);
    }
  } catch (err) {
    setToolbar(`Request failed: ${err.message}`, 'error');
    showLog(String(err.stack || err));
    stopCompileStream();
  }
}

export async function compile() {
  if (!state.currentProject) return;

  // Compiling stale disk content while the editor shows unsaved changes
  // would be confusing, so save first if needed.
  if (state.dirty) {
    const saved = await saveCurrentFile();
    if (!saved) return;
  }

  dom.compileBtn.disabled = true;
  dom.compileBtn.textContent = 'Compiling…';
  setToolbar('Compiling…', '');
  dom.logContent.textContent = '';
  setPreviewTab('pdf');

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(state.currentProject)}/compile/start`, {
      method: 'POST',
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}`, log: '' }));

    if (!res.ok) {
      setToolbar(data.error || 'Compile failed.', 'error');
      showLog(data.log || '');
      refreshTectonicStatus();
      return;
    }

    const { jobId, entry } = data;
    if (!jobId) {
      throw new Error('Compile did not return a job ID.');
    }

    openCompileLogStream(state.currentProject, jobId);
    pollCompileStatus(state.currentProject, jobId);
    setToolbar(`Compiling ${entry || 'project'}…`, '');
  } catch (err) {
    setToolbar(`Request failed: ${err.message}`, 'error');
    showLog(String(err.stack || err));
  } finally {
    dom.compileBtn.disabled = false;
    dom.compileBtn.textContent = 'Compile';
  }
}
