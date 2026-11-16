import './style.css';
import {
  initPdfViewer,
  loadPdfData,
  scrollToPage,
  getMarkupData,
  setMarkupData,
  getNumPages,
  showViewerStatus
} from './pdf-viewer.js';
import {
  initEditor,
  setActivePage,
  setEditorContent,
  getEditorContent,
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
  writeToLocalFolder,
  readFromLocalFolder,
  verifyPermission,
  dataURLtoBlob
} from './storage.js';

// Conditionally polyfill Invoker Commands (command / commandfor) only where missing
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('invokers-polyfill');
}

// Application State
let activePdfHash = '';
let activePdfName = '';
let activePdfBytes = null; // Uint8Array
let activePageIdx = 0;
let notesData = { meta: {}, pages: {} };
let assetsRegistry = {}; // { "img_p1_0.png": dataURL, ... }
let activeDirHandle = null;

// Debouncing auto-save
let autoSaveTimer = null;
let saveState = 'saved'; // 'saved', 'cache-only', 'unsaved', 'saving', 'permission-needed'

// DOM Elements
const btnOpenPdf = document.getElementById('btn-open-pdf');
const btnOpenBundle = document.getElementById('btn-open-bundle');
const btnLinkFolder = document.getElementById('btn-link-folder');
const btnSaveWorkspace = document.getElementById('btn-save-workspace');
const btnThemeToggle = document.getElementById('theme-toggle');
const syncStatusBadge = document.getElementById('sync-status-badge');
const srStatus = document.getElementById('sr-status');
const inputPdfFile = document.getElementById('input-pdf-file');
const inputBundleFile = document.getElementById('input-bundle-file');
const restoreBanner = document.getElementById('restore-banner');
const restoreFilenameSpan = document.getElementById('restore-filename');
const btnRestoreConfirm = document.getElementById('btn-restore-confirm');
const btnRestoreDiscard = document.getElementById('btn-restore-discard');
const btnPlaceholderOpen = document.getElementById('btn-placeholder-open');
const previewContainerInner = document.getElementById('preview-container').querySelector('.preview-scrollable');

const lightboxDialog = document.getElementById('image-lightbox');
const lightboxImage = document.getElementById('lightbox-image');
const lightboxSvgContainer = document.getElementById('lightbox-svg-container');

const confirmDialog = document.getElementById('confirm-dialog');
const confirmDialogTitle = document.getElementById('confirm-dialog-title');
const confirmDialogMessage = document.getElementById('confirm-dialog-message');
const confirmDialogCancel = document.getElementById('confirm-dialog-cancel');
const confirmDialogAlt = document.getElementById('confirm-dialog-alt');
const confirmDialogOk = document.getElementById('confirm-dialog-ok');
const confirmDialogClose = document.getElementById('confirm-dialog-close');

function announceStatus(message) {
  if (srStatus) {
    srStatus.textContent = message;
  }
}

function showConfirmDialog({
  title = 'Confirm',
  message = '',
  confirmLabel = 'OK',
  altLabel = null,
  cancelLabel = 'Cancel'
}) {
  return new Promise((resolve) => {
    confirmDialogTitle.textContent = title;
    confirmDialogMessage.textContent = message;
    confirmDialogOk.textContent = confirmLabel;

    if (cancelLabel) {
      confirmDialogCancel.hidden = false;
      confirmDialogCancel.textContent = cancelLabel;
    } else {
      confirmDialogCancel.hidden = true;
    }

    if (altLabel) {
      confirmDialogAlt.hidden = false;
      confirmDialogAlt.textContent = altLabel;
    } else {
      confirmDialogAlt.hidden = true;
    }

    const onClose = () => {
      const result = confirmDialog.returnValue || 'cancel';
      confirmDialog.returnValue = '';
      confirmDialog.removeEventListener('close', onClose);
      resolve(result);
    };

    confirmDialog.addEventListener('close', onClose);
    confirmDialog.showModal();
  });
}

