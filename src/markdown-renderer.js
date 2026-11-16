import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkHtml from 'remark-html';

let mermaidModulePromise = null;
let domPurifyPromise = null;
let currentIsDark = false;
const containerGenerations = new WeakMap();

const ALLOWED_MD_ELEMENTS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'strong', 'em', 'b', 'i', 'u', 's', 'del', 'mark', 'sub', 'sup',
  'a', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'div', 'span', 'details', 'summary'
];

const ALLOWED_MD_ATTRIBUTES = [
  'href', 'title', 'src', 'alt', 'class', 'id',
  'colspan', 'rowspan', 'align', 'open', 'type', 'start'
];

function loadDomPurify() {
  domPurifyPromise ??= import('dompurify').then((mod) => mod.default ?? mod);
  return domPurifyPromise;
}

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((mod) => {
      const mermaid = mod.default ?? mod;
      mermaid.initialize({
        startOnLoad: false,
        theme: currentIsDark ? 'dark' : 'default',
        securityLevel: 'strict'
      });
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

async function safeSetMarkdownHTML(el, html) {
  if ('setHTML' in Element.prototype) {
    el.setHTML(html, {
      sanitizer: {
        elements: ALLOWED_MD_ELEMENTS,
        attributes: ALLOWED_MD_ATTRIBUTES
      }
    });
    return;
  }

  const DOMPurify = await loadDomPurify();
  el.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_MD_ELEMENTS, '#text'],
    ALLOWED_ATTR: ALLOWED_MD_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false
  });
}

function isSafeExternalUrl(rawUrl) {
  if (!rawUrl) return false;
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('assets/')) return true;
  try {
    const parsed = new URL(trimmed, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function sanitizeSvgToNode(svgText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.documentElement;
  if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    return null;
  }

  const forbiddenTags = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);
  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (forbiddenTags.has(tag)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || ((name === 'href' || name === 'xlink:href' || name === 'src') && val.startsWith('javascript:'))) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(svgEl);

  return document.importNode(svgEl, true);
}

// Initialize theme state for Mermaid (Mermaid itself is lazy-loaded on demand)
export function initMarkdownRenderer() {
  const schemeMeta = document.querySelector('meta[name="color-scheme"]')?.content;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  currentIsDark = schemeMeta === 'dark' || (schemeMeta !== 'light' && prefersDark) || document.body.classList.contains('dark-theme');
}

// Update Mermaid theme on theme change
export async function updateMermaidTheme(isDark) {
  currentIsDark = isDark;
  if (!mermaidModulePromise) return;
  try {
    const mermaid = await mermaidModulePromise;
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'strict'
    });
  } catch (err) {
    console.error('Failed updating Mermaid theme:', err);
  }
}

function createEmptyState(message) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = message;
  return div;
}

// Compile markdown string to sanitized HTML and render embedded Mermaid diagrams
export async function renderMarkdown(markdownText, assetsRegistry = {}, container) {
  const gen = (containerGenerations.get(container) ?? 0) + 1;
  containerGenerations.set(container, gen);

  if (!markdownText || !markdownText.trim()) {
    container.replaceChildren(
      createEmptyState('No notes for this page yet. Click the edit button below to start writing.')
    );
    return;
  }

  try {
    // 1. Compile Markdown using unified/remark, then sanitize before DOM insertion
    const result = await unified()
      .use(remarkParse)
      .use(remarkHtml, { sanitize: false })
      .process(markdownText);

    if (containerGenerations.get(container) !== gen) return;

    await safeSetMarkdownHTML(container, String(result));

    if (containerGenerations.get(container) !== gen) return;

    // 2. Harden links and map image sources matching "assets/..." to local data URLs
    const links = container.querySelectorAll('a');
    links.forEach((a) => {
      const href = a.getAttribute('href');
      if (!isSafeExternalUrl(href)) {
        a.removeAttribute('href');
      } else if (!href.startsWith('#')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    });

    const imgs = container.querySelectorAll('img');
    imgs.forEach((img) => {
      const src = img.getAttribute('src');
      if (src && src.startsWith('assets/')) {
        const assetName = src.slice('assets/'.length);
        const dataURL = assetsRegistry[assetName];
        if (dataURL && typeof dataURL === 'string' && dataURL.startsWith('data:image/')) {
          img.src = dataURL;
        } else {
          img.removeAttribute('src');
          img.alt = `Asset not loaded: ${assetName}`;
        }
      } else if (src && !isSafeExternalUrl(src) && !src.startsWith('data:image/')) {
        img.removeAttribute('src');
      }
    });

    // Make scrollable code blocks keyboard-reachable per HTML accessibility guidelines
    const preBlocks = container.querySelectorAll('pre');
    preBlocks.forEach((pre) => {
      if (!pre.querySelector('code.language-mermaid')) {
        pre.setAttribute('tabindex', '0');
      }
    });

    // 3. Render Mermaid diagrams lazily
    const codeBlocks = container.querySelectorAll('pre code.language-mermaid');
    if (codeBlocks.length === 0) return;

    const mermaid = await loadMermaid();
    if (containerGenerations.get(container) !== gen) return;

    for (let i = 0; i < codeBlocks.length; i++) {
      if (containerGenerations.get(container) !== gen) return;

      const codeBlock = codeBlocks[i];
      const preBlock = codeBlock.parentElement;
      const mermaidCode = codeBlock.textContent.trim();
      const uniqueId = `mermaid-chart-${Date.now()}-${i}-${Math.floor(Math.random() * 1000)}`;

      try {
        const { svg } = await mermaid.render(uniqueId, mermaidCode);
        if (containerGenerations.get(container) !== gen) return;

        const svgNode = sanitizeSvgToNode(svg);
        if (svgNode) {
          const svgDiv = document.createElement('div');
          svgDiv.className = 'mermaid-svg-container';
          svgDiv.setAttribute('tabindex', '0');
          svgDiv.setAttribute('role', 'button');
          svgDiv.setAttribute('aria-label', 'Expand Mermaid diagram');
          svgDiv.appendChild(svgNode);
          preBlock.replaceWith(svgDiv);
        }
      } catch (err) {
        console.error('Mermaid render error on page:', err);

        const errorDiv = document.createElement('div');
        errorDiv.className = 'mermaid-error-box';

        const titleEl = document.createElement('strong');
        titleEl.textContent = 'Mermaid Syntax Error:';
        const msgEl = document.createElement('div');
        msgEl.textContent = err?.message || String(err);

        errorDiv.append(titleEl, msgEl);
        preBlock.appendChild(errorDiv);

        document.getElementById(uniqueId)?.remove();
        document.getElementById(`d${uniqueId}`)?.remove();
      }
    }
  } catch (error) {
    if (containerGenerations.get(container) !== gen) return;
    console.error('Markdown processing failed:', error);
    container.replaceChildren(
      createEmptyState(`Markdown processing error: ${error?.message || String(error)}`)
    );
  }
}
