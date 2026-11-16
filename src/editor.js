import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading, color: 'var(--md-sys-color-primary)', fontWeight: 'bold' },
  { tag: t.meta, color: 'var(--md-sys-color-primary)', fontWeight: 'bold' },
  { tag: t.keyword, color: 'var(--md-sys-color-primary)' },
  { tag: t.punctuation, color: 'var(--md-sys-color-primary)' },
  { tag: t.processingInstruction, color: 'var(--md-sys-color-primary)' },
  { tag: t.string, color: 'var(--md-sys-color-success)' },
  { tag: t.url, color: 'var(--md-sys-color-outline)' },
  { tag: t.link, color: 'var(--md-sys-color-primary)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.comment, color: 'var(--md-sys-color-outline)', fontStyle: 'italic' }
]);

let editorView = null;
let editorExtensions = [];
let currentMode = 'read'; // 'read' or 'edit'
let activePageIdx = 0;
let pageAssetsCounter = {}; // keyed by page index, counts pasted images to avoid collisions

// Callbacks
let onTextChangeCallback = null;
let onImagePasteCallback = null;

// DOM Elements
const rightPanel = document.getElementById('right-panel');
const btnCollapseRight = document.getElementById('btn-collapse-right');
const btnExpandRight = document.getElementById('btn-expand-right');
const fabToggleMode = document.getElementById('fab-toggle-mode');
const editorContainer = document.getElementById('editor-container');
const previewContainer = document.getElementById('preview-container');
const notePageNumSpan = document.getElementById('note-page-num');
const orphanedNotesSection = document.getElementById('orphaned-notes-section');
const orphanedHeader = orphanedNotesSection.querySelector('.orphaned-header');
const orphanedContent = orphanedNotesSection.querySelector('.orphaned-content');
const orphanedCountSpan = document.getElementById('orphaned-count');

// Initialize the editor
export function initEditor({ onTextChange, onImagePaste }) {
  onTextChangeCallback = onTextChange;
  onImagePasteCallback = onImagePaste;

  editorExtensions = [
    basicSetup,
    markdown(),
    syntaxHighlighting(markdownHighlightStyle),
    EditorView.theme({
      '&': {
        height: '100%',
        fontSize: '14px',
        color: 'var(--md-sys-color-on-surface)',
        backgroundColor: 'var(--md-sys-color-surface)'
      },
      '.cm-scroller': {
        overflow: 'auto',
        backgroundColor: 'var(--md-sys-color-surface)'
      },
      '.cm-content': {
        fontFamily: 'var(--font-family-code)',
        color: 'var(--md-sys-color-on-surface)',
        caretColor: 'var(--md-sys-color-on-surface)'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--md-sys-color-on-surface)'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--md-sys-color-surface)',
        color: 'var(--md-sys-color-on-surface-variant)',
        borderRight: '1px solid var(--md-sys-color-outline-variant)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--md-sys-color-surface-variant)',
        color: 'var(--md-sys-color-on-surface)'
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in oklab, var(--md-sys-color-surface-variant), transparent 55%)'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'color-mix(in oklab, var(--md-sys-color-primary), transparent 72%)'
      }
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onTextChangeCallback) {
        onTextChangeCallback(update.state.doc.toString());
      }
    })
  ];

  const startState = EditorState.create({
    doc: '',
    extensions: editorExtensions
  });

  editorView = new EditorView({
    state: startState,
    parent: editorContainer
  });

  // Ensure initial inert state matches default 'read' mode
  editorContainer.inert = true;
  previewContainer.inert = false;

  // Setup FAB Toggle Mode
  fabToggleMode.addEventListener('click', toggleMode);

  // Setup Keyboard Shortcut Ctrl + E to toggle Mode
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (rightPanel.classList.contains('collapsed')) {
        expandRightPanel();
      }
      toggleMode();
    }
  });

  // Setup Sidebar Collapses
  btnCollapseRight.addEventListener('click', collapseRightPanel);
  btnExpandRight.addEventListener('click', expandRightPanel);

  // Setup Formatting Accelerator Buttons
  document.getElementById('btn-insert-link').addEventListener('click', () => insertLink());
  document.getElementById('btn-insert-image').addEventListener('click', () => triggerImageUpload());
  document.getElementById('btn-insert-mermaid').addEventListener('click', () => insertMermaidTemplate());

  // Setup Hidden Image Input File change listener
  const inputImageFile = document.getElementById('input-image-file');
  inputImageFile.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (files.length > 0) {
      await handleImageFile(files[0]);
    }
    inputImageFile.value = '';
  });

  // Drag-and-drop / Paste handler for editorContainer
  editorContainer.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        await handleImageFile(file);
      }
    }
  });

  editorContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  editorContainer.addEventListener('drop', async (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length > 0 && files[0].type.startsWith('image/')) {
      e.preventDefault();
      e.stopPropagation();
      await handleImageFile(files[0]);
    }
  });

  // Accordion Toggle for Orphaned Notes
  orphanedHeader.addEventListener('click', () => {
    const collapsed = orphanedNotesSection.classList.toggle('collapsed');
    orphanedHeader.setAttribute('aria-expanded', String(!collapsed));
  });
}

