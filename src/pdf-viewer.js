import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Set worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

let pdfDoc = null;
let pdfFilename = '';
let numPages = 0;
let currentPage = 1;
let currentZoom = 'page-fit';
let activeTool = 'cursor'; // 'cursor', 'highlight', 'underline', 'draw', 'text', 'signature', 'eraser'
let markupData = {}; // keyed by 0-based page index, e.g. { "0": [shapes], "1": [...] }
let pageRatios = {}; // aspect ratios of pages keyed by 0-based index

// Callback to trigger notes update in main app
let onPageChangeCallback = null;
let onMarkupChangeCallback = null;
let onFileDropCallback = null;

// Intersection Observer for Virtualization and Dominant Page Detection
let intersectionObserver = null;
const renderedPages = new Set(); // Set of 0-based page indexes currently rendered
const intersectingPages = new Set(); // Set of 0-based page indexes currently intersecting the viewport
let isProgrammaticScrolling = false;
let programmaticScrollTimeout = null;

// DOM Selectors
const pdfViewport = document.getElementById('pdf-viewport');
const pdfViewer = document.getElementById('pdf-viewer');
const pageCurrentInput = document.getElementById('page-current');
const pageTotalSpan = document.getElementById('page-total');
const zoomSelect = document.getElementById('zoom-select');
const outlineContainer = document.getElementById('outline-container');
const thumbnailsContainer = document.getElementById('thumbnails-container');

// Markup tools buttons
const toolButtons = {
  cursor: document.getElementById('tool-cursor'),
  highlight: document.getElementById('tool-highlight'),
  underline: document.getElementById('tool-underline'),
  draw: document.getElementById('tool-draw'),
  text: document.getElementById('tool-text'),
  signature: document.getElementById('tool-signature'),
  eraser: document.getElementById('tool-eraser')
};

