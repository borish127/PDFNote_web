import './style.css';
import JSZip from 'jszip';
import {
  initPdfViewer,
  loadPdfData,
  loadPdfFile,
  scrollToPage,
  getMarkupData,
  setMarkupData
} from './pdf-viewer.js';
import {
  initEditor,
  setActivePage,
  setEditorContent,
  getEditorContent,
  setMode,
  renderOrphanedNotes,
  resetAssetsCounters
} from './editor.js';
import {
  initMarkdownRenderer,
  renderMarkdown,
  updateMermaidTheme
} from './markdown-renderer.js';
import {
  initDb,
  saveWorkspaceToCache,
  loadWorkspaceFromCache,
  saveMarkupToCache,
  loadMarkupFromCache,
  saveRecoveryJournal,
  loadRecoveryJournal,
  checkAllRecoveryJournals,
  clearRecoveryJournal,
  saveDirHandle,
  loadDirHandle,
  clearDirHandle,
  writeToLocalFolder,
  dataURLtoBlob
} from './storage.js';

// Application State
let activePdfHash = '';
let activePdfName = '';
let activePdfBytes = null;
let activePageIdx = 0;
let notesData = { meta: {}, pages: {} };
let assetsRegistry = {}; // { "img_p1_0.png": dataURL, ... }
let activeDirHandle = null;

// Debouncing auto-save
let autoSaveTimer = null;
let saveState = 'saved'; // 'saved', 'unsaved', 'saving'

// DOM Elements

const btnOpenPdf = document.getElementById('btn-open-pdf');
const btnOpenBundle = document.getElementById('btn-open-bundle');
const btnLinkFolder = document.getElementById('btn-link-folder');
const btnSaveWorkspace = document.getElementById('btn-save-workspace');
const btnThemeToggle = document.getElementById('theme-toggle');
const inputPdfFile = document.getElementById('input-pdf-file');
const inputBundleFile = document.getElementById('input-bundle-file');
const restoreBanner = document.getElementById('restore-banner');
const restoreFilenameSpan = document.getElementById('restore-filename');
const btnRestoreConfirm = document.getElementById('btn-restore-confirm');
const btnRestoreDiscard = document.getElementById('btn-restore-discard');
const btnPlaceholderOpen = document.getElementById('btn-placeholder-open');
const previewContainerInner = document.getElementById('preview-container').querySelector('.preview-scrollable');
const lightboxOverlay = document.getElementById('image-lightbox');
const lightboxImage = document.getElementById('lightbox-image');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxSvgContainer = document.getElementById('lightbox-svg-container');

const btnHelp = document.getElementById('btn-help');
const btnAbout = document.getElementById('btn-about');
const helpDialog = document.getElementById('help-dialog');
const aboutDialog = document.getElementById('about-dialog');
const helpDialogClose = document.getElementById('help-dialog-close');
const aboutDialogClose = document.getElementById('about-dialog-close');

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize IndexedDB
  await initDb();

  // Initialize Sub-systems
  initPdfViewer({
    onPageChange: handlePageChange,
    onMarkupChange: handleMarkupChange
  });

  initEditor({
    onTextChange: handleNotesTextChange,
    onImagePaste: handleImagePaste
  });

  initMarkdownRenderer();

  // Load Saved Directory Handle (if exists)
  try {
    const savedHandle = await loadDirHandle();
    if (savedHandle) {
      activeDirHandle = savedHandle;
      updateSyncStatusBadge();
    }
  } catch (err) {
    console.error('Failed loading saved directory handle:', err);
  }

  // Setup Theme
  initTheme();

  // Check for recovery journal on start (if no PDF loaded yet, check general)
  await checkForRecoveryJournals();

  // Setup main click actions
  btnOpenPdf.addEventListener('click', () => inputPdfFile.click());
  btnPlaceholderOpen.addEventListener('click', () => inputPdfFile.click());
  btnOpenBundle.addEventListener('click', () => inputBundleFile.click());
  
  inputPdfFile.addEventListener('change', handlePdfFileSelect);
  inputBundleFile.addEventListener('change', handleBundleFileSelect);

  btnLinkFolder.addEventListener('click', handleLinkFolder);
  btnSaveWorkspace.addEventListener('click', exportWorkspaceBundle);

  // Drag & drop bundle/PDF on the whole app
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', handleFileDrop);

  // Lightbox Image & Diagram Viewer Events
  previewContainerInner.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG') {
      openLightboxImage(e.target.src, e.target.alt);
      return;
    }

    const mermaidContainer = e.target.closest('.mermaid-svg-container');
    if (mermaidContainer) {
      const svgElement = mermaidContainer.querySelector('svg');
      if (svgElement) {
        openLightboxSvg(svgElement);
      }
    }
  });

  lightboxOverlay.addEventListener('click', (e) => {
    if (e.target === lightboxOverlay || e.target.classList.contains('lightbox-content')) {
      closeLightbox();
    }
  });

  lightboxClose.addEventListener('click', closeLightbox);

  // Help & About Dialogs Events
  btnHelp.addEventListener('click', () => {
    helpDialog.showModal();
  });
  
  btnAbout.addEventListener('click', () => {
    aboutDialog.showModal();
  });

  helpDialogClose.addEventListener('click', () => {
    helpDialog.close();
  });

  aboutDialogClose.addEventListener('click', () => {
    aboutDialog.close();
  });

  // Clicking outside dialog box closes it
  helpDialog.addEventListener('click', (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });

  aboutDialog.addEventListener('click', (e) => {
    if (e.target === aboutDialog) aboutDialog.close();
  });
});