async function showAlertDialog(title, message) {
  await showConfirmDialog({
    title,
    message,
    confirmLabel: 'OK',
    cancelLabel: null
  });
}

function setupDialogClosedByFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;

  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) {
        dialog.close();
      }
    });
  }
}

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', async () => {
  await initDb();
  setupDialogClosedByFallback();

  confirmDialogClose?.addEventListener('click', () => {
    confirmDialog.close('cancel');
  });

  initPdfViewer({
    onPageChange: handlePageChange,
    onMarkupChange: handleMarkupChange,
    onFileDrop: handleDroppedFile,
    onNotify: announceStatus,
    onConfirm: async (opts) => (await showConfirmDialog(opts)) === 'confirm'
  });

  initEditor({
    onTextChange: handleNotesTextChange,
    onImagePaste: handleImagePaste
  });

  initMarkdownRenderer();

  try {
    const savedHandle = await loadDirHandle();
    if (savedHandle) {
      activeDirHandle = savedHandle;
      const granted = await verifyPermission(activeDirHandle, true, false);
      if (!granted) {
        saveState = 'permission-needed';
      }
      updateSyncStatusBadge();
    }
  } catch (err) {
    console.error('Failed loading saved directory handle:', err);
  }

  initTheme();
  await checkForRecoveryJournals();

  btnOpenPdf.addEventListener('click', () => inputPdfFile.click());
  btnPlaceholderOpen.addEventListener('click', () => inputPdfFile.click());
  btnOpenBundle.addEventListener('click', () => inputBundleFile.click());

  inputPdfFile.addEventListener('change', handlePdfFileSelect);
  inputBundleFile.addEventListener('change', handleBundleFileSelect);

  btnLinkFolder.addEventListener('click', handleLinkFolder);
  btnSaveWorkspace.addEventListener('click', exportWorkspaceBundle);

  syncStatusBadge?.addEventListener('click', async () => {
    if (saveState === 'permission-needed' && activeDirHandle) {
      const granted = await verifyPermission(activeDirHandle, true, true);
      if (granted) {
        await triggerSave(true);
        announceStatus('Local folder sync reconnected.');
      }
    } else if (activePdfHash) {
      await triggerSave(true);
    }
  });

  // Drag & drop bundle/PDF on the whole window (only if not handled by pdfViewport)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', handleFileDrop);

  // Warn before closing tab if there are pending unpersisted edits
  window.addEventListener('beforeunload', (e) => {
    if (saveState === 'unsaved' || saveState === 'saving') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Lightbox Image & Diagram Viewer Events
  const activateMediaTarget = (target) => {
    if (target.tagName === 'IMG' && target.src) {
      openLightboxImage(target.src, target.alt);
      return;
    }

    const mermaidContainer = target.closest('.mermaid-svg-container');
    if (mermaidContainer) {
      const svgElement = mermaidContainer.querySelector('svg');
      if (svgElement) {
        openLightboxSvg(svgElement);
      }
    }
  };

  previewContainerInner.addEventListener('click', (e) => activateMediaTarget(e.target));
  previewContainerInner.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const mermaidContainer = e.target.closest('.mermaid-svg-container');
      if (mermaidContainer) {
        e.preventDefault();
        activateMediaTarget(mermaidContainer);
      }
    }
  });

  lightboxDialog.addEventListener('close', () => {
    lightboxImage.src = '';
    lightboxImage.hidden = true;
    lightboxSvgContainer.replaceChildren();
    lightboxSvgContainer.hidden = true;
  });
});

// --- LIGHTBOX IMAGE / DIAGRAM VIEWER (Native <dialog>) ---

function openLightboxImage(src, alt) {
  lightboxSvgContainer.replaceChildren();
  lightboxSvgContainer.hidden = true;

  lightboxImage.src = src;
  lightboxImage.alt = alt || 'Expanded View';
  lightboxImage.hidden = false;

  if (!lightboxDialog.open) {
    lightboxDialog.showModal();
  }
}

