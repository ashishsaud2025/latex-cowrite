'use strict';

import { dom } from './dom.js';
import { cm } from './editor.js';
import { state } from './state.js';
import { openFile, isTextEditableClientSide } from './projects.js';

let pdfDocument = null;

export async function renderPdf(arrayBuffer) {
  if (!window.pdfjsLib) {
    throw new Error('PDF.js failed to load. Refresh the page and try again.');
  }

  dom.pdfContainer.innerHTML = '';
  pdfDocument = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const scale = Math.min(1.6, Math.max(1, (dom.pdfContainer.clientWidth - 40) / page.getViewport({ scale: 1 }).width));
    const viewport = page.getViewport({ scale });
    const pageView = document.createElement('div');
    pageView.className = 'pdf-page';
    pageView.dataset.pageNumber = String(pageNumber);
    pageView.style.width = `${viewport.width}px`;
    pageView.style.height = `${viewport.height}px`;
    pageView.style.setProperty('--scale-factor', String(scale));

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageView.appendChild(canvas);

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    pageView.appendChild(textLayer);

    const annotationLayer = document.createElement('div');
    annotationLayer.className = 'annotationLayer';
    annotationLayer.style.width = `${viewport.width}px`;
    annotationLayer.style.height = `${viewport.height}px`;
    pageView.appendChild(annotationLayer);
    dom.pdfContainer.appendChild(pageView);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const textContent = await page.getTextContent();
    await window.pdfjsLib.renderTextLayer({
      textContent,
      container: textLayer,
      viewport,
      textDivs: [],
    }).promise;
    const annotations = await page.getAnnotations();
    const annotationLayerApi = window.pdfjsLib.AnnotationLayer;
    if (!annotationLayerApi) throw new Error('PDF.js annotation layer failed to load.');
    const annotationLayerInstance = new annotationLayerApi({
      div: annotationLayer,
      page,
      viewport,
    });
    await annotationLayerInstance.render({
      annotations,
      linkService: {
        getDestinationHash: () => '#',
        goToDestination: (destination) => navigateToPdfDestination(destination),
        navigateTo: (destination) => navigateToPdfDestination(destination),
      },
    });
  }
}

export async function navigateToPdfDestination(destination) {
  if (!pdfDocument || destination == null) return;
  const resolved = typeof destination === 'string'
    ? await pdfDocument.getDestination(destination)
    : destination;
  if (!Array.isArray(resolved) || resolved.length === 0) return;
  const pageReference = resolved[0];
  const pageIndex = typeof pageReference === 'number'
    ? pageReference
    : await pdfDocument.getPageIndex(pageReference);
  const target = dom.pdfContainer.querySelector(`[data-page-number="${pageIndex + 1}"]`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function normalizeSearchText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findNormalizedSourceIndex(source, query) {
  let normalized = '';
  const sourceIndexes = [];
  let previousWasWhitespace = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index].toLowerCase();
    if (/\s/.test(character)) {
      if (normalized && !previousWasWhitespace) {
        normalized += ' ';
        sourceIndexes.push(index);
      }
      previousWasWhitespace = true;
      continue;
    }
    normalized += character;
    sourceIndexes.push(index);
    previousWasWhitespace = false;
  }
  const normalizedStart = normalized.indexOf(query);
  return normalizedStart < 0 ? -1 : sourceIndexes[normalizedStart];
}

function sourceTextPosition(source, text) {
  if (!text) return -1;
  const query = normalizeSearchText(text);
  if (!query) return -1;
  return findNormalizedSourceIndex(source, query);
}

function placeSourceCursor(source, start) {
  const sourcePrefix = source.slice(0, start);
  const line = sourcePrefix.split('\n').length - 1;
  const column = sourcePrefix.length - sourcePrefix.lastIndexOf('\n') - 1;
  cm.setCursor({ line, ch: column });
  cm.scrollIntoView({ line, ch: column }, 120);
  cm.focus();
}

function flattenEditableFiles(nodes, files = []) {
  for (const node of nodes) {
    if (node.type === 'dir') flattenEditableFiles(node.children || [], files);
    else if (node.editable) files.push(node);
  }
  return files;
}

export async function jumpToSourceText(text) {
  if (!state.currentProject || !text) return 'not-found';
  if (state.currentFile?.editable) {
    const currentStart = sourceTextPosition(cm.getValue(), text);
    if (currentStart >= 0) {
      placeSourceCursor(cm.getValue(), currentStart);
      return 'matched';
    }
  }

  const matches = [];
  for (const node of flattenEditableFiles(state.projectTree)) {
    if (state.currentFile?.path === node.path) continue;
    const res = await fetch(
      `/api/projects/${encodeURIComponent(state.currentProject)}/file?path=${encodeURIComponent(node.path)}`
    );
    if (!res.ok) continue;
    const data = await res.json();
    const source = data.content || '';
    const start = sourceTextPosition(source, text);
    if (start >= 0) matches.push({ node, start });
  }
  if (matches.length !== 1) return matches.length > 1 ? 'ambiguous' : 'not-found';
  await openFile(matches[0].node);
  if (state.currentFile?.path !== matches[0].node.path) return 'not-found';
  placeSourceCursor(cm.getValue(), sourceTextPosition(cm.getValue(), text));
  return 'matched';
}

export function findPdfText(text) {
  const query = normalizeSearchText(text);
  if (!query) return;
  for (const textLayer of dom.pdfContainer.querySelectorAll('.textLayer')) {
    for (const textDiv of textLayer.querySelectorAll('span')) {
      if (normalizeSearchText(textDiv.textContent).includes(query)) {
        textDiv.scrollIntoView({ block: 'center', inline: 'nearest' });
        textDiv.classList.add('pdf-source-match');
        setTimeout(() => textDiv.classList.remove('pdf-source-match'), 1400);
        return;
      }
    }
  }
}

export { isTextEditableClientSide };