// --- LIGHTBOX IMAGE / DIAGRAM VIEWER ---

function openLightboxImage(src, alt) {
  lightboxImage.src = src;
  lightboxImage.alt = alt || 'Expanded View';
  lightboxImage.style.display = 'block';
  lightboxSvgContainer.style.display = 'none';
  lightboxSvgContainer.innerHTML = '';

  lightboxOverlay.classList.remove('hidden');
  lightboxOverlay.setAttribute('aria-hidden', 'false');
  document.addEventListener('keydown', handleLightboxKeyDown);
}

function openLightboxSvg(svgElement) {
  const clonedSvg = svgElement.cloneNode(true);
  clonedSvg.removeAttribute('width');
  clonedSvg.removeAttribute('height');
  clonedSvg.style.width = '100%';
  clonedSvg.style.height = '100%';
  clonedSvg.style.maxWidth = '100%';
  clonedSvg.style.maxHeight = '100%';

  lightboxSvgContainer.innerHTML = '';
  lightboxSvgContainer.appendChild(clonedSvg);

  lightboxImage.style.display = 'none';
  lightboxSvgContainer.style.display = 'flex';

  lightboxOverlay.classList.remove('hidden');
  lightboxOverlay.setAttribute('aria-hidden', 'false');
  document.addEventListener('keydown', handleLightboxKeyDown);
}

function closeLightbox() {
  lightboxOverlay.classList.add('hidden');
  lightboxOverlay.setAttribute('aria-hidden', 'true');
  document.removeEventListener('keydown', handleLightboxKeyDown);
  setTimeout(() => {
    if (lightboxOverlay.classList.contains('hidden')) {
      lightboxImage.src = '';
      lightboxSvgContainer.innerHTML = '';
    }
  }, 250);
}

function handleLightboxKeyDown(e) {
  if (e.key === 'Escape') {
    closeLightbox();
  }
}

// --- THEME MANAGEMENT ---

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  
  if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
    document.body.classList.add('dark-theme');
    btnThemeToggle.querySelector('span').textContent = 'light_mode';
    updateMermaidTheme(true);
  } else {
    document.body.classList.remove('dark-theme');
    btnThemeToggle.querySelector('span').textContent = 'dark_mode';
    updateMermaidTheme(false);
  }

  btnThemeToggle.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    btnThemeToggle.querySelector('span').textContent = isDark ? 'light_mode' : 'dark_mode';
    updateMermaidTheme(isDark);
    
    // Force rerender mermaid previews
    updateNotesPreview();
  });
}

// --- FILE HANDLERS ---

async function handlePdfFileSelect(e) {
  const file = e.target.files[0];
  if (file) {
    await loadPdfFileObject(file);
  }
}

async function handleBundleFileSelect(e) {
  const file = e.target.files[0];
  if (file) {
    await importWorkspaceBundle(file);
  }
}

async function handleFileDrop(e) {
  // If dropping on viewport, pdf-viewer will handle it.
  // We handle global drops of .pdfmd or .zip here.
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.name.endsWith('.pdfmd') || file.name.endsWith('.zip')) {
      e.preventDefault();
      await importWorkspaceBundle(file);
    } else if (file.type === 'application/pdf') {
      e.preventDefault();
      await loadPdfFileObject(file);
    }
  }
}