function openLightboxSvg(svgElement) {
  const clonedSvg = svgElement.cloneNode(true);
  clonedSvg.removeAttribute('width');
  clonedSvg.removeAttribute('height');
  clonedSvg.style.width = '100%';
  clonedSvg.style.height = '100%';
  clonedSvg.style.maxWidth = '100%';
  clonedSvg.style.maxHeight = '100%';

  lightboxImage.src = '';
  lightboxImage.hidden = true;

  lightboxSvgContainer.replaceChildren(clonedSvg);
  lightboxSvgContainer.hidden = false;

  if (!lightboxDialog.open) {
    lightboxDialog.showModal();
  }
}

// --- THEME MANAGEMENT (<meta name="color-scheme"> + light-dark()) ---

function initTheme() {
  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');

  // Migrate legacy 'theme' key if present
  try {
    const legacy = localStorage.getItem('theme');
    if (legacy && !localStorage.getItem('color-scheme')) {
      if (legacy === 'dark' || legacy === 'light') {
        localStorage.setItem('color-scheme', legacy);
      }
      localStorage.removeItem('theme');
    }
  } catch {
    // Ignore storage restriction
  }

  const getStoredScheme = () => {
    try {
      const val = localStorage.getItem('color-scheme');
      return val === 'light' || val === 'dark' ? val : null;
    } catch {
      return null;
    }
  };

  const applyResolvedTheme = (schemeOverride = getStoredScheme()) => {
    const metaVal = schemeOverride ?? 'light dark';
    if (schemeMeta) {
      schemeMeta.content = metaVal;
    }
    const isDark = schemeOverride ? schemeOverride === 'dark' : darkMedia.matches;
    document.body.classList.toggle('dark-theme', isDark);

    const iconSpan = btnThemeToggle.querySelector('span');
    if (iconSpan) {
      iconSpan.textContent = isDark ? 'light_mode' : 'dark_mode';
    }
    btnThemeToggle.setAttribute(
      'aria-label',
      isDark ? 'Switch to light color theme' : 'Switch to dark color theme'
    );
    updateMermaidTheme(isDark).then(() => {
      if (activePdfHash) updateNotesPreview();
    });
  };

  applyResolvedTheme();

  btnThemeToggle.addEventListener('click', () => {
    const currentStored = getStoredScheme();
    const currentlyDark = currentStored ? currentStored === 'dark' : darkMedia.matches;
    const target = currentlyDark ? 'light' : 'dark';
    const systemScheme = darkMedia.matches ? 'dark' : 'light';

    let nextStored = null;
    try {
      if (target !== systemScheme) {
        localStorage.setItem('color-scheme', target);
        nextStored = target;
      } else {
        // Matches OS default again: remove override so system changes resume applying
        localStorage.removeItem('color-scheme');
        nextStored = null;
      }
    } catch {
      nextStored = target;
    }

    applyResolvedTheme(nextStored);
  });

  darkMedia.addEventListener('change', () => {
    if (!getStoredScheme()) {
      applyResolvedTheme(null);
    }
  });

  window.addEventListener('storage', (e) => {
    if (e.key === 'color-scheme') {
      applyResolvedTheme();
    }
  });
}

// --- FILE HANDLERS ---

