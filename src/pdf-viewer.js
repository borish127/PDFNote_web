import * as pdfjsLib from 'pdfjs-dist';
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

let pdfDoc = null;
let pdfFilename = '';
let numPages = 0;
let currentPage = 1;
let currentZoom = 'page-fit';
let activeTool = 'cursor'; // 'cursor', 'highlight', 'underline', 'draw', 'text', 'signature', 'eraser'
let markupData = {}; // keyed by 0-based page index
let pageDims = {}; // { [pIdx]: { width, height } } at scale 1.0
let defaultPageDim = { width: 612, height: 792 };
let loadSessionId = 0;

// Undo history per session: array of { pIdx, snapshot }
const markupHistory = [];
const MAX_HISTORY = 50;

// Saved signature template: { kind: 'strokes', strokes, width, height } | { kind: 'image', dataURL, aspect }
let savedSignature = null;
let pendingSignaturePlacement = null; // { pIdx, pos }
const imageCache = new Map(); // dataURL -> HTMLImageElement

// Active rendering tasks per page for cancellation
const activeRenderControllers = new Map(); // pIdx -> { renderTask, textLayerBuilder, cancelled }

// Callbacks
let onPageChangeCallback = null;
let onMarkupChangeCallback = null;
let onFileDropCallback = null;
let onNotifyCallback = null;
let onConfirmCallback = null;

// Intersection Observers
let intersectionObserver = null;
let thumbnailObserver = null;
const renderedPages = new Set();
const intersectingPages = new Set();
let isProgrammaticScrolling = false;
let programmaticScrollTimeout = null;

// Active drawing state
let activePointerDraw = null;

// DOM Selectors
const pdfViewport = document.getElementById('pdf-viewport');
const pdfViewer = document.getElementById('pdf-viewer');
const pageCurrentInput = document.getElementById('page-current');
const pageTotalSpan = document.getElementById('page-total');
const zoomSelect = document.getElementById('zoom-select');
const outlineContainer = document.getElementById('outline-container');
const thumbnailsContainer = document.getElementById('thumbnails-container');
const printContainer = document.getElementById('print-container');

// Signature Dialog Elements
const signatureDialog = document.getElementById('signature-dialog');
const signaturePadCanvas = document.getElementById('signature-pad-canvas');
const btnSignatureClear = document.getElementById('btn-signature-clear');
const btnSignatureUpload = document.getElementById('btn-signature-upload');
const btnSignaturePaste = document.getElementById('btn-signature-paste');
const btnSignatureApply = document.getElementById('btn-signature-apply');
const inputSignatureFile = document.getElementById('input-signature-file');

let signaturePadStrokes = [];
let signaturePadImage = null; // { dataURL, aspect }
let signaturePadDrawing = null;

// Markup tool buttons
const toolButtons = {
  cursor: document.getElementById('tool-cursor'),
  highlight: document.getElementById('tool-highlight'),
  underline: document.getElementById('tool-underline'),
  draw: document.getElementById('tool-draw'),
  text: document.getElementById('tool-text'),
  signature: document.getElementById('tool-signature'),
  eraser: document.getElementById('tool-eraser')
};

function notify(msg) {
  if (onNotifyCallback) onNotifyCallback(msg);
}

// Initialize listeners
export function initPdfViewer({ onPageChange, onMarkupChange, onFileDrop, onNotify, onConfirm }) {
  onPageChangeCallback = onPageChange;
  onMarkupChangeCallback = onMarkupChange;
  onFileDropCallback = onFileDrop;
  onNotifyCallback = onNotify;
  onConfirmCallback = onConfirm;

  // Zoom changes
  zoomSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'auto' || val === 'page-fit') {
      currentZoom = val;
    } else {
      currentZoom = parseFloat(val);
    }
    rerenderAll();
  });

  document.getElementById('zoom-in').addEventListener('click', () => adjustZoom(0.15));
  document.getElementById('zoom-out').addEventListener('click', () => adjustZoom(-0.15));

  // Page inputs
  pageCurrentInput.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (val >= 1 && val <= numPages) {
      scrollToPage(val);
    } else {
      pageCurrentInput.value = String(currentPage);
    }
  });

  document.getElementById('pdf-prev').addEventListener('click', () => {
    if (currentPage > 1) scrollToPage(currentPage - 1);
  });

  document.getElementById('pdf-next').addEventListener('click', () => {
    if (currentPage < numPages) scrollToPage(currentPage + 1);
  });

  // Tool buttons selection
  Object.entries(toolButtons).forEach(([tool, btn]) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      if ((tool === 'highlight' || tool === 'underline') && tryAnnotateSelection(tool)) {
        return;
      }
      if (tool === 'signature' && activeTool === 'signature') {
        openSignatureDialog();
        return;
      }
      setTool(tool);
      if (tool === 'signature' && !savedSignature) {
        openSignatureDialog();
      }
    });
  });

  document.getElementById('btn-undo-markup')?.addEventListener('click', undoLastMarkup);
  document.getElementById('btn-clear-page-markup')?.addEventListener('click', clearCurrentPageMarkup);
  document.getElementById('btn-print').addEventListener('click', printPdf);

  // Setup drag & drop PDF on viewport (stopPropagation prevents double handling by window)
  pdfViewport.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  pdfViewport.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0 && onFileDropCallback) {
      e.preventDefault();
      e.stopPropagation();
      onFileDropCallback(files[0]);
    }
  });

  // Paste clipboard image directly onto current PDF page when focused in PDF area
  document.addEventListener('paste', async (e) => {
    if (!pdfDoc) return;
    if (document.querySelector('dialog[open]')) return;
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable ||
        activeEl.closest('.cm-editor'))
    ) {
      return;
    }
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const imgData = await readFileAsImageData(file);
          if (imgData) {
            placeImageMarkup(currentPage - 1, { x: 0.35, y: 0.4 }, imgData.dataURL, imgData.aspect);
            notify('Pasted image onto page ' + currentPage);
          }
          break;
        }
      }
    }
  });

  // Keyboard Page, Undo, and Viewport Navigation
  window.addEventListener('keydown', (e) => {
    if (!pdfDoc) return;
    if (document.querySelector('dialog[open]')) return;

    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.tagName === 'SELECT' ||
        activeEl.isContentEditable ||
        activeEl.closest('.cm-editor'))
    ) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (!activeEl || activeEl === document.body || activeEl.closest('#pdf-viewport') || activeEl.closest('.top-bar')) {
        e.preventDefault();
        undoLastMarkup();
        return;
      }
    }

    // Do not intercept arrow/space keys when user is operating buttons/tabs
    if (activeEl && (activeEl.tagName === 'BUTTON' || activeEl.getAttribute('role') === 'tab')) {
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      if (currentPage < numPages) scrollToPage(currentPage + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (currentPage > 1) scrollToPage(currentPage - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      pdfViewport.scrollBy({ top: 50, behavior: 'auto' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pdfViewport.scrollBy({ top: -50, behavior: 'auto' });
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      const scrollAmount = pdfViewport.clientHeight * 0.8;
      pdfViewport.scrollBy({ top: e.shiftKey ? -scrollAmount : scrollAmount, behavior: 'smooth' });
    } else if (e.key === 'Home') {
      e.preventDefault();
      pdfViewport.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (e.key === 'End') {
      e.preventDefault();
      pdfViewport.scrollTo({ top: pdfViewport.scrollHeight, behavior: 'smooth' });
    }
  });

  // Reset programmatic scroll state when viewport scroll finishes (feature-detect scrollend)
  const onScrollEnd = () => {
    isProgrammaticScrolling = false;
    if (programmaticScrollTimeout) {
      clearTimeout(programmaticScrollTimeout);
      programmaticScrollTimeout = null;
    }
  };

  if ('onscrollend' in window) {
    pdfViewport.addEventListener('scrollend', onScrollEnd);
  } else {
    let scrollFallbackTimer = null;
    pdfViewport.addEventListener(
      'scroll',
      () => {
        clearTimeout(scrollFallbackTimer);
        scrollFallbackTimer = setTimeout(onScrollEnd, 120);
      },
      { passive: true }
    );
  }

  // Resize observer to handle viewport size changes for responsive zooming
  let lastViewportWidth = pdfViewport.clientWidth;
  let lastViewportHeight = pdfViewport.clientHeight;
  let resizeTimeout = null;
  const resizeObserver = new ResizeObserver(() => {
    if (currentZoom !== 'auto' && currentZoom !== 'page-fit') return;

    const currentWidth = pdfViewport.clientWidth;
    const currentHeight = pdfViewport.clientHeight;

    if (Math.abs(currentWidth - lastViewportWidth) > 5 || Math.abs(currentHeight - lastViewportHeight) > 5) {
      lastViewportWidth = currentWidth;
      lastViewportHeight = currentHeight;

      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        rerenderAll();
      }, 150);
    }
  });
  resizeObserver.observe(pdfViewport);

  initSignatureDialog();
  initGlobalTextSelectionHelper();
}