// Initialize listeners
export function initPdfViewer({ onPageChange, onMarkupChange, onFileDrop }) {
  onPageChangeCallback = onPageChange;
  onMarkupChangeCallback = onMarkupChange;
  onFileDropCallback = onFileDrop;

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

  document.getElementById('zoom-in').addEventListener('click', () => {
    adjustZoom(0.1);
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    adjustZoom(-0.1);
  });

  // Page inputs
  pageCurrentInput.addEventListener('change', (e) => {
    const val = parseInt(e.target.value);
    if (val >= 1 && val <= numPages) {
      scrollToPage(val);
    } else {
      pageCurrentInput.value = currentPage;
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
      setTool(tool);
    });
  });

  // Listen to print button
  document.getElementById('btn-print').addEventListener('click', printPdf);

  // Setup drag & drop PDF
  pdfViewport.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  pdfViewport.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0 && onFileDropCallback) {
      onFileDropCallback(files[0]);
    }
  });

  // Safety reset to prevent window/document scrolling
  const lockDocumentScroll = () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
    if (document.documentElement.scrollTop !== 0 || document.documentElement.scrollLeft !== 0) {
      document.documentElement.scrollTop = 0;
      document.documentElement.scrollLeft = 0;
    }
    if (document.body.scrollTop !== 0 || document.body.scrollLeft !== 0) {
      document.body.scrollTop = 0;
      document.body.scrollLeft = 0;
    }
  };
  window.addEventListener('scroll', lockDocumentScroll, { passive: true });
  document.addEventListener('scroll', lockDocumentScroll, { passive: true });
  document.body.addEventListener('scroll', lockDocumentScroll, { passive: true });

  // Keyboard Page and Viewport Navigation
  window.addEventListener('keydown', (e) => {
    if (!pdfDoc) return;
    
    // Ignore keypress if focus is inside any text input, CodeMirror, or other editable block
    const activeEl = document.activeElement;
    if (activeEl && (
      activeEl.tagName === 'INPUT' ||
      activeEl.tagName === 'TEXTAREA' ||
      activeEl.contentEditable === 'true' ||
      activeEl.closest('.cm-editor')
    )) {
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      if (currentPage < numPages) {
        scrollToPage(currentPage + 1);
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (currentPage > 1) {
        scrollToPage(currentPage - 1);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      pdfViewport.scrollBy({ top: 50, behavior: 'auto' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pdfViewport.scrollBy({ top: -50, behavior: 'auto' });
    } else if (e.key === ' ' || e.key === 'Spacebar') { // Space
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

  // Reset programmatic scroll state when viewport smooth scroll completes
  pdfViewport.addEventListener('scrollend', () => {
    isProgrammaticScrolling = false;
    if (programmaticScrollTimeout) {
      clearTimeout(programmaticScrollTimeout);
      programmaticScrollTimeout = null;
    }
  });

  // Resize observer to handle viewport size changes for responsive zooming
  let lastViewportWidth = pdfViewport.clientWidth;
  let lastViewportHeight = pdfViewport.clientHeight;
  let resizeTimeout = null;
  const resizeObserver = new ResizeObserver((entries) => {
    if (currentZoom !== 'auto' && currentZoom !== 'page-fit') return;
    
    const currentWidth = pdfViewport.clientWidth;
    const currentHeight = pdfViewport.clientHeight;
    
    // Only trigger if size actually changed (ignoring minor 1-2px scrollbar toggles to be safe, e.g. > 5px change)
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
}

// Set active tool
function setTool(tool) {
  activeTool = tool;
  Object.entries(toolButtons).forEach(([t, btn]) => {
    if (!btn) return;
    if (t === tool) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Adjust pointer events of overlay canvases
  const overlays = document.querySelectorAll('.annotation-overlay-canvas');
  overlays.forEach(canvas => {
    if (tool === 'cursor') {
      canvas.style.pointerEvents = 'none'; // Pass clicks to text layer
    } else {
      canvas.style.pointerEvents = 'auto'; // Intercept clicks for drawing
    }
  });
}

// Adjust zoom level
function adjustZoom(delta) {
  let z = parseFloat(zoomSelect.value);
  if (isNaN(z)) z = 1.0;
  z = Math.max(0.5, Math.min(3.0, z + delta));
  zoomSelect.value = z.toFixed(2);
  currentZoom = z;
  rerenderAll();
}

// Set page markup
export function setMarkupData(data) {
  markupData = data || {};
  // Redraw active overlay canvases
  renderedPages.forEach(pIdx => {
    const overlay = document.getElementById(`overlay-canvas-p${pIdx}`);
    if (overlay) drawPageMarkup(pIdx, overlay);
  });
}

export function getMarkupData() {
  return markupData;
}

// Scroll to page (1-based)
export function scrollToPage(pageNum) {
  if (pageNum < 1 || pageNum > numPages || isNaN(pageNum)) return;
  const container = document.getElementById(`page-container-p${pageNum - 1}`);
  if (container) {
    isProgrammaticScrolling = true;
    if (programmaticScrollTimeout) clearTimeout(programmaticScrollTimeout);

    // Calculate scroll offset relative to pdfViewport to prevent document-level scrolling
    const maxScrollTop = pdfViewport.scrollHeight - pdfViewport.clientHeight;
    const targetScrollTop = Math.max(0, Math.min(maxScrollTop, container.offsetTop - (pdfViewport.clientHeight - container.clientHeight) / 2));
    pdfViewport.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    
    currentPage = pageNum;
    pageCurrentInput.value = currentPage;

    updateActiveStates(currentPage);

    if (onPageChangeCallback) {
      onPageChangeCallback(currentPage - 1);
    }

    // Fallback in case scrollend doesn't trigger
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

// Load PDF from ArrayBuffer data
export async function loadPdfData(arrayBuffer) {
  try {
    pdfViewer.innerHTML = '<div class="empty-state">Loading PDF engine...</div>';
    
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfDoc = await loadingTask.promise;
    numPages = pdfDoc.numPages;
    currentPage = 1;

    pageTotalSpan.textContent = numPages;
    pageCurrentInput.value = 1;
    pageCurrentInput.max = numPages;

    isProgrammaticScrolling = true;
    renderedPages.clear();
    intersectingPages.clear();
    pageRatios = {};

    // Create container wrappers synchronously first to guarantee exact ordering (0, 1, 2...)
    pdfViewer.innerHTML = '';
    for (let i = 0; i < numPages; i++) {
      const pageContainer = document.createElement('div');
      pageContainer.id = `page-container-p${i}`;
      pageContainer.className = `pdf-page-container`;
      pdfViewer.appendChild(pageContainer);
    }

    // Load page ratios asynchronously (one by one) to avoid concurrency gaps
    for (let i = 0; i < numPages; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1.0 });
      pageRatios[i] = viewport.width / viewport.height;
    }

    // Set outline
    loadOutline();
    
    // Set up thumbnails
    loadThumbnails();

    // Trigger initial render & intersection observer
    setupObserver();

    if (onPageChangeCallback) onPageChangeCallback(0);

    // Release programmatic scroll flag after a short delay for DOM reflow
    setTimeout(() => {
      isProgrammaticScrolling = false;
    }, 500);
    return { name: pdfFilename, pagesCount: numPages };
  } catch (error) {
    console.error('Error loading PDF:', error);
    pdfViewer.innerHTML = `<div class="empty-state">Failed to load PDF: ${error.message}</div>`;
    throw error;
  }
}

// Rerender all pages on zoom changes
function rerenderAll() {
  if (!pdfDoc) return;
  
  // Update heights of all page containers
  for (let i = 0; i < numPages; i++) {
    const container = document.getElementById(`page-container-p${i}`);
    if (container) {
      const { width, height } = getPageDimensions(i);
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
    }
  }

  // Clear and force-rerender currently visible pages
  const visiblePages = Array.from(renderedPages);
  renderedPages.clear();
  
  visiblePages.forEach(pIdx => {
    renderPage(pIdx);
  });
}

// Get page dimensions at current zoom
function getPageDimensions(pIdx) {
  const ratio = pageRatios[pIdx] || 0.75;
  const baseWidth = 612;
  const baseHeight = baseWidth / ratio;
  
  let scale = 1.0;
  if (currentZoom === 'auto') {
    // Fits width
    const vw = Math.max(200, pdfViewport.clientWidth - 48);
    scale = vw / baseWidth;
    if (scale > 2.0) scale = 2.0; // limit auto zoom
  } else if (currentZoom === 'page-fit') {
    // Fits both width and height of viewport
    const vw = Math.max(200, pdfViewport.clientWidth - 48);
    const vh = Math.max(200, pdfViewport.clientHeight - 48);
    const scaleToFitWidth = vw / baseWidth;
    const scaleToFitHeight = vh / baseHeight;
    scale = Math.min(scaleToFitWidth, scaleToFitHeight);
  } else {
    scale = currentZoom;
  }

  // Guard against invalid scale values
  if (isNaN(scale) || scale <= 0) {
    scale = 1.0;
  }
  
  return {
    width: Math.round(baseWidth * scale),
    height: Math.round(baseHeight * scale),
    scale: scale
  };
}

// Set up Intersection Observer for Virtualization
function setupObserver() {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }

  // Set heights of page containers
  for (let i = 0; i < numPages; i++) {
    const container = document.getElementById(`page-container-p${i}`);
    if (container) {
      const { width, height } = getPageDimensions(i);
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
      
      // Put placeholder inside
      container.innerHTML = `
        <div class="pdf-page-placeholder" style="width: 100%; height: 100%">
          <div class="spinner"></div>
          <span>Loading Page ${i + 1}...</span>
        </div>
      `;
    }
  }

  // Observer
  intersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const pIdx = parseInt(entry.target.id.replace('page-container-p', ''));
      if (!isNaN(pIdx)) {
        if (entry.isIntersecting) {
          intersectingPages.add(pIdx);
          // Render this page + pre-render neighbor pages
          renderPageWindow(pIdx);
        } else {
          intersectingPages.delete(pIdx);
        }
      }
    });

    // Dominant Page Detection
    updateDominantPage();
  }, {
    root: pdfViewport,
    threshold: [0.1, 0.25, 0.5, 0.75, 0.9]
  });

  // Observe all containers
  for (let i = 0; i < numPages; i++) {
    const container = document.getElementById(`page-container-p${i}`);
    if (container) intersectionObserver.observe(container);
  }
}

// Update highlighting states for thumbnails and outline
function updateActiveStates(pageNum) {
  // Highlight active thumbnail
  const thumbnails = document.querySelectorAll('.thumbnail-wrapper');
  thumbnails.forEach((el, idx) => {
    if (idx === pageNum - 1) {
      el.classList.add('active');
      // Only scroll the thumbnail into view if the thumbnails tab is visible
      if (thumbnailsContainer.offsetParent !== null) {
        el.scrollIntoView({ block: 'nearest' });
      }
    } else {
      el.classList.remove('active');
    }
  });

  // Highlight active outline node if outline is loaded
  document.querySelectorAll('.outline-node').forEach(node => {
    const destPage = parseInt(node.getAttribute('data-page'));
    if (destPage === pageNum) {
      node.classList.add('active');
    } else {
      node.classList.remove('active');
    }
  });
}

// Keep page tracker updated
function updateCurrentPage(pageNum) {
  if (pageNum < 1 || pageNum > numPages || isNaN(pageNum)) return;
  if (currentPage !== pageNum) {
    currentPage = pageNum;
    pageCurrentInput.value = currentPage;

    updateActiveStates(currentPage);

    // Save notes and swap page notes in editor via callback
    if (onPageChangeCallback) {
      onPageChangeCallback(pageNum - 1);
    }

    // Clean up pages that are far away (e.g. > 10 pages away) to conserve memory
    const farPages = [];
    renderedPages.forEach(pIdx => {
      if (Math.abs(pIdx - (pageNum - 1)) > 10) {
        farPages.push(pIdx);
      }
    });
    farPages.forEach(pIdx => dropPage(pIdx));
  }
}

// Calculate the dominant page currently visible in the viewport
function updateDominantPage() {
  if (isProgrammaticScrolling || intersectingPages.size === 0) return;

  let maxVisibleHeight = 0;
  let dominantPage = currentPage;
  const viewportRect = pdfViewport.getBoundingClientRect();

  // Sort intersecting pages numerically to ensure we process them in top-to-bottom order (0, 1, 2, 3...)
  const sortedPages = Array.from(intersectingPages).sort((a, b) => a - b);

  sortedPages.forEach(pIdx => {
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

// Virtualization window management
function renderPageWindow(centerIdx) {
  const pagesToRender = new Set();
  pagesToRender.add(centerIdx);
  if (centerIdx > 0) pagesToRender.add(centerIdx - 1);
  if (centerIdx < numPages - 1) pagesToRender.add(centerIdx + 1);

  // Render required pages
  pagesToRender.forEach(pIdx => {
    if (!renderedPages.has(pIdx)) {
      renderPage(pIdx);
    }
  });
}

// Render a single PDF page
// Render a single PDF page
async function renderPage(pIdx) {
  if (!pdfDoc || renderedPages.has(pIdx)) return;
  renderedPages.add(pIdx);

  const container = document.getElementById(`page-container-p${pIdx}`);
  if (!container) return;

  const { width, height, scale } = getPageDimensions(pIdx);

  try {
    const page = await pdfDoc.getPage(pIdx + 1);
    const viewport = page.getViewport({ scale: scale * 1.5 }); // High-quality canvas render

    // Create a temporary document fragment to compile elements in memory
    const fragment = document.createDocumentFragment();

    // 1. Create main page canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    fragment.appendChild(canvas);

    // Render PDF onto canvas
    const ctx = canvas.getContext('2d');
    const renderContext = {
      canvasContext: ctx,
      viewport: viewport
    };
    await page.render(renderContext).promise;

    // 2. Build text selection layer
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = '100%';
    textLayerDiv.style.height = '100%';
    textLayerDiv.style.setProperty('--scale-factor', scale);
    textLayerDiv.style.setProperty('--total-scale-factor', scale);
    fragment.appendChild(textLayerDiv);
    
    const textContent = await page.getTextContent();
    const textViewport = page.getViewport({ scale: scale }); // Standard match scale
    
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: textViewport
    });
    await textLayer.render();

    // 3. Create drawings and markup canvas overlay
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = `overlay-canvas-p${pIdx}`;
    overlayCanvas.className = 'annotation-overlay-canvas';
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
    overlayCanvas.style.width = '100%';
    overlayCanvas.style.height = '100%';
    overlayCanvas.style.pointerEvents = activeTool === 'cursor' ? 'none' : 'auto';
    fragment.appendChild(overlayCanvas);

    // Bind drawing mouse listeners to overlay canvas
    bindDrawingListeners(pIdx, overlayCanvas);

    // Draw existing annotations
    drawPageMarkup(pIdx, overlayCanvas);

    // Swap contents: clear placeholder and append new elements instantly
    container.innerHTML = '';
    container.appendChild(fragment);

  } catch (error) {
    console.error('Error rendering page:', pIdx + 1, error);
    container.innerHTML = `<div class="empty-state">Failed to render page: ${error.message}</div>`;
  }
}

// Drop canvas to save memory
function dropPage(pIdx) {
  if (!renderedPages.has(pIdx)) return;
  renderedPages.delete(pIdx);

  const container = document.getElementById(`page-container-p${pIdx}`);
  if (container) {
    const { width, height } = getPageDimensions(pIdx);
    container.innerHTML = `
      <div class="pdf-page-placeholder" style="width: 100%; height: 100%">
        <div class="spinner"></div>
        <span>Loading Page ${pIdx + 1}...</span>
      </div>
    `;
  }
}

// --- ANNOTATIONS / DRAWING OVERLAY LOGIC ---

let isDrawing = false;
let currentStroke = null;
let currentBoxStart = null;

function bindDrawingListeners(pIdx, canvas) {
  const ctx = canvas.getContext('2d');
  
  const getMousePos = (e) => {
    const rect = canvas.getBoundingClientRect();
    // Support mouse and touch events
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    // Coordinates inside canvas dimensions (normalized relative coordinates)
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    return { x, y };
  };

  const onDown = (e) => {
    if (activeTool === 'cursor') return;
    e.preventDefault();
    isDrawing = true;
    const pos = getMousePos(e);

    if (activeTool === 'draw') {
      currentStroke = {
        type: 'draw',
        color: document.body.classList.contains('dark-theme') ? '#A3C9FF' : '#005FAF',
        width: 3,
        points: [[pos.x, pos.y]]
      };
    } else if (activeTool === 'highlight') {
      currentBoxStart = pos;
      currentStroke = {
        type: 'highlight',
        color: 'rgba(255, 235, 59, 0.4)', // transparent yellow highlight
        rect: { x: pos.x, y: pos.y, w: 0, h: 0 }
      };
    } else if (activeTool === 'underline') {
      currentBoxStart = pos;
      currentStroke = {
        type: 'underline',
        color: document.body.classList.contains('dark-theme') ? '#A3C9FF' : '#005FAF',
        rect: { x: pos.x, y: pos.y, w: 0, h: 0 }
      };
    } else if (activeTool === 'text') {
      // Add text input box on page
      addTextInput(pIdx, canvas, pos);
      isDrawing = false;
    } else if (activeTool === 'signature') {
      // Insert signature template
      insertSignature(pIdx, pos);
      isDrawing = false;
    } else if (activeTool === 'eraser') {
      // Eraser clears everything on the page
      markupData[pIdx] = [];
      drawPageMarkup(pIdx, canvas);
      isDrawing = false;
      if (onMarkupChangeCallback) onMarkupChangeCallback();
    }
  };

  const onMove = (e) => {
    if (!isDrawing || !currentStroke) return;
    e.preventDefault();
    const pos = getMousePos(e);

    if (activeTool === 'draw') {
      currentStroke.points.push([pos.x, pos.y]);
      // Draw path in real-time
      drawRealtimeStroke(canvas, currentStroke);
    } else if (activeTool === 'highlight' || activeTool === 'underline') {
      const w = pos.x - currentBoxStart.x;
      const h = pos.y - currentBoxStart.y;
      currentStroke.rect = {
        x: w < 0 ? pos.x : currentBoxStart.x,
        y: h < 0 ? pos.y : currentBoxStart.y,
        w: Math.abs(w),
        h: Math.abs(h)
      };
      // Draw box in real-time
      drawPageMarkup(pIdx, canvas); // Clear and draw existing
      drawRealtimeStroke(canvas, currentStroke); // Draw current temp box
    }
  };

  const onUp = (e) => {
    if (!isDrawing) return;
    isDrawing = false;

    if (currentStroke) {
      if (!markupData[pIdx]) markupData[pIdx] = [];
      markupData[pIdx].push(currentStroke);
      currentStroke = null;
      currentBoxStart = null;
      
      // Final redraw
      drawPageMarkup(pIdx, canvas);
      if (onMarkupChangeCallback) onMarkupChangeCallback();
    }
  };

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('mouseleave', onUp);

  // Touch support
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp);
}

// Add text input box overlays
function addTextInput(pIdx, canvas, pos) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'm3-input-page';
  input.style.position = 'absolute';
  input.style.left = `${pos.x * 100}%`;
  input.style.top = `${pos.y * 100}%`;
  input.style.transform = 'translate(-5px, -18px)';
  input.style.zIndex = 10;
  input.style.width = '150px';
  input.style.fontSize = '14px';
  input.style.borderColor = 'var(--md-sys-color-primary)';
  
  canvas.parentElement.appendChild(input);
  input.focus();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) {
        if (!markupData[pIdx]) markupData[pIdx] = [];
        markupData[pIdx].push({
          type: 'text',
          color: document.body.classList.contains('dark-theme') ? '#E2E2E6' : '#1A1C1E',
          text: text,
          x: pos.x,
          y: pos.y
        });
        drawPageMarkup(pIdx, canvas);
        if (onMarkupChangeCallback) onMarkupChangeCallback();
      }
      input.remove();
    } else if (e.key === 'Escape') {
      input.remove();
    }
  });

  input.addEventListener('blur', () => {
    const text = input.value.trim();
    if (text) {
      if (!markupData[pIdx]) markupData[pIdx] = [];
      markupData[pIdx].push({
        type: 'text',
        color: document.body.classList.contains('dark-theme') ? '#E2E2E6' : '#1A1C1E',
        text: text,
        x: pos.x,
        y: pos.y
      });
      drawPageMarkup(pIdx, canvas);
      if (onMarkupChangeCallback) onMarkupChangeCallback();
    }
    input.remove();
  });
}