function isPdfFile(file) {
  return Boolean(file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')));
}

function isBundleFile(file) {
  const lower = file?.name?.toLowerCase() || '';
  return lower.endsWith('.pdfmd') || lower.endsWith('.zip');
}

async function checkUnsavedChanges() {
  if (saveState === 'unsaved' || saveState === 'cache-only') {
    const choice = await showConfirmDialog({
      title: 'Unsaved Workspace Changes',
      message:
        saveState === 'unsaved'
          ? 'You have unsaved changes. Save a .pdfmd bundle before loading a new document?'
          : 'Your latest edits are cached in browser storage only (not exported to a .pdfmd file). Save a bundle before switching?',
      confirmLabel: 'Save Bundle',
      altLabel: 'Discard & Continue',
      cancelLabel: 'Cancel'
    });

    if (choice === 'confirm') {
      await exportWorkspaceBundle();
      return true;
    }
    return choice === 'discard';
  }
  return true;
}

async function handleDroppedFile(file) {
  if (isBundleFile(file)) {
    const proceed = await checkUnsavedChanges();
    if (proceed) {
      await importWorkspaceBundle(file);
    }
  } else if (isPdfFile(file)) {
    const proceed = await checkUnsavedChanges();
    if (proceed) {
      await loadPdfFileObject(file);
    }
  }
}

async function handlePdfFileSelect(e) {
  const file = e.target.files?.[0];
  inputPdfFile.value = '';
  if (file) {
    const proceed = await checkUnsavedChanges();
    if (proceed) {
      await loadPdfFileObject(file);
    }
  }
}

async function handleBundleFileSelect(e) {
  const file = e.target.files?.[0];
  inputBundleFile.value = '';
  if (file) {
    const proceed = await checkUnsavedChanges();
    if (proceed) {
      await importWorkspaceBundle(file);
    }
  }
}

async function handleFileDrop(e) {
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (isBundleFile(file) || isPdfFile(file)) {
      e.preventDefault();
      await handleDroppedFile(file);
    }
  }
}

async function loadPdfFileObject(file) {
  try {
    const rawBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(rawBuffer).slice();
    const hash = await calculateSHA256(bytes);

    activePdfBytes = bytes;
    activePdfHash = hash;
    activePdfName = file.name;
    activePageIdx = 0;
    setActivePage(0);

    await loadPdfData(bytes);
    await initializeWorkspace();
    announceStatus(`Loaded ${file.name}`);
  } catch (err) {
    console.error('Failed loading PDF file:', err);
    await showAlertDialog('PDF Load Error', `Failed loading PDF: ${err?.message || String(err)}`);
  }
}

