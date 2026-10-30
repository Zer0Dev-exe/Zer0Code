import { h, clear, icon, formatDuration, relativePath, basename } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { state, on, modelInfo, setPanel, emit, activeWorkspace } from '../store.js';
import { auth } from '../api.js';
import { buildReviewCard } from './reviews.js';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const TOOL_VIEW = {
  Read: ['file', 'Leyendo'], Write: ['pencil', 'Creando'], Edit: ['pencil', 'Editando'], MultiEdit: ['pencil', 'Editando'], NotebookEdit: ['pencil', 'Editando'],
  Bash: ['terminal', 'Ejecutando'], Grep: ['search', 'Buscando'], Glob: ['search', 'Buscando archivos'], LS: ['folder', 'Listando'],
  WebFetch: ['globe', 'Consultando'], WebSearch: ['globe', 'Buscando en la web'], Task: ['bot', 'Subagente'], Agent: ['bot', 'Subagente'], TodoWrite: ['list', 'Lista de tareas'],
  mcp__zer0code__create_project: ['folder-plus', 'Creando el proyecto']
};

function describeTool(t, workspace) {
  const i = t.input || {};
  const [ic, verb] = TOOL_VIEW[t.tool] || ['zap', t.tool];
  if (t.tool === 'mcp__zer0code__create_project') return { ic, verb, target: String(i.name || i.folder || '').slice(0, 140) };
  const file = i.file_path || i.notebook_path || i.path;
  const target = file ? relativePath(file, workspace) : (i.command || i.pattern || i.query || i.url || i.description || '');
  return { ic, verb, target: String(target).replace(/\s+/g, ' ').slice(0, 140) };
}

/** Archivos que el desarrollador ha tocado en este mensaje */
export function editedFiles(msg) {
  const files = new Set();
  for (const t of msg.tools || []) {
    if (!EDIT_TOOLS.has(t.tool) || t.status === 'error') continue;
    const raw = t.input?.file_path || t.input?.notebook_path;
    if (!raw) continue;
    for (const f of String(raw).split(', ')) files.add(relativePath(f, msg.workspace));
  }
  return [...files];
}

// Imágenes que Claude muestra con ![texto](ruta): el <img> no puede llevar el token, así que se descargan con sesión
const imageCache = new Map();
function loadImage(src, workspace) {
  const key = `${workspace}\n${src}`;
  if (!imageCache.has(key)) {
    imageCache.set(key, fetch(`/api/files/image?path=${encodeURIComponent(src)}&workspace=${encodeURIComponent(workspace || '')}`, { headers: { Authorization: `Bearer ${auth.token}` } })
      .then(res => res.ok ? res.blob() : Promise.reject(new Error('no disponible')))
      .then(blob => URL.createObjectURL(blob))
      .catch(err => { imageCache.delete(key); throw err; }));
  }
  return imageCache.get(key);
}

async function hydrateImage(img) {
  const src = img.dataset.src;
  if (!src || img.dataset.loaded) return;
  img.dataset.loaded = '1';
  img.classList.add('is-loading');
  try {
    const url = await loadImage(src, activeWorkspace());
    img.src = url;
    img.classList.remove('is-loading');
    img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  } catch {
    img.classList.remove('is-loading');
    img.classList.add('is-missing');
    img.alt = `${img.alt || 'Imagen'} (no disponible)`;
  }
}