// Insert signature path
function insertSignature(pIdx, pos) {
  const canvas = document.getElementById(`overlay-canvas-p${pIdx}`);
  if (!canvas) return;

  // Insert a stylized signature path template
  if (!markupData[pIdx]) markupData[pIdx] = [];
  
  // A signature vector path that resembles a handwritten shape
  const sigPoints = [];
  const startX = pos.x;
  const startY = pos.y;
  
  // Generate a simple script-like path
  for (let t = 0; t <= 10; t++) {
    const ratio = t / 10;
    const dx = ratio * 0.08;
    const dy = Math.sin(ratio * Math.PI * 3.5) * 0.015;
    sigPoints.push([startX + dx, startY + dy]);
  }
  // underline path stroke
  sigPoints.push([startX + 0.01, startY + 0.02]);
  sigPoints.push([startX + 0.09, startY + 0.02]);

  markupData[pIdx].push({
    type: 'draw',
    color: '#001D40', // Deep ink signature
    width: 2.5,
    points: sigPoints
  });

  drawPageMarkup(pIdx, canvas);
  if (onMarkupChangeCallback) onMarkupChangeCallback();
}

// Redraw markup canvas
function drawPageMarkup(pIdx, canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const shapes = markupData[pIdx] || [];
  shapes.forEach(shape => {
    drawShape(ctx, canvas.width, canvas.height, shape);
  });
}