function collapseRightPanel() {
  rightPanel.classList.add('collapsed');
  rightPanel.inert = true;
  btnExpandRight.hidden = false;
  btnExpandRight.classList.remove('hidden');
  btnExpandRight.focus();
}

function expandRightPanel() {
  rightPanel.classList.remove('collapsed');
  rightPanel.inert = false;
  btnExpandRight.classList.add('hidden');
  btnExpandRight.hidden = true;
  btnCollapseRight.focus();
}

// Update the active page index
export function setActivePage(pIdx) {
  activePageIdx = pIdx;
  notePageNumSpan.textContent = pIdx + 1;
}

// Toggle between Read and Edit Modes with transitions
export function setMode(mode) {
  if (currentMode === mode) return;
  currentMode = mode;

  const fabIcon = fabToggleMode.querySelector('.fab-icon');

  if (mode === 'edit') {
    previewContainer.classList.remove('active');
    previewContainer.inert = true;
    editorContainer.classList.add('active');
    editorContainer.inert = false;
    fabIcon.textContent = 'visibility';
    fabToggleMode.title = 'Switch to Read Mode (Ctrl + E)';
    fabToggleMode.setAttribute('aria-label', 'Switch to read mode');
    setTimeout(() => editorView?.focus(), 150);
  } else {
    editorContainer.classList.remove('active');
    editorContainer.inert = true;
    previewContainer.classList.add('active');
    previewContainer.inert = false;
    fabIcon.textContent = 'edit';
    fabToggleMode.title = 'Switch to Edit Mode (Ctrl + E)';
    fabToggleMode.setAttribute('aria-label', 'Switch to edit mode');
  }
}

function toggleMode() {
  if (currentMode === 'read') {
    setMode('edit');
  } else {
    setMode('read');
  }
}

// Get and Set Editor Markdown Content without polluting undo history or firing docChanged
export function getEditorContent() {
  return editorView ? editorView.state.doc.toString() : '';
}

export function setEditorContent(text) {
  if (!editorView) return;
  const freshState = EditorState.create({
    doc: text || '',
    extensions: editorExtensions
  });
  editorView.setState(freshState);
}

// Ensure editor is visible when inserting content via toolbar accelerators
function ensureEditModeOpen() {
  if (rightPanel.classList.contains('collapsed')) {
    expandRightPanel();
  }
  if (currentMode !== 'edit') {
    setMode('edit');
  }
}

// --- ACCELERATOR BUTTON ACTIONS ---

function insertLink() {
  ensureEditModeOpen();
  const state = editorView.state;
  const selection = state.selection.main;
  const selectedText = state.sliceDoc(selection.from, selection.to);
  const insertStr = `[${selectedText || 'link text'}](https://)`;

  editorView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: insertStr },
    selection: { anchor: selection.from + insertStr.length }
  });
  editorView.focus();
}