// Keep PDF.js TextLayer .selecting class synchronized for clean drag-selection
function initGlobalTextSelectionHelper() {
  document.addEventListener('pointerup', () => {
    document.querySelectorAll('.textLayer.selecting').forEach((el) => {
      el.classList.remove('selecting');
    });
  });

  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      document.querySelectorAll('.textLayer.selecting').forEach((el) => el.classList.remove('selecting'));
      return;
    }
    const range = sel.getRangeAt(0);
    document.querySelectorAll('.textLayer').forEach((layer) => {
      if (range.intersectsNode(layer)) {
        layer.classList.add('selecting');
      } else {
        layer.classList.remove('selecting');
      }
    });
  });
}

// Set active tool and sync ARIA pressed states
function setTool(tool) {
  activeTool = tool;
  Object.entries(toolButtons).forEach(([t, btn]) => {
    if (!btn) return;
    const isActive = t === tool;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  const overlays = document.querySelectorAll('.annotation-overlay-canvas');
  overlays.forEach((canvas) => {
    canvas.style.pointerEvents = tool === 'cursor' ? 'none' : 'auto';
  });
}

// Convert active PDF text selection to highlight/underline markups
function tryAnnotateSelection(tool) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;

  const range = sel.getRangeAt(0);
  const pageContainers = document.querySelectorAll('.pdf-page-container');
  let annotated = false;

  pageContainers.forEach((container) => {
    const pIdx = parseInt(container.id.replace('page-container-p', ''), 10);
    if (isNaN(pIdx)) return;
    const textLayer = container.querySelector('.textLayer');
    if (!textLayer || !range.intersectsNode(textLayer)) return;

    const cRect = container.getBoundingClientRect();
    if (cRect.width === 0 || cRect.height === 0) return;

    const rects = mergeLineRects(Array.from(range.getClientRects()), cRect);
    if (rects.length === 0) return;

    pushUndoSnapshot(pIdx);
    if (!markupData[pIdx]) markupData[pIdx] = [];

    rects.forEach((r) => {
      if (tool === 'highlight') {
        markupData[pIdx].push({
          type: 'highlight',
          color: 'rgba(255, 235, 59, 0.4)',
          rect: r
        });
      } else {
        markupData[pIdx].push({
          type: 'underline',
          color: '#005FAF',
          rect: r
        });
      }
    });

    const overlay = document.getElementById(`overlay-canvas-p${pIdx}`);
    if (overlay) drawPageMarkup(pIdx, overlay);
    annotated = true;
  });

  if (annotated) {
    sel.removeAllRanges();
    if (onMarkupChangeCallback) onMarkupChangeCallback();
    notify(tool === 'highlight' ? 'Highlighted selected text' : 'Underlined selected text');
  }

  return annotated;
}

function mergeLineRects(clientRects, containerRect) {
  const normalized = clientRects
    .filter((r) => r.width > 1 && r.height > 1)
    .filter(
      (r) =>
        r.right > containerRect.left &&
        r.left < containerRect.right &&
        r.bottom > containerRect.top &&
        r.top < containerRect.bottom
    )
    .map((r) => ({
      x: Math.max(0, (r.left - containerRect.left) / containerRect.width),
      y: Math.max(0, (r.top - containerRect.top) / containerRect.height),
      w: Math.min(1, r.width / containerRect.width),
      h: Math.min(1, r.height / containerRect.height)
    }));

  // Group rects on roughly the same line to avoid tiny fragmented boxes
  const merged = [];
  normalized.forEach((rect) => {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.y - rect.y) < 0.008 && Math.abs(prev.h - rect.h) < 0.008) {
      const minX = Math.min(prev.x, rect.x);
      const maxX = Math.max(prev.x + prev.w, rect.x + rect.w);
      prev.x = minX;
      prev.w = maxX - minX;
      prev.y = Math.min(prev.y, rect.y);
      prev.h = Math.max(prev.h, rect.h);
    } else {
      merged.push({ ...rect });
    }
  });
  return merged;
}

// Adjust zoom level relative to actual rendered scale
function adjustZoom(delta) {
  let z;
  if (typeof currentZoom === 'number') {
    z = currentZoom;
  } else {
    z = getPageDimensions(currentPage - 1).scale;
  }
  z = Math.round(Math.max(0.5, Math.min(3.0, z + delta)) * 100) / 100;
  currentZoom = z;
  syncZoomSelect(z);
  rerenderAll();
}

function syncZoomSelect(numericZoom) {
  const formatted = String(numericZoom);
  const matchingOption = Array.from(zoomSelect.options).find(
    (opt) => !opt.dataset.customZoom && parseFloat(opt.value) === numericZoom
  );

  let customOpt = zoomSelect.querySelector('option[data-custom-zoom="true"]');
  if (matchingOption) {
    if (customOpt) customOpt.remove();
    zoomSelect.value = matchingOption.value;
  } else {
    if (!customOpt) {
      customOpt = document.createElement('option');
      customOpt.dataset.customZoom = 'true';
      zoomSelect.appendChild(customOpt);
    }
    customOpt.value = formatted;
    customOpt.textContent = `${Math.round(numericZoom * 100)}%`;
    zoomSelect.value = formatted;
  }
}

export function getNumPages() {
  return numPages;
}

export function showViewerStatus(message, isError = false) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  if (isError) {
    empty.style.color = 'var(--md-sys-color-error)';
  }
  empty.textContent = message;
  pdfViewer.replaceChildren(empty);
}

// Set page markup
export function setMarkupData(data) {
  markupData = data || {};
  markupHistory.length = 0;
  renderedPages.forEach((pIdx) => {
    const overlay = document.getElementById(`overlay-canvas-p${pIdx}`);
    if (overlay) drawPageMarkup(pIdx, overlay);
  });
}

export function getMarkupData() {
  return markupData;
}

function pushUndoSnapshot(pIdx) {
  const existing = markupData[pIdx] ? structuredClone(markupData[pIdx]) : [];
  markupHistory.push({ pIdx, snapshot: existing });
  if (markupHistory.length > MAX_HISTORY) {
    markupHistory.shift();
  }
}

