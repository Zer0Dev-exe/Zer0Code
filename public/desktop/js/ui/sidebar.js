import { h, clear, icon, monogram, providerMark, timeAgo, basename, showPopover, closePopover, menuItem } from '../dom.js';
import { state, on, setUi, newThread, openSession, deleteSession, togglePin, sessionStatus, projectList, loadSessions, updateActions, logout } from '../store.js';
import { skySvg } from './sky.js';
import { openPalette, openSettings, openOrchestrator, openUsage, openFolderPicker, openDisplayName } from './dialogs.js';
import { openWhatsNew } from './whatsnew.js';

const DAY = 24 * 60 * 60 * 1000;

export function mountSidebar(root) {
  const render = () => {
    clear(root);
    root.append(...[head(), top(), list(), updatePill(), foot()].filter(Boolean));
  };
  for (const ev of ['sessions', 'thread', 'git', 'conn', 'perms', 'running', 'orch', 'update', 'profile']) on(ev, render);
  on('ui', () => { /* el filtro y la sección «resueltos» cambian la lista */ render(); });
  setInterval(() => { if (!document.hidden) render(); }, 60000);
  render();
}

function head() {
  const stage = h('div', { class: 'sidebar-stage', html: skySvg() });
  return h('div', { class: 'sidebar-head' },
    stage,
    h('div', { class: 'sidebar-brand drag' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Ocultar barra lateral (Ctrl B)', onclick: () => setUi({ sidebar: false }) }, icon('panel-left')),
      h('img', { class: 'logo', src: '../icon.svg', alt: '' }),
      h('span', { class: 'name' }, h('b', null, 'Zer0'), 'Code')));
}

function top() {
  const filtered = state.ui.filter !== 'all';
  const filterBtn = h('button', { class: `icon-btn sidebar-icon-btn${filtered ? ' active' : ''}`, type: 'button', title: filtered ? `Proyecto: ${basename(state.ui.filter)}` : 'Filtrar por proyecto',
    onclick: () => openFilterMenu(filterBtn) }, icon('filter'), filtered ? h('span', { class: 'filter-dot' }) : null);
  return h('div', { class: 'sidebar-top' },
    h('div', { class: 'search-row' },
      h('button', { class: 'sidebar-btn', type: 'button', onclick: openPalette }, icon('search'), 'Buscar'),
      filterBtn,
      h('button', { class: 'icon-btn sidebar-icon-btn', type: 'button', title: 'Añadir proyecto', onclick: () => openFolderPicker() }, icon('folder-plus')),
      h('button', { class: 'icon-btn sidebar-icon-btn', type: 'button', title: 'Nuevo hilo (Ctrl N)', onclick: () => newThread() }, icon('square-pen'))));
}

function openFilterMenu(anchor) {
  const box = h('div', null,
    menuItem({ label: 'Todos los proyectos', icon: 'folder', selected: state.ui.filter === 'all', onClick: () => { setUi({ filter: 'all' }); closePopover(); } }),
    h('div', { class: 'menu-sep' }),
    projectList().map(p => menuItem({
      label: p.name, hint: p.dir.length > 28 ? '…' + p.dir.slice(-26) : p.dir, selected: state.ui.filter === p.dir,
      onClick: () => { setUi({ filter: p.dir }); closePopover(); }
    })));
  showPopover(anchor, box, { className: 'wide' });
}

function rowStatus(id) {
  const s = sessionStatus(id);
  if (!s) return null;
  const map = { running: ['loader', 'status-running', 'Trabajando'], reviewing: ['orch', 'status-reviewing', 'Revisando'], pending: ['shield', 'status-pending', 'Espera tu permiso'], unread: ['circle-check', 'status-unread', 'Terminado'] };
  const [ic, cls, title] = map[s];
  return h('span', { class: `status-ic ${cls}`, title }, icon(ic));
}

function threadRow(sess, { compact = false } = {}) {
  const proj = basename(sess.workspace) || 'Sin proyecto';
  const active = sess.id === state.activeId;
  const pinned = state.pins.has(sess.id);
  const git = state.gitSummary[sess.workspace];
  const click = () => openSession(sess.id);
  const menu = (e) => {
    e.preventDefault();
    const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }), contains: () => false };
    showPopover(anchor, h('div', null,
      menuItem({ label: pinned ? 'Desfijar' : 'Fijar arriba', icon: 'pin', onClick: () => { togglePin(sess.id); closePopover(); } }),
      menuItem({ label: 'Eliminar conversación', icon: 'trash', danger: true, onClick: async () => { closePopover(); if (confirm(`¿Eliminar «${sess.title}»?`)) deleteSession(sess.id); } })));
  };

  if (compact) {
    return h('button', { class: `thread-row compact${active ? ' active' : ''}`, type: 'button', onclick: click, oncontextmenu: menu },
      h('span', { class: 'thread-title truncate' }, sess.title), h('span', { class: 'when' }, timeAgo(sess.updatedAt)));
  }

  return h('div', { class: `thread-row${active ? ' active' : ''}`, role: 'button', tabindex: 0, onclick: click, oncontextmenu: menu,
    onkeydown: (e) => { if (e.key === 'Enter') click(); } },
    h('div', { class: 'thread-l1' },
      monogram(proj), h('span', { class: 'proj truncate' }, proj), h('span', { class: 'spacer' }),
      h('button', { class: `icon-btn pin-btn${pinned ? ' on' : ''}`, type: 'button', title: pinned ? 'Desfijar' : 'Fijar', style: { width: '20px', height: '20px' },
        onclick: (e) => { e.stopPropagation(); togglePin(sess.id); } }, icon('pin')),
      rowStatus(sess.id), h('span', { class: 'tabular' }, timeAgo(sess.updatedAt))),
    h('div', { class: 'thread-title truncate' }, sess.title),
    h('div', { class: 'thread-l3' },
      git?.isRepo ? [icon('git-branch'), h('span', { class: 'truncate' }, git.branch)] : h('span', { class: 'truncate' }, sess.workspace || ''),
      h('span', { class: 'spacer' }),
      active && git?.isRepo && (git.additions || git.deletions) ? [h('span', { class: 'stat-add tabular' }, `+${git.additions}`), h('span', { class: 'stat-del tabular' }, `−${git.deletions}`)] : null,
      sess.lastProvider ? providerMark(sess.lastProvider, 'row-provider') : null));
}