async function calculateSHA256(bytesOrBuffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytesOrBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- WORKSPACE INITIALIZATION & PERSISTENCE ---

async function initializeWorkspace() {
  const journal = await loadRecoveryJournal(activePdfHash);
  if (journal) {
    restoreFilenameSpan.textContent = activePdfName;
    restoreBanner.hidden = false;
    restoreBanner.classList.remove('hidden');

    btnRestoreConfirm.onclick = async () => {
      notesData = {
        meta: {
          version: '1.0.0',
          pdfHash: activePdfHash,
          originalName: activePdfName,
          lastModified: journal.timestamp
        },
        pages: journal.pages || {}
      };

      const cache = await loadWorkspaceFromCache(activePdfHash);
      assetsRegistry = cache ? cache.assets || {} : {};
      setMarkupData(journal.markup || {});

      restoreBanner.classList.add('hidden');
      restoreBanner.hidden = true;
      resetAssetsCounters(notesData);
      checkOrphanedNotes();
      loadPageNotes();

      await triggerSave(true);
    };

    btnRestoreDiscard.onclick = async () => {
      await clearRecoveryJournal(activePdfHash);
      restoreBanner.classList.add('hidden');
      restoreBanner.hidden = true;
      await loadStandardWorkspace();
    };
  } else {
    await loadStandardWorkspace();
  }
}

async function loadStandardWorkspace() {
  const cache = await loadWorkspaceFromCache(activePdfHash);
  let markup = await loadMarkupFromCache(activePdfHash);

  if (cache) {
    notesData = {
      meta: cache.meta,
      pages: cache.pages || {}
    };
    assetsRegistry = cache.assets || {};
  } else if (activeDirHandle) {
    // Attempt reading existing notes JSON from linked local folder if no cache exists yet
    const folderData = await readFromLocalFolder(activeDirHandle, activePdfName);
    if (folderData && folderData.pages) {
      notesData = {
        meta: folderData.meta || {
          version: '1.0.0',
          pdfHash: activePdfHash,
          originalName: activePdfName,
          lastModified: new Date().toISOString()
        },
        pages: folderData.pages
      };
      assetsRegistry = folderData.assets || {};
      if (folderData.markup) markup = folderData.markup;
    } else {
      notesData = createEmptyNotesMeta();
      assetsRegistry = {};
    }
  } else {
    notesData = createEmptyNotesMeta();
    assetsRegistry = {};
  }

  setMarkupData(markup || {});
  resetAssetsCounters(notesData);
  checkOrphanedNotes();
  loadPageNotes();

  saveState = activeDirHandle ? 'saved' : 'saved';
  updateSyncStatusBadge();
}

function createEmptyNotesMeta() {
  return {
    meta: {
      version: '1.0.0',
      pdfHash: activePdfHash,
      originalName: activePdfName,
      lastModified: new Date().toISOString()
    },
    pages: {}
  };
}

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

// --- CALLBACK HANDLERS ---

function handlePageChange(pageIdx) {
  if (activePageIdx === pageIdx) return;

  const oldMarkdown = getEditorContent();
  saveActivePageNotes(activePageIdx, oldMarkdown);

  activePageIdx = pageIdx;
  setActivePage(pageIdx);
  loadPageNotes();
}

function handleNotesTextChange(text) {
  saveActivePageNotes(activePageIdx, text);
  markUnsaved();
  renderMarkdown(text, assetsRegistry, previewContainerInner);
}

function handleMarkupChange() {
  markUnsaved();
}

function handleImagePaste(name, dataURL) {
  assetsRegistry[name] = dataURL;

  if (!notesData.pages[activePageIdx]) {
    notesData.pages[activePageIdx] = { markdown: '', assets: [] };
  }
  if (!notesData.pages[activePageIdx].assets) {
    notesData.pages[activePageIdx].assets = [];
  }
  notesData.pages[activePageIdx].assets.push(name);

  markUnsaved();
}

function saveActivePageNotes(pageIdx, text) {
  if (!notesData.pages[pageIdx]) {
    notesData.pages[pageIdx] = { markdown: '', assets: [] };
  }
  notesData.pages[pageIdx].markdown = text;
}

function checkOrphanedNotes() {
  const totalPages = getNumPages() || notesData.meta?.pageCount || 999999;
  const orphans = {};

  Object.entries(notesData.pages).forEach(([pIdxStr, data]) => {
    const pIdx = parseInt(pIdxStr, 10);
    if (!isNaN(pIdx) && pIdx >= totalPages && data?.markdown?.trim()) {
      orphans[pIdx] = data;
    }
  });

  renderOrphanedNotes(orphans, handleRestoreOrphan);
}

function handleRestoreOrphan(oldPageIdxStr, orphanData) {
  const currentText = getEditorContent();
  const separator = currentText.trim() ? '\n\n' : '';
  const restoredText = `${currentText}${separator}### Restored Note (Page ${parseInt(oldPageIdxStr, 10) + 1})\n${orphanData.markdown}`;
  setEditorContent(restoredText);
  saveActivePageNotes(activePageIdx, restoredText);

  if (Array.isArray(orphanData.assets) && orphanData.assets.length > 0) {
    notesData.pages[activePageIdx].assets ??= [];
    orphanData.assets.forEach((assetName) => {
      if (!notesData.pages[activePageIdx].assets.includes(assetName)) {
        notesData.pages[activePageIdx].assets.push(assetName);
      }
    });
  }

  delete notesData.pages[oldPageIdxStr];
  updateNotesPreview();
  checkOrphanedNotes();
  markUnsaved();
}

// --- SYNC STATUS & AUTO-SAVE PIPELINES ---

function markUnsaved() {
  if (saveState !== 'unsaved') {
    saveState = 'unsaved';
    updateSyncStatusBadge();
  }

  if (autoSaveTimer) clearTimeout(autoSaveTimer);

  autoSaveTimer = setTimeout(async () => {
    await triggerSave();
  }, 3000);
}

async function triggerSave(forceFinal = false) {
  if (!activePdfHash) return;

  saveState = 'saving';
  updateSyncStatusBadge();

  saveActivePageNotes(activePageIdx, getEditorContent());
  const markup = getMarkupData();

  try {
    if (forceFinal) {
      await saveWorkspaceToCache(activePdfHash, activePdfName, notesData.pages, assetsRegistry, activePdfBytes);
      await saveMarkupToCache(activePdfHash, markup);
      await clearRecoveryJournal(activePdfHash);

      if (activeDirHandle) {
        const mdText = compileMarkdownDocument();
        await writeToLocalFolder(
          activeDirHandle,
          activePdfName,
          { ...notesData, markup, assets: assetsRegistry },
          mdText,
          { allowPrompt: true }
        );
        saveState = 'saved';
      } else {
        saveState = 'cache-only';
      }
    } else {
      await saveRecoveryJournal(activePdfHash, activePdfName, notesData.pages, markup, activePdfBytes);

      if (activeDirHandle) {
        const mdText = compileMarkdownDocument();
        await writeToLocalFolder(
          activeDirHandle,
          activePdfName,
          { ...notesData, markup, assets: assetsRegistry },
          mdText,
          { allowPrompt: false }
        );
        await saveWorkspaceToCache(activePdfHash, activePdfName, notesData.pages, assetsRegistry, activePdfBytes);
        await saveMarkupToCache(activePdfHash, markup);
        await clearRecoveryJournal(activePdfHash);
        saveState = 'saved';
      } else {
        saveState = 'cache-only';
      }
    }
  } catch (error) {
    if (error?.code === 'PERMISSION_REQUIRED') {
      saveState = 'permission-needed';
    } else {
      console.error('Auto-save write failed:', error);
      saveState = 'unsaved';
    }
  }

  updateSyncStatusBadge();
}

function updateSyncStatusBadge() {
  if (!syncStatusBadge) return;
  if (!activePdfHash && !activeDirHandle) {
    syncStatusBadge.hidden = true;
    return;
  }

  syncStatusBadge.hidden = false;
  syncStatusBadge.classList.remove('saved', 'cache-only', 'unsaved', 'saving', 'permission-needed');

  const iconEl = syncStatusBadge.querySelector('.sync-icon');
  const labelEl = syncStatusBadge.querySelector('.sync-label');

  switch (saveState) {
    case 'saving':
      syncStatusBadge.classList.add('saving');
      if (iconEl) iconEl.textContent = 'sync';
      if (labelEl) labelEl.textContent = 'Saving...';
      syncStatusBadge.title = 'Saving workspace...';
      break;
    case 'unsaved':
      syncStatusBadge.classList.add('unsaved');
      if (iconEl) iconEl.textContent = 'edit_notifications';
      if (labelEl) labelEl.textContent = 'Unsaved';
      syncStatusBadge.title = 'Changes pending auto-save';
      break;
    case 'cache-only':
      syncStatusBadge.classList.add('cache-only');
      if (iconEl) iconEl.textContent = 'inventory_2';
      if (labelEl) labelEl.textContent = 'Cached';
      syncStatusBadge.title = 'Saved in browser cache. Click Save to export .pdfmd or Link Folder to sync.';
      break;
    case 'permission-needed':
      syncStatusBadge.classList.add('unsaved');
      if (iconEl) iconEl.textContent = 'folder_off';
      if (labelEl) labelEl.textContent = 'Reconnect Folder';
      syncStatusBadge.title = 'Click to re-grant permission to your linked local folder';
      break;
    default:
      syncStatusBadge.classList.add('saved');
      if (iconEl) iconEl.textContent = 'cloud_done';
      if (labelEl) labelEl.textContent = 'Saved';
      syncStatusBadge.title = 'All changes saved';
  }
}

async function handleLinkFolder() {
  if (!window.showDirectoryPicker) {
    await showAlertDialog(
      'Unsupported Browser',
      'Your browser does not support the File System Access API. Please use Chrome/Edge, or export your workspace bundle using "Save".'
    );
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    activeDirHandle = handle;
    await saveDirHandle(handle);

    if (activePdfHash) {
      await triggerSave(true);
    } else {
      saveState = 'saved';
      updateSyncStatusBadge();
    }
    announceStatus('Local folder linked.');
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Directory selection failed:', error);
    }
  }
}