// Load a Raw PDF file and hash it
async function loadPdfFileObject(file) {
  try {
    const bytes = await file.arrayBuffer();
    const hash = await calculateSHA256(bytes);
    
    activePdfBytes = bytes;
    activePdfHash = hash;
    activePdfName = file.name;

    await loadPdfData(bytes);
    await initializeWorkspace();
  } catch (err) {
    console.error('Failed loading PDF file:', err);
    alert(`Failed loading PDF: ${err.message}`);
  }
}

// SHA-256 Hash generator using Native browser Crypto API
async function calculateSHA256(arrayBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- WORKSPACE INITIALIZATION & PERSISTENCE ---

async function initializeWorkspace() {
  // Check for recovery journal first
  const journal = await loadRecoveryJournal(activePdfHash);
  if (journal) {
    restoreFilenameSpan.textContent = activePdfName;
    restoreBanner.classList.remove('hidden');
    
    // Bind banner actions
    btnRestoreConfirm.onclick = async () => {
      notesData = {
        meta: {
          version: '1.0.0',
          pdfHash: activePdfHash,
          originalName: activePdfName,
          lastModified: journal.timestamp
        },
        pages: journal.pages
      };
      
      // Load assets registry from main workspace cache since recovery doesn't duplicate heavy assets
      const cache = await loadWorkspaceFromCache(activePdfHash);
      assetsRegistry = cache ? cache.assets : {};
      
      // Load markup
      setMarkupData(journal.markup);
      
      restoreBanner.classList.add('hidden');
      resetAssetsCounters(notesData);
      
      // Update editor
      loadPageNotes();
      
      // Formally save to finalize state
      await triggerSave(true);
    };

    btnRestoreDiscard.onclick = async () => {
      await clearRecoveryJournal(activePdfHash);
      restoreBanner.classList.add('hidden');
      await loadStandardWorkspace();
    };
  } else {
    await loadStandardWorkspace();
  }
}

// Load workspace from IndexedDB standard cache
async function loadStandardWorkspace() {
  const cache = await loadWorkspaceFromCache(activePdfHash);
  const markup = await loadMarkupFromCache(activePdfHash);
  
  if (cache) {
    notesData = {
      meta: cache.meta,
      pages: cache.pages || {}
    };
    assetsRegistry = cache.assets || {};
  } else {
    notesData = {
      meta: {
        version: '1.0.0',
        pdfHash: activePdfHash,
        originalName: activePdfName,
        lastModified: new Date().toISOString()
      },
      pages: {}
    };
    assetsRegistry = {};
  }

  setMarkupData(markup || {});
  resetAssetsCounters(notesData);
  
  // Connect orphaned notes
  checkOrphanedNotes();

  loadPageNotes();
  
  saveState = 'saved';
  updateSyncStatusBadge();
}

// Swaps page note states in editor and renders markdown
function loadPageNotes() {
  const pageData = notesData.pages[activePageIdx];
  const markdown = pageData ? pageData.markdown : '';
  
  setEditorContent(markdown);
  updateNotesPreview();
}

function updateNotesPreview() {
  const markdown = getEditorContent();
  renderMarkdown(markdown, assetsRegistry, previewContainerInner);
}

// --- CALLBACK HANDLERS (PDF Viewport & Editor events) ---

function handlePageChange(pageIdx) {
  if (activePageIdx === pageIdx) return;

  // 1. Save notes of OLD page
  const oldMarkdown = getEditorContent();
  saveActivePageNotes(activePageIdx, oldMarkdown);

  // 2. Set new active page index
  activePageIdx = pageIdx;
  setActivePage(pageIdx);

  // 3. Load notes of NEW page
  loadPageNotes();
}

function handleNotesTextChange(text) {
  saveActivePageNotes(activePageIdx, text);
  markUnsaved();
  
  // Update live preview in real time if in Read Mode or preview is visible
  renderMarkdown(text, assetsRegistry, previewContainerInner);
}

function handleMarkupChange() {
  markUnsaved();
}

function handleImagePaste(name, dataURL) {
  // Store image in assets registry
  assetsRegistry[name] = dataURL;
  
  // Track asset in current page assets list
  if (!notesData.pages[activePageIdx]) {
    notesData.pages[activePageIdx] = { markdown: '', assets: [] };
  }
  if (!notesData.pages[activePageIdx].assets) {
    notesData.pages[activePageIdx].assets = [];
  }
  notesData.pages[activePageIdx].assets.push(name);

  markUnsaved();
}

// Buffer notes string in memory
function saveActivePageNotes(pageIdx, text) {
  if (!notesData.pages[pageIdx]) {
    notesData.pages[pageIdx] = { markdown: '', assets: [] };
  }
  notesData.pages[pageIdx].markdown = text;
}

// Scan for orphaned notes (notes belonging to indexes >= PDF page count)
function checkOrphanedNotes() {
  const pageCount = notesData.meta.pageCount || 999999;
  const orphans = {};

  Object.entries(notesData.pages).forEach(([pIdxStr, data]) => {
    const pIdx = parseInt(pIdxStr);
    // If page index is greater than or equal to current pages count in PDF
    // And contains markdown text
    if (pIdx >= numPages && data.markdown.trim()) {
      orphans[pIdx] = data;
    }
  });

  renderOrphanedNotes(orphans, handleRestoreOrphan);
}

// Action to restore an orphaned note back to active editor space
function handleRestoreOrphan(oldPageIdxStr, orphanData) {
  // Copy to current page notes
  const currentText = getEditorContent();
  const restoredText = `${currentText}\n\n### Restored Note (Page ${parseInt(oldPageIdxStr) + 1})\n${orphanData.markdown}`;
  setEditorContent(restoredText);
  saveActivePageNotes(activePageIdx, restoredText);
  
  // Delete from orphaned list
  delete notesData.pages[oldPageIdxStr];
  
  checkOrphanedNotes();
  markUnsaved();
}

// --- SYNC STATUS & AUTO-SAVE PIPELINES ---

function markUnsaved() {
  if (saveState !== 'unsaved') {
    saveState = 'unsaved';
    updateSyncStatusBadge();
  }

  // Clear existing timer and schedule a debounced auto-save
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  
  autoSaveTimer = setTimeout(async () => {
    await triggerSave();
  }, 3000); // 3 seconds debounce
}

async function triggerSave(forceFinal = false) {
  if (!activePdfHash) return;

  saveState = 'saving';
  updateSyncStatusBadge();

  // Make sure current page buffer is saved
  saveActivePageNotes(activePageIdx, getEditorContent());

  const markup = getMarkupData();

  try {
    if (forceFinal) {
      // Formal permanent save
      await saveWorkspaceToCache(activePdfHash, activePdfName, notesData.pages, assetsRegistry, activePdfBytes);
      await saveMarkupToCache(activePdfHash, markup);
      await clearRecoveryJournal(activePdfHash);

      if (activeDirHandle) {
        const mdText = compileMarkdownDocument();
        await writeToLocalFolder(activeDirHandle, activePdfName, { ...notesData, assets: assetsRegistry }, mdText);
      }
      
      saveState = 'saved';
    } else {
      // Immediate Recovery Journaling (Crash prevention)
      await saveRecoveryJournal(activePdfHash, activePdfName, notesData.pages, markup, activePdfBytes);
      
      // Auto-save back to Directory Handle (if folder linked)
      if (activeDirHandle) {
        await saveWorkspaceToCache(activePdfHash, activePdfName, notesData.pages, assetsRegistry, activePdfBytes);
        await saveMarkupToCache(activePdfHash, markup);
        await clearRecoveryJournal(activePdfHash);

        const mdText = compileMarkdownDocument();
        await writeToLocalFolder(activeDirHandle, activePdfName, { ...notesData, assets: assetsRegistry }, mdText);
        saveState = 'saved';
      } else {
        // If no folder linked, it is only saved in IndexedDB logs / journal.
        // We will show it as Cache Only
        saveState = 'cache-only';
      }
    }
  } catch (error) {
    console.error('Auto-save write failed:', error);
    saveState = 'unsaved';
  }

  updateSyncStatusBadge();
}

// Update the sync status UI badge
function updateSyncStatusBadge() {
  // Sync status pill removed from UI
}

// Link local folder directory using Web File System Access API
async function handleLinkFolder() {
  if (!window.showDirectoryPicker) {
    alert('Your browser does not support the File System Access API. Please use Chrome/Edge, or manually export your workspace bundle using "Save".');
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite'
    });
    
    // Save handle in IndexedDB
    activeDirHandle = handle;
    await saveDirHandle(handle);

    // Save workspace files to this directory immediately
    await triggerSave(true);
  } catch (error) {
    console.error('Directory selection failed:', error);
  }
}