function undoLastMarkup() {
  if (markupHistory.length === 0) {
    notify('Nothing to undo');
    return;
  }
  const { pIdx, snapshot } = markupHistory.pop();
  markupData[pIdx] = snapshot;
  const overlay = document.getElementById(`overlay-canvas-p${pIdx}`);
  if (overlay) drawPageMarkup(pIdx, overlay);
  if (onMarkupChangeCallback) onMarkupChangeCallback();
  notify('Undid last annotation');
}

async function clearCurrentPageMarkup() {
  if (!pdfDoc) return;
  const pIdx = currentPage - 1;
  const shapes = markupData[pIdx] || [];
  if (shapes.length === 0) {
    notify('No annotations on this page');
    return;
  }

  let confirmed = true;
  if (onConfirmCallback) {
    confirmed = await onConfirmCallback({
      title: 'Clear Page Annotations',
      message: `Remove all ${shapes.length} annotation(s) on Page ${currentPage}? You can undo this immediately with Ctrl+Z.`,
      confirmLabel: 'Clear Page',
      cancelLabel: 'Cancel'
    });
  }
  if (!confirmed) return;

  pushUndoSnapshot(pIdx);
  markupData[pIdx] = [];
  const overlay = document.getElementById(`overlay-canvas-p${pIdx}`);
  if (overlay) drawPageMarkup(pIdx, overlay);
  if (onMarkupChangeCallback) onMarkupChangeCallback();
  notify(`Cleared annotations on page ${currentPage}`);
}

// Scroll to page (1-based)
export function scrollToPage(pageNum) {
  if (pageNum < 1 || pageNum > numPages || isNaN(pageNum)) return;
  const container = document.getElementById(`page-container-p${pageNum - 1}`);
  if (container) {
    isProgrammaticScrolling = true;
    if (programmaticScrollTimeout) clearTimeout(programmaticScrollTimeout);

    const maxScrollTop = Math.max(0, pdfViewport.scrollHeight - pdfViewport.clientHeight);
    const targetScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, container.offsetTop - Math.max(0, (pdfViewport.clientHeight - container.clientHeight) / 2))
    );
    pdfViewport.scrollTo({ top: targetScrollTop, behavior: 'smooth' });

    currentPage = pageNum;
    pageCurrentInput.value = String(currentPage);
    updateActiveStates(currentPage);

    if (onPageChangeCallback) {
      onPageChangeCallback(currentPage - 1);
    }

    programmaticScrollTimeout = setTimeout(() => {
      isProgrammaticScrolling = false;
    }, 600);
  }
}

// Load PDF from File object
export async function loadPdfFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  pdfFilename = file.name;
  return loadPdfData(arrayBuffer);
}

// Load PDF from ArrayBuffer data (clones input so caller's buffer is never detached)
export async function loadPdfData(arrayBuffer) {
  const sessionId = ++loadSessionId;
  cancelAllPageRenders();

  try {
    showViewerStatus('Loading PDF engine...');

    // Clone bytes before PDF.js transfers buffer to Web Worker
    const dataCopy = new Uint8Array(arrayBuffer).slice();
    const loadingTask = pdfjsLib.getDocument({ data: dataCopy });
    const loadedDoc = await loadingTask.promise;

    if (sessionId !== loadSessionId) {
      loadedDoc.destroy?.();
      return null;
    }

    pdfDoc = loadedDoc;
    numPages = pdfDoc.numPages;
    currentPage = 1;

    pageTotalSpan.textContent = String(numPages);
    pageCurrentInput.value = '1';
    pageCurrentInput.max = String(numPages);

    isProgrammaticScrolling = true;
    renderedPages.clear();
    intersectingPages.clear();
    pageDims = {};

    // Fetch page 1 dimensions immediately so first paint isn't blocked by N sequential pages
    const firstPage = await pdfDoc.getPage(1);
    if (sessionId !== loadSessionId) return null;
    const firstVp = firstPage.getViewport({ scale: 1.0 });
    defaultPageDim = { width: firstVp.width, height: firstVp.height };
    pageDims[0] = defaultPageDim;

    // Create container wrappers synchronously for exact ordering
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < numPages; i++) {
      const pageContainer = document.createElement('div');
      pageContainer.id = `page-container-p${i}`;
      pageContainer.className = 'pdf-page-container';
      fragment.appendChild(pageContainer);
    }
    pdfViewer.replaceChildren(fragment);

    // Trigger initial render & intersection observer right away
    setupObserver();
    loadOutline(sessionId);
    loadThumbnails(sessionId);

    // Background-fetch remaining page dimensions lazily in small batches
    prefetchPageDimensions(sessionId);

    if (onPageChangeCallback) onPageChangeCallback(0);

    setTimeout(() => {
      if (sessionId === loadSessionId) {
        isProgrammaticScrolling = false;
      }
    }, 500);

    return { name: pdfFilename, pagesCount: numPages };
  } catch (error) {
    console.error('Error loading PDF:', error);
    showViewerStatus(`Failed to load PDF: ${error?.message || String(error)}`, true);
    throw error;
  }
}

async function prefetchPageDimensions(sessionId) {
  for (let i = 1; i < numPages; i++) {
    if (sessionId !== loadSessionId || !pdfDoc) return;
    if (pageDims[i]) continue;
    try {
      const page = await pdfDoc.getPage(i + 1);
      if (sessionId !== loadSessionId) return;
      const vp = page.getViewport({ scale: 1.0 });
      pageDims[i] = { width: vp.width, height: vp.height };

      if (Math.abs(vp.width - defaultPageDim.width) > 1 || Math.abs(vp.height - defaultPageDim.height) > 1) {
        const container = document.getElementById(`page-container-p${i}`);
        if (container) {
          const { width, height, scale } = getPageDimensions(i);
          container.style.width = `${width}px`;
          container.style.height = `${height}px`;
          container.style.setProperty('--scale-factor', String(scale));
        }
      }
    } catch {
      // Ignore individual page dimension read errors
    }
  }
}

function cancelAllPageRenders() {
  activeRenderControllers.forEach((ctrl) => {
    ctrl.cancelled = true;
    ctrl.renderTask?.cancel?.();
    ctrl.textLayerBuilder?.cancel?.();
  });
  activeRenderControllers.clear();
}

// Rerender all pages on zoom changes while preserving scroll anchor
function rerenderAll() {
  if (!pdfDoc) return;

  const anchorPageIdx = currentPage - 1;
  const anchorContainer = document.getElementById(`page-container-p${anchorPageIdx}`);
  let relativeOffset = 0;
  if (anchorContainer && anchorContainer.clientHeight > 0) {
    relativeOffset = (pdfViewport.scrollTop - anchorContainer.offsetTop) / anchorContainer.clientHeight;
  }

  for (let i = 0; i < numPages; i++) {
    const container = document.getElementById(`page-container-p${i}`);
    if (container) {
      const { width, height, scale } = getPageDimensions(i);
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
      container.style.setProperty('--scale-factor', String(scale));
    }
  }

  if (anchorContainer) {
    isProgrammaticScrolling = true;
    pdfViewport.scrollTop = Math.max(0, anchorContainer.offsetTop + relativeOffset * anchorContainer.clientHeight);
    setTimeout(() => {
      isProgrammaticScrolling = false;
    }, 150);
  }

  cancelAllPageRenders();
  const visiblePages = Array.from(renderedPages);
  renderedPages.clear();
  visiblePages.forEach((pIdx) => {
    renderPage(pIdx);
  });
}