// Draw a single shape helper
function drawShape(ctx, width, height, shape) {
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = (shape.width || 3) * (width / 612); // scale line width matching zoom width

  if (shape.type === 'draw') {
    if (!shape.points || shape.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(shape.points[0][0] * width, shape.points[0][1] * height);
    for (let i = 1; i < shape.points.length; i++) {
      ctx.lineTo(shape.points[i][0] * width, shape.points[i][1] * height);
    }
    ctx.stroke();
  } else if (shape.type === 'highlight') {
    const r = shape.rect;
    ctx.fillRect(r.x * width, r.y * height, r.w * width, r.h * height);
  } else if (shape.type === 'underline') {
    const r = shape.rect;
    ctx.beginPath();
    ctx.moveTo(r.x * width, (r.y + r.h) * height);
    ctx.lineTo((r.x + r.w) * width, (r.y + r.h) * height);
    ctx.stroke();
  } else if (shape.type === 'text') {
    ctx.font = `${Math.round(14 * (width / 612))}px sans-serif`;
    ctx.fillText(shape.text, shape.x * width, shape.y * height);
  }
}

// Draw temporary real-time paths
function drawRealtimeStroke(canvas, stroke) {
  const ctx = canvas.getContext('2d');
  drawShape(ctx, canvas.width, canvas.height, stroke);
}

// --- DOCUMENT OUTLINE (TAB 1) ---

async function loadOutline() {
  outlineContainer.innerHTML = '';
  if (!pdfDoc) return;

  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) {
      outlineContainer.innerHTML = '<div class="empty-state">No outline index found in PDF.</div>';
      return;
    }

    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '4px';

    const renderNodes = async (nodes, parentEl, depth = 0) => {
      for (const node of nodes) {
        const item = document.createElement('div');
        item.className = 'outline-node';
        item.textContent = node.title;
        item.style.paddingLeft = `${depth * 12 + 12}px`;

        // Get page dest
        let destPageNum = null;
        if (node.dest) {
          try {
            // pdfDoc.getPageIndex returns 0-based page index from destination reference
            const explicitDest = typeof node.dest === 'string' ? await pdfDoc.getDestination(node.dest) : node.dest;
            if (explicitDest && explicitDest[0]) {
              const ref = explicitDest[0];
              const pIndex = await pdfDoc.getPageIndex(ref);
              destPageNum = pIndex + 1;
            }
          } catch (err) {
            console.error('Dest outline resolving err:', err);
          }
        }

        if (destPageNum) {
          item.setAttribute('data-page', destPageNum);
          item.addEventListener('click', () => {
            scrollToPage(destPageNum);
          });
        }

        parentEl.appendChild(item);

        if (node.items && node.items.length > 0) {
          await renderNodes(node.items, parentEl, depth + 1);
        }
      }
    };

    await renderNodes(outline, list);
    outlineContainer.appendChild(list);

  } catch (error) {
    console.error('Outline loading error:', error);
    outlineContainer.innerHTML = '<div class="empty-state">Outline unavailable</div>';
  }
}