function triggerImageUpload() {
  ensureEditModeOpen();
  document.getElementById('input-image-file').click();
}

function insertMermaidTemplate() {
  ensureEditModeOpen();
  const state = editorView.state;
  const selection = state.selection.main;
  const template = `\n\`\`\`mermaid\ngraph TD\n    A[Start] --> B[Process]\n    B --> C[End]\n\`\`\`\n`;

  editorView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: template },
    selection: { anchor: selection.from + template.length }
  });
  editorView.focus();
}

// --- ASSET / IMAGE UPLOAD AND SEQUENTIAL NAMING ---

async function handleImageFile(file) {
  if (!file) return;
  ensureEditModeOpen();

  const dataURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error || new Error('Failed reading image file'));
    reader.readAsDataURL(file);
  }).catch((err) => {
    console.error(err);
    return null;
  });

  if (!dataURL) return;

  if (pageAssetsCounter[activePageIdx] === undefined) {
    pageAssetsCounter[activePageIdx] = 0;
  }

  const index = pageAssetsCounter[activePageIdx]++;
  const imgName = `img_p${activePageIdx}_${index}.png`;

  if (onImagePasteCallback) {
    onImagePasteCallback(imgName, dataURL);
  }

  const state = editorView.state;
  const selection = state.selection.main;
  const imgMarkdown = `![User Asset](assets/${imgName})`;

  editorView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: imgMarkdown },
    selection: { anchor: selection.from + imgMarkdown.length }
  });

  editorView.focus();
}

// Set assets counter state (used when loading a workspace to reset counters)
export function resetAssetsCounters(workspaceData) {
  pageAssetsCounter = {};

  if (workspaceData && workspaceData.pages) {
    Object.entries(workspaceData.pages).forEach(([pageStr, pageObj]) => {
      const pIdx = parseInt(pageStr, 10);
      let maxIdx = -1;

      const regex = new RegExp(`assets/img_p${pIdx}_(\\d+)\\.png`, 'g');
      const text = pageObj.markdown || '';
      let match;

      while ((match = regex.exec(text)) !== null) {
        const val = parseInt(match[1], 10);
        if (val > maxIdx) maxIdx = val;
      }

      if (pageObj.assets) {
        pageObj.assets.forEach((assetName) => {
          const matchAsset = new RegExp(`img_p${pIdx}_(\\d+)\\.png`).exec(assetName);
          if (matchAsset) {
            const val = parseInt(matchAsset[1], 10);
            if (val > maxIdx) maxIdx = val;
          }
        });
      }

      pageAssetsCounter[pIdx] = maxIdx + 1;
    });
  }
}

// --- ORPHANED NOTES ACCORDION ---

export function renderOrphanedNotes(orphans, onRestoreClick) {
  orphanedContent.replaceChildren();

  if (!orphans || Object.keys(orphans).length === 0) {
    orphanedNotesSection.classList.add('collapsed');
    orphanedNotesSection.hidden = true;
    orphanedHeader.setAttribute('aria-expanded', 'false');
    orphanedCountSpan.textContent = '0';
    return;
  }

  orphanedNotesSection.hidden = false;
  orphanedCountSpan.textContent = String(Object.keys(orphans).length);

  Object.entries(orphans).forEach(([pageIdxStr, notesObj]) => {
    const pageNum = parseInt(pageIdxStr, 10) + 1;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'orphaned-item';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'orphaned-item-title';
    titleDiv.textContent = `Page ${pageNum} (Deleted Index)`;

    const snippetDiv = document.createElement('div');
    snippetDiv.className = 'orphaned-item-snippet';
    snippetDiv.textContent = (notesObj.markdown || '').substring(0, 80) || 'Empty notes';

    item.append(titleDiv, snippetDiv);
    item.addEventListener('click', () => {
      onRestoreClick(pageIdxStr, notesObj);
    });

    orphanedContent.appendChild(item);
  });
}