function list() {
  const now = Date.now();
  let items = state.sessions.filter(s => state.ui.filter === 'all' || s.workspace === state.ui.filter);
  const settled = (s) => !state.pins.has(s.id) && s.id !== state.activeId && !sessionStatus(s.id) && now - s.updatedAt > DAY;
  const main = items.filter(s => !settled(s)).sort((a, b) => (state.pins.has(b.id) - state.pins.has(a.id)) || b.updatedAt - a.updatedAt);
  const done = items.filter(settled).sort((a, b) => b.updatedAt - a.updatedAt);

  const box = h('div', { class: 'thread-scroll' });
  if (!items.length) {
    box.append(h('div', { class: 'empty-list' }, state.sessions.length ? 'Ninguna conversación en este proyecto' : 'Aún no hay conversaciones.\nEmpieza un hilo nuevo.'));
    return box;
  }
  main.forEach(s => box.append(threadRow(s)));
  if (done.length) {
    box.append(h('button', { class: `settled-head${state.ui.settledOpen ? ' open' : ''}`, type: 'button', onclick: () => setUi({ settledOpen: !state.ui.settledOpen }) },
      `Resueltos (${done.length})`, h('span', { class: 'line' }), icon('chevron-down')));
    if (state.ui.settledOpen) done.slice(0, 80).forEach(s => box.append(threadRow(s, { compact: true })));
  }
  return box;
}