// --- FILE FORMAT EXPORTERS / IMPORTERS ---

// Compile notes JSON map into sequentially compiled Markdown document with front-matter markers
function compileMarkdownDocument() {
  let docText = `---
app: pdf-notes-editor
pdf-target: ${activePdfName}
pdf-hash: ${activePdfHash}
last-modified: ${new Date().toISOString()}
---\n\n`;

  // Sort page indexes numerically
  const pages = Object.keys(notesData.pages).sort((a, b) => parseInt(a) - parseInt(b));
  
  pages.forEach(pIdxStr => {
    const pIdx = parseInt(pIdxStr);
    const pageObj = notesData.pages[pIdxStr];
    if (pageObj && pageObj.markdown.trim()) {
      docText += `---
page: ${pIdx + 1}
---\n`;
      docText += pageObj.markdown.trim() + '\n\n';
    }
  });

  return docText;
}

// Parse sequentially compiled markdown back to notesData pages structure
function parseMarkdownDocument(mdText) {
  const pages = {};
  
  // Regex to split markdown by front-matter page dividers
  const sections = mdText.split(/---\npage:\s*(\d+)\n---\n/);
  
  if (sections.length > 1) {
    for (let i = 1; i < sections.length; i += 2) {
      const pageNum = parseInt(sections[i]);
      const content = sections[i + 1];
      if (pageNum && content) {
        pages[pageNum - 1] = {
          markdown: content.trim(),
          assets: []
        };
      }
    }
  }
  
  return pages;
}

