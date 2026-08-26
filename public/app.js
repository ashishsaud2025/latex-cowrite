'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const DEFAULT_SOURCE = `\\documentclass{article}
\\title{Hello, Tectonic}
\\author{You}
\\begin{document}
\\maketitle

This is a minimal document. Edit the source on the left and click
\\textbf{Compile} to see the rendered PDF on the right.

\\section{A section}
Some \\emph{LaTeX} content:
\\[ e^{i\\pi} + 1 = 0 \\]

\\end{document}
`;

const textarea = document.getElementById('source');
textarea.value = DEFAULT_SOURCE;

const cm = CodeMirror.fromTextArea(textarea, {
  mode: 'stex',
  theme: 'eclipse',
  lineNumbers: true,
  lineWrapping: true,
  tabSize: 2,
  indentUnit: 2,
});

const compileBtn = document.getElementById('compile-btn');
const compileStateEl = document.getElementById('compile-state');
const toolbarEl = document.getElementById('preview-toolbar');
const pdfContainer = document.getElementById('pdf-container');
const pdfPlaceholder = document.getElementById('pdf-placeholder');
const logPanel = document.getElementById('log-panel');
const logContent = document.getElementById('log-content');
const logClose = document.getElementById('log-close');
const statusPill = document.getElementById('tectonic-status');

logClose.addEventListener('click', () => logPanel.classList.add('hidden'));

async function refreshTectonicStatus() {
  try {
    const res = await fetch('/api/tectonic-status');
    const data = await res.json();
    if (data.available) {
      statusPill.textContent = 'tectonic ready';
      statusPill.className = 'status-pill status-ok';
    } else {
      statusPill.textContent = 'tectonic NOT installed';
      statusPill.className = 'status-pill status-missing';
    }
  } catch {
    statusPill.textContent = 'status unknown';
    statusPill.className = 'status-pill status-unknown';
  }
}
refreshTectonicStatus();

function setToolbar(text, kind) {
  toolbarEl.textContent = text;
  toolbarEl.className = kind ? kind : '';
}

function showLog(text) {
  logContent.textContent = text || '(empty)';
  logPanel.classList.remove('hidden');
}

function hideLog() {
  logPanel.classList.add('hidden');
}

async function renderPdf(arrayBuffer) {
  pdfContainer.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.4 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    pdfContainer.appendChild(canvas);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

async function compile() {
  compileBtn.disabled = true;
  compileBtn.textContent = 'Compiling…';
  setToolbar('Compiling…', '');
  hideLog();

  try {
    const res = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: cm.getValue() }),
    });

    const contentType = res.headers.get('Content-Type') || '';

    if (res.ok && contentType.includes('application/pdf')) {
      const buf = await res.arrayBuffer();
      pdfPlaceholder.remove();
      await renderPdf(buf);
      setToolbar('Compiled successfully.', 'ok');
      hideLog();
    } else {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}`, log: '' }));
      setToolbar(data.error || 'Compile failed.', 'error');
      showLog(data.log || '');
      refreshTectonicStatus();
    }
  } catch (err) {
    setToolbar(`Request failed: ${err.message}`, 'error');
    showLog(String(err.stack || err));
  } finally {
    compileBtn.disabled = false;
    compileBtn.textContent = 'Compile';
  }
}

compileBtn.addEventListener('click', compile);

// Ctrl/Cmd+Enter to compile without reaching for the mouse.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    compile();
  }
});