// --- CANVAS THUMBNAILS (TAB 2) ---

async function loadThumbnails() {
  thumbnailsContainer.innerHTML = '';
  if (!pdfDoc) return;

  for (let i = 0; i < numPages; i++) {
    const thumbWrapper = document.createElement('div');
    thumbWrapper.className = `thumbnail-wrapper ${i === 0 ? 'active' : ''}`;
    thumbWrapper.addEventListener('click', () => {
      scrollToPage(i + 1);
    });

    const canvas = document.createElement('canvas');
    canvas.className = 'thumbnail-canvas';
    thumbWrapper.appendChild(canvas);

    const label = document.createElement('div');
    label.className = 'thumbnail-label';
    label.textContent = `Page ${i + 1}`;
    thumbWrapper.appendChild(label);

    thumbnailsContainer.appendChild(thumbWrapper);
    
    // Lazy-load render thumbnail inside a microtask/idlecallback to avoid freezing the tab
    requestIdleCallback(async () => {
      try {
        const page = await pdfDoc.getPage(i + 1);
        const viewport = page.getViewport({ scale: 0.15 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      } catch (err) {
        console.error('Failed rendering thumbnail for page:', i + 1, err);
      }
    });
  }
}

// Toggle Tabs
document.getElementById('tab-outline').addEventListener('click', (e) => {
  document.getElementById('tab-outline').classList.add('active');
  document.getElementById('tab-thumbnails').classList.remove('active');
  outlineContainer.classList.add('active');
  thumbnailsContainer.classList.remove('active');
});

document.getElementById('tab-thumbnails').addEventListener('click', (e) => {
  document.getElementById('tab-thumbnails').classList.add('active');
  document.getElementById('tab-outline').classList.remove('active');
  thumbnailsContainer.classList.add('active');
  outlineContainer.classList.remove('active');

  // Scroll active thumbnail into view when switching to the tab
  const activeThumb = thumbnailsContainer.querySelector('.thumbnail-wrapper.active');
  if (activeThumb) {
    activeThumb.scrollIntoView({ block: 'nearest' });
  }
});

// Sidebar panel Collapses
const leftPanel = document.getElementById('left-panel');
const btnCollapseLeft = document.getElementById('btn-collapse-left');
const btnExpandLeft = document.getElementById('btn-expand-left');

btnCollapseLeft.addEventListener('click', () => {
  leftPanel.classList.add('collapsed');
  btnExpandLeft.classList.remove('hidden');
});

btnExpandLeft.addEventListener('click', () => {
  leftPanel.classList.remove('collapsed');
  btnExpandLeft.classList.add('hidden');

  // Scroll active thumbnail into view if thumbnails tab is active
  if (thumbnailsContainer.classList.contains('active')) {
    const activeThumb = thumbnailsContainer.querySelector('.thumbnail-wrapper.active');
    if (activeThumb) {
      activeThumb.scrollIntoView({ block: 'nearest' });
    }
  }
});

// PDF Printing
function printPdf() {
  if (!pdfDoc) return;
  // Standard print: Open PDF blob in window and call print()
  // Since we are pure client-side, we open a new browser tab with pdf data url and print it
  alert('Preparing print layout... Please select "Save to PDF" or your printer in the print prompt.');
  const w = window.open();
  // Simply open the original PDF file URL if loaded or render page prints
  // For a complete PDF file, the original PDF ArrayBuffer is best exported or opened
  // (We will export the PDF data to the window)
  // Let's print native window layout or implement a simple print page.
  // We can let the user trigger the browser printing on the page or open a print-friendly iframe.
  window.print();
}