// Get accurate page dimensions at current zoom using real PDF page dimensions
function getPageDimensions(pIdx) {
  const dims = pageDims[pIdx] || defaultPageDim;
  const baseWidth = dims.width || 612;
  const baseHeight = dims.height || 792;

  let scale = 1.0;
  if (currentZoom === 'auto') {
    const vw = Math.max(200, pdfViewport.clientWidth - 48);
    scale = Math.min(2.0, vw / baseWidth);
  } else if (currentZoom === 'page-fit') {
    const vw = Math.max(200, pdfViewport.clientWidth - 48);
    const vh = Math.max(200, pdfViewport.clientHeight - 48);
    scale = Math.min(vw / baseWidth, vh / baseHeight);
  } else {
    scale = currentZoom;
  }

  if (isNaN(scale) || scale <= 0) {
    scale = 1.0;
  }

  return {
    width: Math.round(baseWidth * scale),
    height: Math.round(baseHeight * scale),
    scale
  };
}

function createPagePlaceholder(pageNumber) {
  const placeholder = document.createElement('div');
  placeholder.className = 'pdf-page-placeholder';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  const label = document.createElement('span');
  label.textContent = `Loading Page ${pageNumber}...`;
  placeholder.append(spinner, label);
  return placeholder;
}

// Set up Intersection Observer for Virtualization
function setupObserver() {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }

  for (let i = 0; i < numPages; i++) {
    const container = document.getElementById(`page-container-p${i}`);
    if (container) {
      const { width, height, scale } = getPageDimensions(i);
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
      container.style.setProperty('--scale-factor', String(scale));
      container.replaceChildren(createPagePlaceholder(i + 1));
    }
  }

  intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const pIdx = parseInt(entry.target.id.replace('page-container-p', ''), 10);
        if (!isNaN(pIdx)) {
          if (entry.isIntersecting) {
            intersectingPages.add(pIdx);
            renderPageWindow(pIdx);
          } else {
            intersectingPages.delete(pIdx);
          }
        }
      });

      updateDominantPage();
    },
    {
      root: pdfViewport,
      threshold: [0.1, 0.25, 0.5, 0.75, 0.9]
    }
  );

  for (let i = 0; i < numPages; i++) {
    const container = document.getElementById(`page-container-p${i}`);
    if (container) intersectionObserver.observe(container);
  }
}

// Update highlighting states for thumbnails and outline
function updateActiveStates(pageNum) {
  const thumbnails = document.querySelectorAll('.thumbnail-wrapper');
  thumbnails.forEach((el, idx) => {
    const isActive = idx === pageNum - 1;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-current', isActive ? 'page' : 'false');
    if (isActive && thumbnailsContainer.offsetParent !== null) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });

  document.querySelectorAll('.outline-node').forEach((node) => {
    const destPage = parseInt(node.getAttribute('data-page'), 10);
    node.classList.toggle('active', destPage === pageNum);
  });
}

function updateCurrentPage(pageNum) {
  if (pageNum < 1 || pageNum > numPages || isNaN(pageNum)) return;
  if (currentPage !== pageNum) {
    currentPage = pageNum;
    pageCurrentInput.value = String(currentPage);
    updateActiveStates(currentPage);

    if (onPageChangeCallback) {
      onPageChangeCallback(pageNum - 1);
    }

    const farPages = [];
    renderedPages.forEach((pIdx) => {
      if (Math.abs(pIdx - (pageNum - 1)) > 10) {
        farPages.push(pIdx);
      }
    });
    farPages.forEach((pIdx) => dropPage(pIdx));
  }
}

function updateDominantPage() {
  if (isProgrammaticScrolling || intersectingPages.size === 0) return;

  let maxVisibleHeight = 0;
  let dominantPage = currentPage;
  const viewportRect = pdfViewport.getBoundingClientRect();

  const sortedPages = Array.from(intersectingPages).sort((a, b) => a - b);

  sortedPages.forEach((pIdx) => {
    if (isNaN(pIdx) || pIdx < 0 || pIdx >= numPages) return;
    const container = document.getElementById(`page-container-p${pIdx}`);
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const visibleTop = Math.max(rect.top, viewportRect.top);
    const visibleBottom = Math.min(rect.bottom, viewportRect.bottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);

    if (visibleHeight > maxVisibleHeight) {
      maxVisibleHeight = visibleHeight;
      dominantPage = pIdx + 1;
    }
  });

  if (dominantPage !== currentPage) {
    updateCurrentPage(dominantPage);
  }
}

function renderPageWindow(centerIdx) {
  const pagesToRender = new Set();
  pagesToRender.add(centerIdx);
  if (centerIdx > 0) pagesToRender.add(centerIdx - 1);
  if (centerIdx < numPages - 1) pagesToRender.add(centerIdx + 1);

  pagesToRender.forEach((pIdx) => {
    if (!renderedPages.has(pIdx)) {
      renderPage(pIdx);
    }
  });
}

// Render a single PDF page with official TextLayerBuilder & cancellation safety
async function renderPage(pIdx) {
  if (!pdfDoc || renderedPages.has(pIdx)) return;
  renderedPages.add(pIdx);

  const sessionId = loadSessionId;
  const container = document.getElementById(`page-container-p${pIdx}`);
  if (!container) return;

  // Cancel any prior in-flight render on this page
  const prevCtrl = activeRenderControllers.get(pIdx);
  if (prevCtrl) {
    prevCtrl.cancelled = true;
    prevCtrl.renderTask?.cancel?.();
    prevCtrl.textLayerBuilder?.cancel?.();
  }

  const ctrl = { cancelled: false, renderTask: null, textLayerBuilder: null };
  activeRenderControllers.set(pIdx, ctrl);

  try {
    const page = await pdfDoc.getPage(pIdx + 1);
    if (ctrl.cancelled || sessionId !== loadSessionId) return;

    const baseVp = page.getViewport({ scale: 1.0 });
    pageDims[pIdx] = { width: baseVp.width, height: baseVp.height };

    const { width, height, scale } = getPageDimensions(pIdx);
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    container.style.setProperty('--scale-factor', String(scale));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderScale = scale * Math.max(1.5, dpr);
    const viewport = page.getViewport({ scale: renderScale });

    const fragment = document.createDocumentFragment();

    // 1. Main page canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    fragment.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    ctrl.renderTask = page.render({ canvasContext: ctx, viewport });
    await ctrl.renderTask.promise;
    if (ctrl.cancelled || sessionId !== loadSessionId) return;

    // 2. Official PDF.js TextLayerBuilder for accurate glyph-aligned selection
    const textViewport = page.getViewport({ scale });
    const textLayerBuilder = new TextLayerBuilder({ pdfPage: page });
    ctrl.textLayerBuilder = textLayerBuilder;
    textLayerBuilder.div.style.setProperty('--scale-factor', String(scale));
    await textLayerBuilder.render({ viewport: textViewport });
    if (ctrl.cancelled || sessionId !== loadSessionId) return;

    fragment.appendChild(textLayerBuilder.div);

    // 3. Annotation canvas overlay
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = `overlay-canvas-p${pIdx}`;
    overlayCanvas.className = 'annotation-overlay-canvas';
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
    overlayCanvas.style.pointerEvents = activeTool === 'cursor' ? 'none' : 'auto';
    fragment.appendChild(overlayCanvas);

    bindDrawingListeners(pIdx, overlayCanvas);
    drawPageMarkup(pIdx, overlayCanvas);

    container.replaceChildren(fragment);
  } catch (error) {
    if (error?.name === 'RenderingCancelledException' || ctrl.cancelled) return;
    console.error('Error rendering page:', pIdx + 1, error);
    const errDiv = document.createElement('div');
    errDiv.className = 'empty-state';
    errDiv.textContent = `Failed to render page: ${error?.message || String(error)}`;
    container.replaceChildren(errDiv);
  } finally {
    if (activeRenderControllers.get(pIdx) === ctrl) {
      activeRenderControllers.delete(pIdx);
    }
  }
}