// Export workspace bundle (.pdfmd / .zip)
async function exportWorkspaceBundle() {
  if (!activePdfBytes) {
    alert('Please load a PDF document first.');
    return;
  }

  // Force save current page
  saveActivePageNotes(activePageIdx, getEditorContent());

  const zip = new JSZip();

  // 1. Add original PDF
  zip.file(activePdfName, activePdfBytes);

  // 2. Add notes.json
  const workspaceJSON = {
    meta: {
      version: '1.0.0',
      pdfHash: activePdfHash,
      originalName: activePdfName,
      lastModified: new Date().toISOString()
    },
    pages: notesData.pages,
    markup: getMarkupData()
  };
  zip.file('notes.json', JSON.stringify(workspaceJSON, null, 2));

  // 3. Add images directory
  const assetsDir = zip.folder('assets');
  for (const [imgName, dataURL] of Object.entries(assetsRegistry)) {
    try {
      const blob = dataURLtoBlob(dataURL);
      assetsDir.file(imgName, blob);
    } catch (err) {
      console.error('Failed bundling image into zip:', imgName, err);
    }
  }

  // Generate ZIP blob and download
  try {
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const baseName = activePdfName.substring(0, activePdfName.lastIndexOf('.')) || activePdfName;
    const downloadName = `${baseName}_workspace.pdfmd`;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // Clear recovery journal once downloaded
    await clearRecoveryJournal(activePdfHash);
    saveState = 'saved';
    updateSyncStatusBadge();
  } catch (error) {
    console.error('Error generating bundle:', error);
    alert('Failed creating bundle.');
  }
}

