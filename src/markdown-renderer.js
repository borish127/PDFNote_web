import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkHtml from 'remark-html';
import mermaid from 'mermaid';

// Initialize Mermaid with theme based on body theme
export function initMarkdownRenderer() {
  const isDark = document.body.classList.contains('dark-theme');
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'loose'
  });
}

// Update Mermaid theme on theme change
export function updateMermaidTheme(isDark) {
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'loose'
  });
}

// Compile markdown string to HTML and render embedded Mermaid diagrams
export async function renderMarkdown(markdownText, assetsRegistry = {}, container) {
  if (!markdownText) {
    container.innerHTML = '<div class="empty-state">No notes for this page yet. Click the edit button below to start writing.</div>';
    return;
  }

  try {
    // 1. Compile Markdown using unified/remark ecosystem
    const result = await unified()
      .use(remarkParse)
      .use(remarkHtml, { sanitize: false }) // Allow rendering divs/embedded HTML safely
      .process(markdownText);
    
    let htmlContent = String(result);

    // Set inside container
    container.innerHTML = htmlContent;

    // 2. Map image sources matching "assets/..." to local blob data URLs
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
      const src = img.getAttribute('src');
      if (src && src.startsWith('assets/')) {
        const assetName = src.replace('assets/', '');
        const dataURL = assetsRegistry[assetName];
        if (dataURL) {
          img.src = dataURL;
        } else {
          // If not found in memory, show broken asset style
          img.alt = `Asset not loaded: ${assetName}`;
        }
      }
    });

    // 3. Render Mermaid diagrams
    // Find all <pre><code> containing mermaid code blocks
    const codeBlocks = container.querySelectorAll('pre code.language-mermaid');
    
    for (let i = 0; i < codeBlocks.length; i++) {
      const codeBlock = codeBlocks[i];
      const preBlock = codeBlock.parentElement;
      const mermaidCode = codeBlock.textContent.trim();
      const uniqueId = `mermaid-chart-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      try {
        // Render Mermaid code to SVG vector string
        const { svg } = await mermaid.render(uniqueId, mermaidCode);
        
        // Replace pre block with mermaid SVG wrapper
        const svgDiv = document.createElement('div');
        svgDiv.className = 'mermaid-svg-container';
        svgDiv.innerHTML = svg;
        
        preBlock.replaceWith(svgDiv);
      } catch (err) {
        console.error('Mermaid render error on page:', err);
        
        // Show error container instead of crashing
        const errorDiv = document.createElement('div');
        errorDiv.style.border = '1px solid var(--md-sys-color-error)';
        errorDiv.style.backgroundColor = 'rgba(186, 26, 26, 0.08)';
        errorDiv.style.color = 'var(--md-sys-color-error)';
        errorDiv.style.padding = '12px';
        errorDiv.style.borderRadius = '8px';
        errorDiv.style.fontSize = '13px';
        errorDiv.style.marginTop = '8px';
        errorDiv.style.fontFamily = 'var(--font-family-code)';
        errorDiv.innerHTML = `<strong>Mermaid Syntax Error:</strong><br>${err.message || err}`;
        
        // Keep the original code for editing ease
        preBlock.appendChild(errorDiv);
        
        // Clear bad Mermaid elements generated in body bottom if any
        const badEl = document.getElementById(uniqueId);
        if (badEl) badEl.remove();
        const badBindEl = document.getElementById(`d${uniqueId}`);
        if (badBindEl) badBindEl.remove();
      }
    }
  } catch (error) {
    console.error('Markdown processing failed:', error);
    container.innerHTML = `<div class="empty-state">Markdown processing error: ${error.message}</div>`;
  }
}