function dropPage(pIdx) {
  if (!renderedPages.has(pIdx)) return;
  renderedPages.delete(pIdx);

  const ctrl = activeRenderControllers.get(pIdx);
  if (ctrl) {
    ctrl.cancelled = true;
    ctrl.renderTask?.cancel?.();
    ctrl.textLayerBuilder?.cancel?.();
    activeRenderControllers.delete(pIdx);
  }

  const container = document.getElementById(`page-container-p${pIdx}`);
  if (container) {
    container.replaceChildren(createPagePlaceholder(pIdx + 1));
  }
}

// --- ANNOTATIONS / DRAWING OVERLAY LOGIC (Pointer Events + Incremental Render) ---

function getNormalizedPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  return {
    x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
  };
}

function bindDrawingListeners(pIdx, canvas) {
  const ctx = canvas.getContext('2d');

  const onPointerDown = (e) => {
    if (activeTool === 'cursor') return;
    if (!e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    e.preventDefault();
    const pos = getNormalizedPos(e, canvas);

    if (activeTool === 'text') {
      addTextInput(pIdx, canvas, pos);
      return;
    }

    if (activeTool === 'signature') {
      if (!savedSignature) {
        pendingSignaturePlacement = { pIdx, pos };
        openSignatureDialog();
      } else {
        placeSavedSignature(pIdx, pos);
      }
      return;
    }

    if (activeTool === 'eraser') {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointer events may not have an active pointer id
      }
      const erased = eraseNearPoint(pIdx, pos, true);
      activePointerDraw = { pIdx, canvas, pointerId: e.pointerId, mode: 'eraser', erasedAny: erased };
      return;
    }

    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer events may not have an active pointer id
    }

    if (activeTool === 'draw') {
      const stroke = {
        type: 'draw',
        color: '#005FAF',
        width: 3,
        points: [[pos.x, pos.y]]
      };
      activePointerDraw = { pIdx, canvas, pointerId: e.pointerId, mode: 'draw', stroke, lastDrawnIdx: 0 };
      drawStrokeDot(ctx, canvas.width, canvas.height, stroke, pos.x, pos.y);
    } else if (activeTool === 'highlight' || activeTool === 'underline') {
      const stroke = {
        type: activeTool,
        color: activeTool === 'highlight' ? 'rgba(255, 235, 59, 0.4)' : '#005FAF',
        rect: { x: pos.x, y: pos.y, w: 0, h: 0 }
      };
      activePointerDraw = { pIdx, canvas, pointerId: e.pointerId, mode: activeTool, stroke, boxStart: pos };
    }
  };

  const onPointerMove = (e) => {
    if (!activePointerDraw || activePointerDraw.pointerId !== e.pointerId || activePointerDraw.canvas !== canvas) {
      return;
    }
    e.preventDefault();
    const pos = getNormalizedPos(e, canvas);

    if (activePointerDraw.mode === 'eraser') {
      if (eraseNearPoint(pIdx, pos, !activePointerDraw.erasedAny)) {
        activePointerDraw.erasedAny = true;
      }
      return;
    }

    if (activePointerDraw.mode === 'draw') {
      const pts = activePointerDraw.stroke.points;
      const prev = pts[pts.length - 1];
      // Skip micro-jitter < 0.001 normalized distance
      if (Math.hypot(pos.x - prev[0], pos.y - prev[1]) < 0.001) return;

      pts.push([pos.x, pos.y]);
      drawIncrementalSegment(ctx, canvas.width, canvas.height, activePointerDraw.stroke, prev, [pos.x, pos.y]);
    } else if (activePointerDraw.mode === 'highlight' || activePointerDraw.mode === 'underline') {
      const start = activePointerDraw.boxStart;
      const w = pos.x - start.x;
      const h = pos.y - start.y;
      activePointerDraw.stroke.rect = {
        x: w < 0 ? pos.x : start.x,
        y: h < 0 ? pos.y : start.y,
        w: Math.abs(w),
        h: Math.abs(h)
      };
      drawPageMarkup(pIdx, canvas);
      drawShape(ctx, canvas.width, canvas.height, activePointerDraw.stroke);
    }
  };

  const finishPointerDraw = (e) => {
    if (!activePointerDraw || activePointerDraw.pointerId !== e.pointerId || activePointerDraw.canvas !== canvas) {
      return;
    }
    try {
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }

    const drawState = activePointerDraw;
    activePointerDraw = null;

    if (drawState.mode === 'eraser') {
      if (drawState.erasedAny && onMarkupChangeCallback) {
        onMarkupChangeCallback();
      }
      return;
    }

    const stroke = drawState.stroke;
    if (!stroke) return;

    // Ignore accidental tiny zero-area highlight/underline clicks
    if ((stroke.type === 'highlight' || stroke.type === 'underline') && stroke.rect.w < 0.004 && stroke.rect.h < 0.004) {
      drawPageMarkup(pIdx, canvas);
      return;
    }

    pushUndoSnapshot(pIdx);
    if (!markupData[pIdx]) markupData[pIdx] = [];
    markupData[pIdx].push(stroke);

    drawPageMarkup(pIdx, canvas);
    if (onMarkupChangeCallback) onMarkupChangeCallback();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', finishPointerDraw);
  canvas.addEventListener('pointercancel', finishPointerDraw);
}

function eraseNearPoint(pIdx, pos, pushSnapshotBeforeFirstErase) {
  const shapes = markupData[pIdx];
  if (!shapes || shapes.length === 0) return false;

  const threshold = 0.025;
  const remaining = [];
  let removed = false;

  for (const shape of shapes) {
    if (isPointNearShape(pos, shape, threshold)) {
      removed = true;
    } else {
      remaining.push(shape);
    }
  }

  if (!removed) return false;

  if (pushSnapshotBeforeFirstErase) {
    pushUndoSnapshot(pIdx);
  }
  markupData[pIdx] = remaining;

  const overlay = document.getElementById(`overlay-canvas-p${pIdx}`);
  if (overlay) drawPageMarkup(pIdx, overlay);
  return true;
}