// Import workspace bundle (.pdfmd / .zip)
async function importWorkspaceBundle(zipFile) {
  try {
    pdfViewer.innerHTML = '<div class="empty-state">Decompressing bundle...</div>';
    
    const zip = await JSZip.loadAsync(zipFile);
    
    // 1. Load notes.json
    const notesJsonFile = zip.file('notes.json');
    if (!notesJsonFile) {
      throw new Error('notes.json not found in workspace bundle');
    }
    
    const notesJSONText = await notesJsonFile.async('text');
    const importedWorkspace = JSON.parse(notesJSONText);
    
    // 2. Find and load original PDF file
    const pdfFilenameFromMeta = importedWorkspace.meta.originalName;
    let pdfZipFile = zip.file(pdfFilenameFromMeta);
    
    // Fallback: search for any .pdf inside the zip
    if (!pdfZipFile) {
      const pdfFiles = Object.keys(zip.files).filter(name => name.endsWith('.pdf'));
      if (pdfFiles.length > 0) {
        pdfZipFile = zip.file(pdfFiles[0]);
      }
    }

    if (!pdfZipFile) {
      throw new Error('Original PDF file not found in bundle');
    }

    const pdfBuffer = await pdfZipFile.async('arraybuffer');
    activePdfBytes = pdfBuffer;
    activePdfName = pdfZipFile.name;
    activePdfHash = importedWorkspace.meta.pdfHash || await calculateSHA256(pdfBuffer);

    // 3. Load assets (images)
    assetsRegistry = {};
    const assetsFolder = zip.folder('assets');
    const imageFiles = [];
    
    zip.forEach((relativePath, file) => {
      if (relativePath.startsWith('assets/') && !file.dir) {
        imageFiles.push(file);
      }
    });

    for (const imgFile of imageFiles) {
      const imgName = imgFile.name.replace('assets/', '');
      const imgBlob = await imgFile.async('blob');
      
      // Convert image blob to data URL
      const dataURL = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = (e) => resolve(e.target.result);
        r.readAsDataURL(imgBlob);
      });
      
      assetsRegistry[imgName] = dataURL;
    }

    // Set workspace data
    notesData = {
      meta: importedWorkspace.meta,
      pages: importedWorkspace.pages || {}
    };

    // Load PDF in Viewer
    await loadPdfData(pdfBuffer);

    // Load markup
    setMarkupData(importedWorkspace.markup || {});
    resetAssetsCounters(notesData);

    // Load first page notes
    loadPageNotes();
    
    // Force cache in IndexedDB
    await triggerSave(true);
    
    saveState = 'saved';
    updateSyncStatusBadge();
    
  } catch (error) {
    console.error('Import bundle failed:', error);
    pdfViewer.innerHTML = `<div class="empty-state" style="color: var(--md-sys-color-error)">Failed to import bundle: ${error.message}</div>`;
  }
}

// Check if any crash recovery journal exists in IndexedDB on initialization
async function checkForRecoveryJournals() {
  try {
    const journals = await checkAllRecoveryJournals();
    if (journals && journals.length > 0) {
      // Find the most recent journal
      const recent = journals.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
      
      // Render recovery offer banner
      restoreFilenameSpan.textContent = recent.originalName;
      restoreBanner.classList.remove('hidden');
      
      btnRestoreConfirm.onclick = async () => {
        const cache = await loadWorkspaceFromCache(recent.pdfHash);
        const pdfBytes = recent.pdfBytes || (cache ? cache.pdfBytes : null);
        
        if (pdfBytes) {
          let resolvedPdfBytes = pdfBytes;
          if (pdfBytes instanceof Blob) {
            resolvedPdfBytes = await pdfBytes.arrayBuffer();
          }
          activePdfBytes = resolvedPdfBytes;
          activePdfHash = recent.pdfHash;
          activePdfName = recent.originalName;
          activePageIdx = 0;

          await loadPdfData(resolvedPdfBytes);

          notesData = {
            meta: {
              version: '1.0.0',
              pdfHash: activePdfHash,
              originalName: activePdfName,
              lastModified: recent.timestamp
            },
            pages: recent.pages || {}
          };

          assetsRegistry = cache ? (cache.assets || {}) : {};
          setMarkupData(recent.markup || {});
          resetAssetsCounters(notesData);
          checkOrphanedNotes();
          loadPageNotes();

          restoreBanner.classList.add('hidden');
          await triggerSave(true); // Finalize save and clear journal
        } else {
          alert(`Could not find cached PDF file bytes for "${recent.originalName}". Please open the original PDF file, and we will restore your recovered notes.`);
          
          // Pre-populate notes data in memory so when they open PDF it links up
          activePdfHash = recent.pdfHash;
          activePdfName = recent.originalName;
          notesData = {
            meta: {
              version: '1.0.0',
              pdfHash: activePdfHash,
              originalName: activePdfName,
              lastModified: recent.timestamp
            },
            pages: recent.pages || {}
          };
          
          assetsRegistry = cache ? (cache.assets || {}) : {};
          setMarkupData(recent.markup || {});
          resetAssetsCounters(notesData);
          restoreBanner.classList.add('hidden');
        }
      };

      btnRestoreDiscard.onclick = async () => {
        await clearRecoveryJournal(recent.pdfHash);
        restoreBanner.classList.add('hidden');
      };
    }
  } catch (err) {
    console.error('Checking journals failed:', err);
  }
}