// --- FILE FORMAT EXPORTERS / IMPORTERS ---

function compileMarkdownDocument() {
  let docText = `---
app: pdf-notes-editor
pdf-target: ${activePdfName}
pdf-hash: ${activePdfHash}
last-modified: ${new Date().toISOString()}
---\n\n`;

  const pages = Object.keys(notesData.pages).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  pages.forEach((pIdxStr) => {
    const pIdx = parseInt(pIdxStr, 10);
    const pageObj = notesData.pages[pIdxStr];
    if (pageObj && pageObj.markdown?.trim()) {
      docText += `---\npage: ${pIdx + 1}\n---\n`;
      docText += pageObj.markdown.trim() + '\n\n';
    }
  });

  return docText;
}

// Export workspace bundle (.pdfmd / .zip) with lazy-loaded JSZip
async function exportWorkspaceBundle() {
  if (!activePdfBytes || activePdfBytes.byteLength === 0) {
    await showAlertDialog('No Document Loaded', 'Please load a PDF document first.');
    return;
  }

  saveActivePageNotes(activePageIdx, getEditorContent());

  try {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();

    zip.file(activePdfName, activePdfBytes);

    const workspaceJSON = {
      meta: {
        version: '1.0.0',
        pdfHash: activePdfHash,
        originalName: activePdfName,
        pageCount: getNumPages(),
        lastModified: new Date().toISOString()
      },
      pages: notesData.pages,
      markup: getMarkupData()
    };
    zip.file('notes.json', JSON.stringify(workspaceJSON, null, 2));

    const assetsDir = zip.folder('assets');
    for (const [imgName, dataURL] of Object.entries(assetsRegistry)) {
      try {
        const blob = dataURLtoBlob(dataURL);
        assetsDir.file(imgName, blob);
      } catch (err) {
        console.error('Failed bundling image into zip:', imgName, err);
      }
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const baseName = activePdfName.substring(0, activePdfName.lastIndexOf('.')) || activePdfName;
    const downloadName = `${baseName}_workspace.pdfmd`;

    const blobUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

    await clearRecoveryJournal(activePdfHash);
    saveState = 'saved';
    updateSyncStatusBadge();
    announceStatus(`Exported ${downloadName}`);
  } catch (error) {
    console.error('Error generating bundle:', error);
    await showAlertDialog('Export Failed', `Failed creating workspace bundle: ${error?.message || String(error)}`);
  }
}

// Import workspace bundle (.pdfmd / .zip)
async function importWorkspaceBundle(zipFile) {
  try {
    showViewerStatus('Decompressing bundle...');

    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(zipFile);

    const notesJsonFile = zip.file('notes.json');
    if (!notesJsonFile) {
      throw new Error('notes.json not found in workspace bundle');
    }

    const notesJSONText = await notesJsonFile.async('text');
    const importedWorkspace = JSON.parse(notesJSONText);

    const pdfFilenameFromMeta = importedWorkspace.meta?.originalName;
    let pdfZipFile = pdfFilenameFromMeta ? zip.file(pdfFilenameFromMeta) : null;

    if (!pdfZipFile) {
      const pdfFiles = Object.keys(zip.files).filter((name) => name.toLowerCase().endsWith('.pdf'));
      if (pdfFiles.length > 0) {
        pdfZipFile = zip.file(pdfFiles[0]);
      }
    }

    if (!pdfZipFile) {
      throw new Error('Original PDF file not found in bundle');
    }

    const pdfBuffer = await pdfZipFile.async('arraybuffer');
    const pdfBytes = new Uint8Array(pdfBuffer).slice();
    activePdfBytes = pdfBytes;
    activePdfName = pdfZipFile.name;
    activePdfHash = importedWorkspace.meta?.pdfHash || (await calculateSHA256(pdfBytes));
    activePageIdx = 0;
    setActivePage(0);

    // Load assets (images) safely with onerror handling
    assetsRegistry = {};
    const imageFiles = [];
    zip.forEach((relativePath, file) => {
      if (relativePath.startsWith('assets/') && !file.dir) {
        imageFiles.push(file);
      }
    });

    for (const imgFile of imageFiles) {
      const imgName = imgFile.name.slice('assets/'.length);
      const imgBlob = await imgFile.async('blob');

      const dataURL = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = (e) => resolve(e.target.result);
        r.onerror = () => reject(r.error || new Error(`Failed reading asset ${imgName}`));
        r.readAsDataURL(imgBlob);
      });

      assetsRegistry[imgName] = dataURL;
    }

    notesData = {
      meta: importedWorkspace.meta || {
        version: '1.0.0',
        pdfHash: activePdfHash,
        originalName: activePdfName,
        lastModified: new Date().toISOString()
      },
      pages: importedWorkspace.pages || {}
    };

    await loadPdfData(pdfBytes);

    setMarkupData(importedWorkspace.markup || {});
    resetAssetsCounters(notesData);
    checkOrphanedNotes();
    loadPageNotes();

    await triggerSave(true);

    saveState = 'saved';
    updateSyncStatusBadge();
    announceStatus(`Imported bundle ${zipFile.name}`);
  } catch (error) {
    console.error('Import bundle failed:', error);
    showViewerStatus(`Failed to import bundle: ${error?.message || String(error)}`, true);
  }
}