function isPointNearShape(pos, shape, tol) {
  if (shape.type === 'draw' && Array.isArray(shape.points)) {
    for (let i = 0; i < shape.points.length; i++) {
      const [px, py] = shape.points[i];
      if (Math.hypot(pos.x - px, pos.y - py) <= tol) return true;
      if (i > 0) {
        const [ax, ay] = shape.points[i - 1];
        if (distToSegment(pos.x, pos.y, ax, ay, px, py) <= tol) return true;
      }
    }
    return false;
  }

  if (shape.type === 'signature' && Array.isArray(shape.strokes)) {
    for (const stroke of shape.strokes) {
      for (let i = 0; i < stroke.length; i++) {
        const [px, py] = stroke[i];
        if (Math.hypot(pos.x - px, pos.y - py) <= tol) return true;
        if (i > 0) {
          const [ax, ay] = stroke[i - 1];
          if (distToSegment(pos.x, pos.y, ax, ay, px, py) <= tol) return true;
        }
      }
    }
    return false;
  }

  if (shape.type === 'highlight' && shape.rect) {
    const r = shape.rect;
    return pos.x >= r.x - tol && pos.x <= r.x + r.w + tol && pos.y >= r.y - tol && pos.y <= r.y + r.h + tol;
  }

  if (shape.type === 'underline' && shape.rect) {
    const r = shape.rect;
    const lineY = r.y + r.h;
    return distToSegment(pos.x, pos.y, r.x, lineY, r.x + r.w, lineY) <= tol;
  }

  if (shape.type === 'text') {
    const approxWidth = Math.max(0.06, (shape.text?.length || 1) * 0.012);
    return pos.x >= shape.x - tol && pos.x <= shape.x + approxWidth + tol && Math.abs(pos.y - shape.y) <= tol * 1.4;
  }

  if (shape.type === 'image' && shape.rect) {
    const r = shape.rect;
    return pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h;
  }

  return false;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Add floating text input clamped inside page bounds (never triggers container scroll)
function addTextInput(pIdx, canvas, pos) {
  const container = canvas.parentElement;
  if (!container) return;

  // Remove any stale active text input first
  container.querySelector('.pdf-floating-text-input')?.remove();

  const { scale } = getPageDimensions(pIdx);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'm3-input-page pdf-floating-text-input';
  input.setAttribute('aria-label', 'Page text annotation');
  input.placeholder = 'Type text...';

  const nearRightEdge = pos.x > 0.72;
  const nearTopEdge = pos.y < 0.05;
  const clampedX = Math.max(0.02, Math.min(0.98, pos.x));
  const clampedY = Math.max(0.03, Math.min(0.97, pos.y));

  input.style.left = `${clampedX * 100}%`;
  input.style.top = `${clampedY * 100}%`;
  input.style.fontSize = `${Math.max(12, Math.round(14 * scale))}px`;

  if (nearRightEdge) {
    input.style.transform = nearTopEdge ? 'translate(-100%, 0)' : 'translate(-100%, -100%)';
  } else {
    input.style.transform = nearTopEdge ? 'translate(0, 0)' : 'translate(0, -100%)';
  }

  container.appendChild(input);
  input.focus({ preventScroll: true });

  // Compute saved x aligned with the rendered text start
  const saveX = nearRightEdge ? Math.max(0.02, clampedX - 0.2) : clampedX;

  let settled = false;
  const commit = (shouldSave) => {
    if (settled) return;
    settled = true;

    if (shouldSave) {
      const text = input.value.trim();
      if (text) {
        pushUndoSnapshot(pIdx);
        if (!markupData[pIdx]) markupData[pIdx] = [];
        markupData[pIdx].push({
          type: 'text',
          color: '#1A1C1E',
          text,
          x: saveX,
          y: clampedY
        });
        drawPageMarkup(pIdx, canvas);
        if (onMarkupChangeCallback) onMarkupChangeCallback();
      }
    }
    input.remove();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      commit(false);
    }
  });

  input.addEventListener('blur', () => {
    commit(true);
  });
}

// --- SIGNATURE DIALOG (Draw / Upload / Clipboard Paste) ---

function initSignatureDialog() {
  if (!signatureDialog || !signaturePadCanvas) return;

  const padCtx = signaturePadCanvas.getContext('2d');

  const clearPad = () => {
    signaturePadStrokes = [];
    signaturePadImage = null;
    padCtx.clearRect(0, 0, signaturePadCanvas.width, signaturePadCanvas.height);
  };

  const redrawPad = () => {
    padCtx.clearRect(0, 0, signaturePadCanvas.width, signaturePadCanvas.height);
    if (signaturePadImage) {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(
          signaturePadCanvas.width / img.width,
          signaturePadCanvas.height / img.height
        );
        const w = img.width * ratio;
        const h = img.height * ratio;
        padCtx.drawImage(
          img,
          (signaturePadCanvas.width - w) / 2,
          (signaturePadCanvas.height - h) / 2,
          w,
          h
        );
      };
      img.src = signaturePadImage.dataURL;
      return;
    }

    padCtx.strokeStyle = '#001D40';
    padCtx.fillStyle = '#001D40';
    padCtx.lineWidth = 3;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';

    signaturePadStrokes.forEach((stroke) => {
      if (stroke.length === 1) {
        padCtx.beginPath();
        padCtx.arc(
          stroke[0][0] * signaturePadCanvas.width,
          stroke[0][1] * signaturePadCanvas.height,
          1.5,
          0,
          Math.PI * 2
        );
        padCtx.fill();
      } else if (stroke.length > 1) {
        padCtx.beginPath();
        padCtx.moveTo(stroke[0][0] * signaturePadCanvas.width, stroke[0][1] * signaturePadCanvas.height);
        for (let i = 1; i < stroke.length; i++) {
          padCtx.lineTo(stroke[i][0] * signaturePadCanvas.width, stroke[i][1] * signaturePadCanvas.height);
        }
        padCtx.stroke();
      }
    });
  };

  signaturePadCanvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try {
      signaturePadCanvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic pointer capture error
    }
    signaturePadImage = null;
    const rect = signaturePadCanvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const stroke = [[nx, ny]];
    signaturePadStrokes.push(stroke);
    signaturePadDrawing = { pointerId: e.pointerId, stroke };
    redrawPad();
  });

  signaturePadCanvas.addEventListener('pointermove', (e) => {
    if (!signaturePadDrawing || signaturePadDrawing.pointerId !== e.pointerId) return;
    e.preventDefault();
    const rect = signaturePadCanvas.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    signaturePadDrawing.stroke.push([nx, ny]);
    redrawPad();
  });

  const endPadStroke = (e) => {
    if (!signaturePadDrawing || signaturePadDrawing.pointerId !== e.pointerId) return;
    signaturePadDrawing = null;
  };
  signaturePadCanvas.addEventListener('pointerup', endPadStroke);
  signaturePadCanvas.addEventListener('pointercancel', endPadStroke);

  btnSignatureClear.addEventListener('click', clearPad);

  btnSignatureUpload.addEventListener('click', () => {
    inputSignatureFile.click();
  });

  inputSignatureFile.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const imgData = await readFileAsImageData(file);
      if (imgData) {
        signaturePadStrokes = [];
        signaturePadImage = imgData;
        redrawPad();
      }
    }
    inputSignatureFile.value = '';
  });

  // Clipboard paste inside signature dialog
  signatureDialog.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const imgData = await readFileAsImageData(file);
          if (imgData) {
            signaturePadStrokes = [];
            signaturePadImage = imgData;
            redrawPad();
          }
          break;
        }
      }
    }
  });

  btnSignaturePaste.addEventListener('click', async () => {
    if (!navigator.clipboard?.read) {
      notify('Press Ctrl+V or Cmd+V inside this dialog to paste a signature image.');
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const imgData = await readFileAsImageData(blob);
          if (imgData) {
            signaturePadStrokes = [];
            signaturePadImage = imgData;
            redrawPad();
            return;
          }
        }
      }
      notify('No image found in clipboard. Copy an image or draw your signature above.');
    } catch {
      notify('Clipboard read denied. Press Ctrl+V or Cmd+V inside the dialog instead.');
    }
  });

  btnSignatureApply.addEventListener('click', () => {
    if (signaturePadImage) {
      savedSignature = {
        kind: 'image',
        dataURL: signaturePadImage.dataURL,
        aspect: signaturePadImage.aspect
      };
    } else if (signaturePadStrokes.length > 0) {
      savedSignature = {
        kind: 'strokes',
        strokes: structuredClone(signaturePadStrokes),
        aspect: signaturePadCanvas.width / signaturePadCanvas.height
      };
    } else {
      notify('Draw, upload, or paste a signature first.');
      return;
    }

    signatureDialog.close();
    setTool('signature');

    if (pendingSignaturePlacement) {
      const { pIdx, pos } = pendingSignaturePlacement;
      pendingSignaturePlacement = null;
      placeSavedSignature(pIdx, pos);
    } else {
      notify('Signature ready — click anywhere on a PDF page to place it.');
    }
  });

  signatureDialog.addEventListener('close', () => {
    pendingSignaturePlacement = null;
  });
}