// Aviso de actualización (como la pastilla de T3 Code): hay una versión nueva, descargando, lista
function updatePill() {
  const u = state.update;
  if (!u || !['available', 'downloading', 'ready', 'opened', 'error'].includes(u.status) || (u.status === 'error' && !u.latest)) return null;
  const v = u.latest?.version;
  if (u.status === 'downloading') {
    return h('div', { class: 'update-pill busy' }, icon('loader', 'spin'), h('span', { class: 'grow' }, `Descargando ${v ? `v${v}` : 'la actualización'} · ${u.progress}%`),
      h('span', { class: 'update-bar' }, h('i', { style: { width: `${u.progress}%` } })));
  }
  if (u.status === 'ready') return h('div', { class: 'update-pill busy' }, icon('loader', 'spin'), h('span', { class: 'grow' }, 'Instalando… la app se reiniciará'));
  if (u.status === 'opened') return h('div', { class: 'update-pill' }, icon('circle-check'), h('span', { class: 'grow' }, 'Instalador abierto: sigue los pasos para terminar'));
  if (u.status === 'error') return h('div', { class: 'update-pill err' }, icon('alert'), h('span', { class: 'grow' }, u.error), h('button', { class: 'btn-sm', type: 'button', onclick: updateActions.install }, 'Reintentar'));
  return h('div', { class: 'update-pill' },
    h('button', { class: 'update-main', type: 'button', onclick: updateActions.install, title: u.latest.inPlace ? 'Descargar e instalar' : 'Descargar el instalador' },
      icon('arrow-up'), h('span', { class: 'grow truncate' }, `Actualizar a v${v}`)),
    h('button', { class: 'icon-btn', type: 'button', title: 'Ver las novedades', onclick: () => openWhatsNew() }, icon('list')),
    h('button', { class: 'icon-btn', type: 'button', title: 'Omitir esta versión', onclick: () => updateActions.skip(v) }, icon('x')));
}

// Pie de la barra lateral: la tarjeta de perfil (avatar con el estado de la conexión, nombre y versión) abre
// el menú de la cuenta; a la derecha, los accesos rápidos.
const CONN = { open: ['ok', 'Conectado'], connecting: ['wait', 'Conectando…'], closed: ['bad', 'Sin conexión'], unauthorized: ['bad', 'Sesión cerrada'] };

function avatarFor(name) {
  const url = state.profile?.avatarUrl;
  const fallback = () => monogram(name || '?', 'profile-mono');
  if (!url) return fallback();
  const img = h('img', { class: 'profile-avatar', src: url, alt: '', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

function openAccountMenu(anchor) {
  const u = state.update;
  const fresh = u?.status === 'available' && u.latest;
  showPopover(anchor, h('div', null,
    h('div', { class: 'acct-menu-head' },
      h('b', null, state.profile?.displayName || state.user?.username || ''),
      h('span', null, `@${state.user?.username || ''}${state.user?.role === 'admin' ? ' · administrador' : ''}`)),
    h('div', { class: 'menu-sep' }),
    menuItem({ label: 'Cambiar nombre visible', icon: 'pencil', onClick: () => { closePopover(); openDisplayName(); } }),
    menuItem({ label: 'Ajustes', icon: 'settings', onClick: () => { closePopover(); openSettings(); } }),
    u?.current ? menuItem({ label: fresh ? `Novedades · v${u.latest.version} disponible` : 'Novedades', icon: 'zap', onClick: () => { closePopover(); openWhatsNew(); } }) : null,
    h('div', { class: 'menu-sep' }),
    menuItem({ label: 'Cerrar sesión', icon: 'log-out', danger: true, onClick: async () => { closePopover(); await logout(); } })),
  { side: 'top', className: 'wide' });
}

function foot() {
  const [connCls, connText] = CONN[state.conn] || ['wait', ''];
  const name = state.profile?.displayName || state.user?.username || '';
  const u = state.update;
  const fresh = u?.status === 'available' && u.latest;
  const sub = h('span', { class: 'profile-sub' },
    connCls === 'ok' ? null : h('span', { class: `profile-conn ${connCls}` }, connText),
    connCls === 'ok' && u?.current ? `Zer0Code v${u.current}` : null,
    connCls === 'ok' && !u?.current ? connText : null,
    fresh ? h('span', { class: 'profile-new' }, ' · nueva versión') : null);
  const card = h('button', { class: 'profile-card', type: 'button', title: name, onclick: () => openAccountMenu(card) },
    h('span', { class: 'profile-pic' }, avatarFor(name), h('span', { class: `presence ${connCls}`, title: connText })),
    h('span', { class: 'profile-text' }, h('span', { class: 'profile-name truncate' }, name), sub),
    icon('chevron-up', 'profile-chev'));
  return h('div', { class: 'sidebar-foot' },
    card,
    h('div', { class: 'foot-actions' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Orquestador de agentes', onclick: openOrchestrator }, icon('orch')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Uso y gasto', onclick: openUsage }, icon('chart')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Ajustes', onclick: openSettings }, icon('settings'))));
}