// Check if any crash recovery journal exists in IndexedDB on initialization
async function checkForRecoveryJournals() {
  try {
    const journals = await checkAllRecoveryJournals();
    if (journals && journals.length > 0) {
      const recent = journals.toSorted((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

      restoreFilenameSpan.textContent = recent.originalName;
      restoreBanner.hidden = false;
      restoreBanner.classList.remove('hidden');

      btnRestoreConfirm.onclick = async () => {
        const cache = await loadWorkspaceFromCache(recent.pdfHash);
        const pdfBytesSource = recent.pdfBytes || (cache ? cache.pdfBytes : null);

        if (pdfBytesSource) {
          let resolvedPdfBytes;
          if (pdfBytesSource instanceof Blob) {
            resolvedPdfBytes = new Uint8Array(await pdfBytesSource.arrayBuffer());
          } else {
            resolvedPdfBytes = new Uint8Array(pdfBytesSource).slice();
          }

          activePdfBytes = resolvedPdfBytes;
          activePdfHash = recent.pdfHash;
          activePdfName = recent.originalName;
          activePageIdx = 0;
          setActivePage(0);

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

          assetsRegistry = cache ? cache.assets || {} : {};
          setMarkupData(recent.markup || {});
          resetAssetsCounters(notesData);
          checkOrphanedNotes();
          loadPageNotes();

          restoreBanner.classList.add('hidden');
          restoreBanner.hidden = true;
          await triggerSave(true);
        } else {
          await showAlertDialog(
            'Original PDF Needed',
            `Could not find cached PDF file bytes for "${recent.originalName}". Please open the original PDF file to restore your recovered notes.`
          );

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

          assetsRegistry = cache ? cache.assets || {} : {};
          setMarkupData(recent.markup || {});
          resetAssetsCounters(notesData);
          restoreBanner.classList.add('hidden');
          restoreBanner.hidden = true;
        }
      };

      btnRestoreDiscard.onclick = async () => {
        await clearRecoveryJournal(recent.pdfHash);
        restoreBanner.classList.add('hidden');
        restoreBanner.hidden = true;
      };
    }
  } catch (err) {
    console.error('Checking journals failed:', err);
  }
}