function openSignatureDialog() {
  if (!signatureDialog) return;
  if (!signatureDialog.open) {
    signatureDialog.showModal();
  }
}

async function readFileAsImageData(blobOrFile) {
  const dataURL = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blobOrFile);
  });
  if (!dataURL || typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
    return null;
  }
  const aspect = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0 ? img.width / img.height : 2.5);
    img.onerror = () => resolve(2.5);
    img.src = dataURL;
  });
  return { dataURL, aspect };
}

function placeSavedSignature(pIdx, pos) {
  if (!savedSignature) return;
  const dims = pageDims[pIdx] || defaultPageDim;
  const pageAspect = dims.width / dims.height;

  if (savedSignature.kind === 'image') {
    placeImageMarkup(pIdx, pos, savedSignature.dataURL, savedSignature.aspect);
    return;
  }

  // Place vector signature normalized around pos, clamped inside page bounds
  const boxW = 0.24;
  const boxH = (boxW * pageAspect) / (savedSignature.aspect || 2.8);
  const originX = Math.max(0.02, Math.min(1 - boxW - 0.02, pos.x - boxW / 2));
  const originY = Math.max(0.02, Math.min(1 - boxH - 0.02, pos.y - boxH / 2));

  const mappedStrokes = savedSignature.strokes.map((stroke) =>
    stroke.map(([sx, sy]) => [originX + sx * boxW, originY + sy * boxH])
  );

  pushUndoSnapshot(pIdx);
  if (!markupData[pIdx]) markupData[pIdx] = [];
  markupData[pIdx].push({
    type: 'signature',
    color: '#001D40',
    width: 2.2,
    strokes: mappedStrokes
  });

  const canvas = document.getElementById(`overlay-canvas-p${pIdx}`);
  if (canvas) drawPageMarkup(pIdx, canvas);
  if (onMarkupChangeCallback) onMarkupChangeCallback();
}

function placeImageMarkup(pIdx, pos, dataURL, aspect = 2.0) {
  const dims = pageDims[pIdx] || defaultPageDim;
  const pageAspect = dims.width / dims.height;
  const boxW = 0.25;
  const boxH = Math.min(0.4, (boxW * pageAspect) / (aspect || 2.0));
  const x = Math.max(0.02, Math.min(1 - boxW - 0.02, pos.x - boxW / 2));
  const y = Math.max(0.02, Math.min(1 - boxH - 0.02, pos.y - boxH / 2));

  pushUndoSnapshot(pIdx);
  if (!markupData[pIdx]) markupData[pIdx] = [];
  markupData[pIdx].push({
    type: 'image',
    dataURL,
    rect: { x, y, w: boxW, h: boxH }
  });

  const canvas = document.getElementById(`overlay-canvas-p${pIdx}`);
  if (canvas) drawPageMarkup(pIdx, canvas);
  if (onMarkupChangeCallback) onMarkupChangeCallback();
}

// --- CANVAS SHAPE RENDERING ---

function drawPageMarkup(pIdx, canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const shapes = markupData[pIdx] || [];
  shapes.forEach((shape) => {
    drawShape(ctx, canvas.width, canvas.height, shape, () => drawPageMarkup(pIdx, canvas));
  });
}

function drawStrokeDot(ctx, width, height, stroke, nx, ny) {
  ctx.save();
  ctx.fillStyle = stroke.color;
  const radius = Math.max(1.5, ((stroke.width || 3) * (width / 612)) / 2);
  ctx.beginPath();
  ctx.arc(nx * width, ny * height, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawIncrementalSegment(ctx, width, height, stroke, p1, p2) {
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = (stroke.width || 3) * (width / 612);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p1[0] * width, p1[1] * height);
  ctx.lineTo(p2[0] * width, p2[1] * height);
  ctx.stroke();
  ctx.restore();
}

function drawShape(ctx, width, height, shape, onAsyncImageReady = null) {
  ctx.save();
  ctx.strokeStyle = shape.color || '#005FAF';
  ctx.fillStyle = shape.color || '#005FAF';
  ctx.lineWidth = (shape.width || 3) * (width / 612);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (shape.type === 'draw') {
    const pts = shape.points || [];
    if (pts.length === 1) {
      drawStrokeDot(ctx, width, height, shape, pts[0][0], pts[0][1]);
    } else if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * width, pts[0][1] * height);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] * width, pts[i][1] * height);
      }
      ctx.stroke();
    }
  } else if (shape.type === 'signature' && Array.isArray(shape.strokes)) {
    shape.strokes.forEach((pts) => {
      if (pts.length === 1) {
        drawStrokeDot(ctx, width, height, shape, pts[0][0], pts[0][1]);
      } else if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * width, pts[0][1] * height);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i][0] * width, pts[i][1] * height);
        }
        ctx.stroke();
      }
    });
  } else if (shape.type === 'highlight' && shape.rect) {
    const r = shape.rect;
    ctx.fillRect(r.x * width, r.y * height, r.w * width, r.h * height);
  } else if (shape.type === 'underline' && shape.rect) {
    const r = shape.rect;
    ctx.beginPath();
    ctx.moveTo(r.x * width, (r.y + r.h) * height);
    ctx.lineTo((r.x + r.w) * width, (r.y + r.h) * height);
    ctx.stroke();
  } else if (shape.type === 'text') {
    ctx.font = `${Math.round(14 * (width / 612))}px sans-serif`;
    ctx.fillText(shape.text, shape.x * width, shape.y * height);
  } else if (shape.type === 'image' && shape.dataURL && shape.rect) {
    const r = shape.rect;
    let img = imageCache.get(shape.dataURL);
    if (!img) {
      img = new Image();
      img.onload = () => {
        if (onAsyncImageReady) onAsyncImageReady();
      };
      img.src = shape.dataURL;
      imageCache.set(shape.dataURL, img);
    }
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, r.x * width, r.y * height, r.w * width, r.h * height);
    }
  }

  ctx.restore();
}

// --- DOCUMENT OUTLINE (TAB 1) ---