export function createTimeline() {
  const scroll = h('div', { class: 'timeline-scroll' });
  const list = h('div', { class: 'timeline' });
  scroll.append(list);
  new MutationObserver(mutations => {
    for (const m of mutations) m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.matches?.('img[data-src]')) hydrateImage(n);
      else n.querySelectorAll?.('img[data-src]').forEach(hydrateImage);
    });
  }).observe(list, { childList: true, subtree: true });
  const workOpen = new Map(); // id del mensaje -> desplegado a mano
  const changedOpen = new Set();
  const mdCache = new Map(); // id -> { text, html }
  let stick = true;
  let pending = new Set();
  let raf = 0;
  let tick = 0;

  scroll.addEventListener('scroll', () => { stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90; });
  const toBottom = () => { if (stick) scroll.scrollTop = scroll.scrollHeight; };

  function md(msg) {
    const c = mdCache.get(msg.id);
    if (c && c.text === msg.text) return c.html;
    const html = renderMarkdown(msg.text || '');
    mdCache.set(msg.id, { text: msg.text, html });
    return html;
  }

  function workSection(msg) {
    const tools = (msg.tools || []).filter(t => !t.subagent);
    if (!tools.length && !msg.thinking) return null;
    const running = msg.status === 'running';
    const explicit = workOpen.get(msg.id);
    const open = explicit ?? false;
    const started = msg.timestamp || Date.now();
    const label = running ? 'Trabajando' : `Trabajó ${formatDuration(msg.duration || (tools.at(-1)?.time || started) - started)}`;
    const head = h('button', { class: `work-head${running ? ' work-live' : ''}`, type: 'button', onclick: () => {
      workOpen.set(msg.id, !open);
      update(msg);
    } }, label, icon('chevron-right'));
    const wrap = h('div', { class: `work${open ? ' open' : ''}` }, head);
    const shown = open ? tools : (running ? tools.slice(-1) : []);
    if (open && msg.thinking) wrap.append(h('div', { class: 'work-thinking' }, msg.thinking.trim()));
    if (shown.length) {
      wrap.append(h('div', { class: 'work-list' }, shown.map(t => {
        const d = describeTool(t, msg.workspace);
        return h('div', { class: `work-entry${t.status === 'error' ? ' error' : ''}` },
          t.status === 'running' ? icon('loader', 'spin') : t.status === 'error' ? icon('alert') : icon(d.ic),
          h('span', { class: 'verb' }, d.verb), d.target ? h('span', { class: 'target truncate' }, d.target) : null);
      })));
    }
    return wrap;
  }

  function changedCard(msg) {
    const files = editedFiles(msg);
    if (!files.length) return null;
    const stats = state.changes?.files ? files.reduce((acc, f) => {
      const hit = state.changes.files.find(x => x.path === f || x.path.endsWith('/' + f));
      if (hit) { acc.a += hit.additions; acc.d += hit.deletions; acc.known = true; }
      return acc;
    }, { a: 0, d: 0, known: false }) : { known: false };
    const open = changedOpen.has(msg.id);
    const card = h('div', { class: 'changed-card' },
      h('div', { class: 'changed-head' },
        h('button', { class: 'toggle', type: 'button', onclick: () => { open ? changedOpen.delete(msg.id) : changedOpen.add(msg.id); update(msg); } },
          icon('chevron-right'), h('span', null, `${files.length} ${files.length === 1 ? 'archivo cambiado' : 'archivos cambiados'}`),
          stats.known ? [h('span', { class: 'stat-add tabular' }, `+${stats.a}`), h('span', { class: 'stat-del tabular' }, `−${stats.d}`)] : null,
          h('span', { class: 'muted' }, open ? 'Ocultar archivos' : 'Mostrar archivos')),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn-sm', type: 'button', onclick: () => { setPanel({ open: true, tab: 'changes' }); emit('diff:focus', files[0]); } }, icon('file-diff'), 'Abrir diff')));
    if (open) card.append(h('div', { class: 'changed-files' }, files.map(f => h('button', { type: 'button', onclick: () => { setPanel({ open: true, tab: 'changes' }); emit('diff:focus', f); } }, icon('file'), f))));
    return card;
  }

  function buildNode(msg) {
    if (msg.role === 'user') {
      if (msg.kind === 'autofix') return h('div', { class: 'autofix-note', dataset: { id: msg.id } }, icon('orch'), msg.text);
      const atts = (msg.attachments || []).map(n => h('span', { class: 'chip' }, icon('paperclip'), n));
      return h('div', { class: 'msg-user', dataset: { id: msg.id } },
        atts.length ? h('div', { class: 'atts' }, atts) : null, msg.text ? h('div', { class: 'bubble' }, msg.text) : null);
    }
    if (msg.role !== 'assistant') return h('div');

    const node = h('div', { class: 'msg-assistant', dataset: { id: msg.id } });
    const work = workSection(msg);
    if (work) node.append(work);
    const text = (msg.text || '').trim();
    if (text) node.append(h('div', { class: 'md', html: md(msg) }));
    else if (msg.status === 'running' && !work) node.append(h('div', { class: 'work-head work-live' }, 'Pensando'));
    if (msg.status === 'error' && msg.error) node.append(h('div', { class: 'error-line' }, icon('alert'), msg.error));
    if (msg.status === 'canceled') node.append(h('div', { class: 'cost' }, 'Tarea cancelada'));
    const card = changedCard(msg);
    if (card) node.append(card);
    for (const r of msg.reviews || []) {
      node.append(buildReviewCard(r, { devName: modelInfo(msg.model).name.replace(/^Claude\s+/, '') }));
    }
    return node;
  }

  function renderAll() {
    clear(list);
    for (const m of state.messages) list.append(buildNode(m));
    stick = true;
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  function update(msg) {
    pending.add(msg.id);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ids = pending; pending = new Set();
      for (const id of ids) {
        const msg2 = state.messages.find(m => m.id === id);
        const old = list.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!msg2) continue;
        const node = buildNode(msg2);
        // Las tarjetas de revisión ya abiertas por el usuario conservan su estado
        if (old) {
          old.querySelectorAll('.review').forEach(oldCard => {
            const fresh = node.querySelector(`.review[data-id="${CSS.escape(oldCard.dataset.id)}"]`);
            if (fresh && oldCard.dataset.touched === '1') { fresh.dataset.touched = '1'; fresh.classList.toggle('open', oldCard.classList.contains('open')); fresh.querySelector('.review-body').hidden = !oldCard.classList.contains('open'); }
          });
          old.replaceWith(node);
        } else list.append(node);
      }
      toBottom();
    });
  }

  on('messages', renderAll);
  on('msg', update);
  on('changes', () => { for (const m of state.messages) if (m.role === 'assistant' && editedFiles(m).length) update(m); });
  // El reloj de «Trabajando…» no necesita repintar: el texto cambia solo al llegar eventos
  setInterval(() => { tick++; const live = state.messages.at(-1); if (state.running && live?.status === 'running') update(live); }, 15000);
  return scroll;
}
