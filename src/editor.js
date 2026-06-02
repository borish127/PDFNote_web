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

  // Initialize CodeMirror 6
  const startState = EditorState.create({
    doc: '',
    extensions: [
      basicSetup,
      markdown(),
      syntaxHighlighting(markdownHighlightStyle),
      EditorView.theme({
        "&": { height: "100%", fontSize: "14px" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { fontFamily: "var(--font-family-code)" }
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onTextChangeCallback) {
          onTextChangeCallback(update.state.doc.toString());
        }
      })
    ]
  });

  editorView = new EditorView({
    state: startState,
    parent: editorContainer
  });

  // Setup FAB Toggle Mode
  fabToggleMode.addEventListener('click', toggleMode);

  // Setup Sidebar Collapses
  btnCollapseRight.addEventListener('click', () => {
    rightPanel.classList.add('collapsed');
    btnExpandRight.classList.remove('hidden');
  });

  btnExpandRight.addEventListener('click', () => {
    rightPanel.classList.remove('collapsed');
    btnExpandRight.classList.add('hidden');
  });

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
  });

  // Drag-and-drop / Paste handler for editorContainer
  editorContainer.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') === 0) {
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
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.indexOf('image') === 0) {
      await handleImageFile(files[0]);
    }
  });

  // Accordion Toggle for Orphaned Notes
  orphanedHeader.addEventListener('click', () => {
    orphanedNotesSection.classList.toggle('collapsed');
  });
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
    editorContainer.classList.add('active');
    fabIcon.textContent = 'visibility';
    fabToggleMode.title = 'Switch to Read Mode';
    // Focus Editor
    setTimeout(() => editorView.focus(), 150);
  } else {
    editorContainer.classList.remove('active');
    previewContainer.classList.add('active');
    fabIcon.textContent = 'edit';
    fabToggleMode.title = 'Switch to Edit Mode';
  }
}

function toggleMode() {
  if (currentMode === 'read') {
    setMode('edit');
  } else {
    setMode('read');
  }
}

// Get and Set Editor Markdown Content
export function getEditorContent() {
  return editorView.state.doc.toString();
}

export function setEditorContent(text) {
  if (!editorView) return;
  
  // Dispatch a transaction to replace document contents
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: text || '' }
  });
}

// --- ACCELERATOR BUTTON ACTIONS ---

// Insert Markdown link
function insertLink() {
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

// Trigger browser hidden file selector for image paste
function triggerImageUpload() {
  document.getElementById('input-image-file').click();
}

// Insert Mermaid flowchart block template
function insertMermaidTemplate() {
  const state = editorView.state;
  const selection = state.selection.main;
  const template = `\n\`\`\`mermaid\ngraph TD\n    A[Start] --> B[Process]\n    B --> C[End]\n\`\`\`\n`;

  editorView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: template },
    selection: { anchor: selection.from + template.length }
  });
  editorView.focus();
}

// --- ASSET / IMAGE UPLOAD AND sequential NAMING ---

async function handleImageFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataURL = e.target.result;
    
    // Determine sequential image index name: img_p{page}_{index}.png
    if (pageAssetsCounter[activePageIdx] === undefined) {
      pageAssetsCounter[activePageIdx] = 0;
    }
    
    const index = pageAssetsCounter[activePageIdx]++;
    const imgName = `img_p${activePageIdx}_${index}.png`;

    // Save image to asset registry
    if (onImagePasteCallback) {
      onImagePasteCallback(imgName, dataURL);
    }

    // Insert Markdown asset link at cursor
    const state = editorView.state;
    const selection = state.selection.main;
    const imgMarkdown = `![User Asset](assets/${imgName})`;

    editorView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: imgMarkdown },
      selection: { anchor: selection.from + imgMarkdown.length }
    });
    
    editorView.focus();
  };

  reader.readAsDataURL(file);
}

// Set assets counter state (used when loading a workspace to reset counters)
export function resetAssetsCounters(workspaceData) {
  pageAssetsCounter = {};
  
  // Scan all page markdowns and assets to find highest image indices
  if (workspaceData && workspaceData.pages) {
    Object.entries(workspaceData.pages).forEach(([pageStr, pageObj]) => {
      const pIdx = parseInt(pageStr);
      let maxIdx = -1;
      
      // Parse markdown to match assets/img_p{page}_{index}.png
      const regex = new RegExp(`assets/img_p${pIdx}_(\\d+)\\.png`, 'g');
      const text = pageObj.markdown || '';
      let match;
      
      while ((match = regex.exec(text)) !== null) {
        const val = parseInt(match[1]);
        if (val > maxIdx) maxIdx = val;
      }
      
      // Also check explicitly listed assets
      if (pageObj.assets) {
        pageObj.assets.forEach(assetName => {
          const matchAsset = new RegExp(`img_p${pIdx}_(\\d+)\\.png`).exec(assetName);
          if (matchAsset) {
            const val = parseInt(matchAsset[1]);
            if (val > maxIdx) maxIdx = val;
          }
        });
      }

      pageAssetsCounter[pIdx] = maxIdx + 1;
    });
  }
}

// --- ORPHANED NOTES ACCORDION ---

// Display notes belonging to page indices no longer in the PDF
export function renderOrphanedNotes(orphans, onRestoreClick) {
  orphanedContent.innerHTML = '';
  
  if (!orphans || Object.keys(orphans).length === 0) {
    orphanedNotesSection.classList.add('collapsed');
    orphanedNotesSection.style.display = 'none';
    orphanedCountSpan.textContent = '0';
    return;
  }

  orphanedNotesSection.style.display = 'flex';
  orphanedCountSpan.textContent = Object.keys(orphans).length;

  Object.entries(orphans).forEach(([pageIdxStr, notesObj]) => {
    const pageNum = parseInt(pageIdxStr) + 1;
    const item = document.createElement('div');
    item.className = 'orphaned-item';
    
    item.innerHTML = `
      <div class="orphaned-item-title">Page ${pageNum} (Deleted Index)</div>
      <div style="font-size: 11px; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
        ${notesObj.markdown.substring(0, 50) || 'Empty notes'}
      </div>
    `;

    item.addEventListener('click', () => {
      onRestoreClick(pageIdxStr, notesObj);
    });

    orphanedContent.appendChild(item);
  });
}
