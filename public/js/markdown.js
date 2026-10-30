// Markdown de las respuestas -> HTML seguro. Lo que escribe el modelo puede venir de páginas o archivos
// que ha leído (inyección de instrucciones): sin limpiar, un <img onerror> o un <script> se ejecutaría
// aquí con la sesión del usuario. Sin DOMPurify no se pinta HTML: se muestra el texto tal cual.
export function renderMarkdown(text) {
  const source = String(text ?? '');
  if (!window.marked || !window.DOMPurify) return escapeHtml(source);
  return DOMPurify.sanitize(marked.parse(source), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  });
}

export function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