async function loadOutline(sessionId) {
  outlineContainer.replaceChildren();
  if (!pdfDoc) return;

  try {
    const outline = await pdfDoc.getOutline();
    if (sessionId !== loadSessionId) return;

    if (!outline || outline.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No outline index found in PDF.';
      outlineContainer.replaceChildren(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'outline-list';

    const renderNodes = async (nodes, parentEl, depth = 0) => {
      for (const node of nodes) {
        if (sessionId !== loadSessionId) return;

        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'outline-node';
        item.textContent = node.title;
        item.style.paddingInlineStart = `${depth * 12 + 12}px`;

        let destPageNum = null;
        if (node.dest) {
          try {
            const explicitDest = typeof node.dest === 'string' ? await pdfDoc.getDestination(node.dest) : node.dest;
            if (explicitDest && explicitDest[0]) {
              const pIndex = await pdfDoc.getPageIndex(explicitDest[0]);
              destPageNum = pIndex + 1;
            }
          } catch (err) {
            console.error('Dest outline resolving err:', err);
          }
        }

        if (destPageNum) {
          item.setAttribute('data-page', String(destPageNum));
          item.addEventListener('click', () => {
            scrollToPage(destPageNum);
          });
        } else {
          item.disabled = true;
        }

        parentEl.appendChild(item);

        if (node.items && node.items.length > 0) {
          await renderNodes(node.items, parentEl, depth + 1);
        }
      }
    };

    await renderNodes(outline, list);
    if (sessionId !== loadSessionId) return;
    outlineContainer.replaceChildren(list);
  } catch (error) {
    console.error('Outline loading error:', error);
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Outline unavailable';
    outlineContainer.replaceChildren(empty);
  }
}

// --- LAZY INTERSECTION-OBSERVER THUMBNAILS (TAB 2) ---

function loadThumbnails(sessionId) {
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
    thumbnailObserver = null;
  }
  thumbnailsContainer.replaceChildren();
  if (!pdfDoc) return;

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < numPages; i++) {
    const thumbWrapper = document.createElement('button');
    thumbWrapper.type = 'button';
    thumbWrapper.className = `thumbnail-wrapper ${i === 0 ? 'active' : ''}`;
    thumbWrapper.dataset.pageIndex = String(i);
    thumbWrapper.setAttribute('aria-label', `Go to page ${i + 1}`);
    thumbWrapper.setAttribute('aria-current', i === 0 ? 'page' : 'false');
    thumbWrapper.addEventListener('click', () => {
      scrollToPage(i + 1);
    });

    const canvas = document.createElement('canvas');
    canvas.className = 'thumbnail-canvas';
    canvas.width = 120;
    canvas.height = 156;
    thumbWrapper.appendChild(canvas);

    const label = document.createElement('div');
    label.className = 'thumbnail-label';
    label.textContent = `Page ${i + 1}`;
    thumbWrapper.appendChild(label);

    fragment.appendChild(thumbWrapper);
  }
  thumbnailsContainer.replaceChildren(fragment);

  thumbnailObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const wrapper = entry.target;
        if (wrapper.dataset.rendered === 'true') return;
        wrapper.dataset.rendered = 'true';
        thumbnailObserver?.unobserve(wrapper);

        const pIdx = parseInt(wrapper.dataset.pageIndex, 10);
        const canvas = wrapper.querySelector('canvas');
        if (!isNaN(pIdx) && canvas) {
          renderThumbnailCanvas(pIdx, canvas, sessionId);
        }
      });
    },
    { root: thumbnailsContainer, rootMargin: '200px 0px', threshold: 0.01 }
  );

  thumbnailsContainer.querySelectorAll('.thumbnail-wrapper').forEach((wrapper) => {
    thumbnailObserver.observe(wrapper);
  });
}

async function renderThumbnailCanvas(pIdx, canvas, sessionId) {
  if (!pdfDoc || sessionId !== loadSessionId) return;
  try {
    const page = await pdfDoc.getPage(pIdx + 1);
    if (sessionId !== loadSessionId) return;
    const viewport = page.getViewport({ scale: 0.22 });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') {
      console.error('Failed rendering thumbnail for page:', pIdx + 1, err);
    }
  }
}

// --- TABS & SIDEBAR PANEL COLLAPSES ---

const tabOutline = document.getElementById('tab-outline');
const tabThumbnails = document.getElementById('tab-thumbnails');
const leftPanel = document.getElementById('left-panel');
const btnCollapseLeft = document.getElementById('btn-collapse-left');
const btnExpandLeft = document.getElementById('btn-expand-left');

function selectLeftTab(which) {
  const isOutline = which === 'outline';
  tabOutline.classList.toggle('active', isOutline);
  tabOutline.setAttribute('aria-selected', String(isOutline));
  tabOutline.toggleAttribute('focusgroupstart', isOutline);

  tabThumbnails.classList.toggle('active', !isOutline);
  tabThumbnails.setAttribute('aria-selected', String(!isOutline));
  tabThumbnails.toggleAttribute('focusgroupstart', !isOutline);

  outlineContainer.classList.toggle('active', isOutline);
  outlineContainer.hidden = !isOutline;

  thumbnailsContainer.classList.toggle('active', !isOutline);
  thumbnailsContainer.hidden = isOutline;

  if (!isOutline) {
    const activeThumb = thumbnailsContainer.querySelector('.thumbnail-wrapper.active');
    if (activeThumb) activeThumb.scrollIntoView({ block: 'nearest' });
  }
}

tabOutline.addEventListener('click', () => selectLeftTab('outline'));
tabThumbnails.addEventListener('click', () => selectLeftTab('thumbnails'));

// Keyboard fallback for left-panel tabs in browsers without native focusgroup
[tabOutline, tabThumbnails].forEach((tab) => {
  tab.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = tab === tabOutline ? tabThumbnails : tabOutline;
      next.focus();
      selectLeftTab(next === tabOutline ? 'outline' : 'thumbnails');
    }
  });
});

btnCollapseLeft.addEventListener('click', () => {
  leftPanel.classList.add('collapsed');
  leftPanel.inert = true;
  btnExpandLeft.hidden = false;
  btnExpandLeft.classList.remove('hidden');
  btnExpandLeft.focus();
});

btnExpandLeft.addEventListener('click', () => {
  leftPanel.classList.remove('collapsed');
  leftPanel.inert = false;
  btnExpandLeft.classList.add('hidden');
  btnExpandLeft.hidden = true;
  btnCollapseLeft.focus();

  if (thumbnailsContainer.classList.contains('active')) {
    const activeThumb = thumbnailsContainer.querySelector('.thumbnail-wrapper.active');
    if (activeThumb) activeThumb.scrollIntoView({ block: 'nearest' });
  }
});

// --- DEDICATED PRINT PIPELINE (All Pages + Flattened Markups) ---

async function printPdf() {
  if (!pdfDoc) {
    notify('Load a PDF document first before printing.');
    return;
  }

  notify('Preparing all pages for printing...');
  printContainer.replaceChildren();

  try {
    for (let i = 0; i < numPages; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 2.0 });

      const offCanvas = document.createElement('canvas');
      offCanvas.width = Math.round(viewport.width);
      offCanvas.height = Math.round(viewport.height);
      const ctx = offCanvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const shapes = markupData[i] || [];
      for (const shape of shapes) {
        if (shape.type === 'image' && shape.dataURL) {
          await ensureImageLoaded(shape.dataURL);
        }
        drawShape(ctx, offCanvas.width, offCanvas.height, shape);
      }

      const img = document.createElement('img');
      img.className = 'print-page-image';
      img.alt = `Page ${i + 1}`;
      img.src = offCanvas.toDataURL('image/png');
      printContainer.appendChild(img);
    }

    // Ensure all generated images are decoded before opening print dialog
    await Promise.all(
      Array.from(printContainer.querySelectorAll('img')).map((img) =>
        img.decode ? img.decode().catch(() => {}) : Promise.resolve()
      )
    );

    const cleanup = () => {
      printContainer.replaceChildren();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    window.print();
  } catch (err) {
    console.error('Print preparation failed:', err);
    printContainer.replaceChildren();
    notify('Failed preparing print layout.');
  }
}

function ensureImageLoaded(dataURL) {
  let img = imageCache.get(dataURL);
  if (img && img.complete) return Promise.resolve(img);

  return new Promise((resolve) => {
    if (!img) {
      img = new Image();
      imageCache.set(dataURL, img);
    }
    const done = () => resolve(img);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    if (!img.src) img.src = dataURL;
  });
}
