import { h, clear, icon, providerMark, showPopover, closePopover, toast } from '../dom.js';
import { state, currentModelId, setPref, effortLevelsFor, modelInfo, providerReady, toolFor } from '../store.js';

// Selector de modelo como el de T3 Code: una barra a la izquierda con favoritos y proveedores, buscador,
// y cada modelo con su proveedor debajo. Los favoritos se eligen con la estrella y se abren con Ctrl 1…9.

const PROVIDERS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' }
];
const EFFORT_LABEL = { auto: 'Auto', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };
const FAV_KEY = 'z0d_favModels';
const TAB_KEY = 'z0d_modelTab';
const isMac = /mac/i.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

const providerOf = (m) => m.provider || 'claude';
const connected = (provider) => providerReady(provider);
// Por qué no se puede usar: falta instalar la herramienta o vincular la cuenta
const blocker = (provider) => (toolFor(provider) && !toolFor(provider).installed ? 'sin instalar' : 'sin conectar');

export function favorites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAV_KEY));
    if (Array.isArray(list)) return list.filter(id => state.models.some(m => m.id === id));
  } catch {
    // sin favoritos guardados
  }
  return [];
}

function setFavorites(list) {
  localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 20)));
}

function toggleFavorite(id) {
  const list = favorites();
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else list.push(id);
  setFavorites(list);
}

/** Elegir un modelo (comprueba que su proveedor está conectado) */
function choose(m) {
  if (!connected(providerOf(m))) {
    const label = PROVIDERS.find(p => p.id === providerOf(m))?.label || providerOf(m);
    toast(blocker(providerOf(m)) === 'sin instalar' ? `Instala ${label} en Ajustes para usar ${m.name}` : `Conecta ${label} en Ajustes para usar ${m.name}`, 'error');
    return false;
  }
  setPref('model', m.id);
  return true;
}

/** Ctrl 1…9 en cualquier parte: el favorito de esa posición */
let shortcutsInstalled = false;
export function installModelShortcuts() {
  if (shortcutsInstalled) return;
  shortcutsInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return;
    const id = favorites()[Number(e.key) - 1];
    const m = id && state.models.find(x => x.id === id);
    if (!m) return;
    e.preventDefault();
    if (choose(m)) {
      closePopover();
      toast(`Modelo: ${m.name}`);
    }
  });
}

export function openModelPicker(anchor) {
  const favs = favorites();
  const current = currentModelId();
  const providers = PROVIDERS.filter(p => state.models.some(m => providerOf(m) === p.id));
  let tab = localStorage.getItem(TAB_KEY) || (favs.length ? 'fav' : providerOf(modelInfo(current)));
  if (tab !== 'fav' && !providers.some(p => p.id === tab)) tab = 'fav';
  let active = -1; // fila resaltada con el teclado
  let pop = null;

  const rail = h('div', { class: 'mp-rail' });
  const search = h('input', { class: 'mp-search-input', type: 'text', placeholder: 'Buscar modelos…', 'aria-label': 'Buscar modelos' });
  const list = h('div', { class: 'mp-list', role: 'listbox' });
  const foot = h('div', { class: 'mp-foot' });

  const visible = () => {
    const q = search.value.trim().toLowerCase();
    const fav = favorites();
    let models;
    if (q) models = state.models.filter(m => (m.name + ' ' + m.id + ' ' + providerOf(m)).toLowerCase().includes(q));
    else if (tab === 'fav') models = fav.map(id => state.models.find(m => m.id === id)).filter(Boolean);
    else models = state.models.filter(m => providerOf(m) === tab);
    return { models, fav };
  };

  const drawRail = () => {
    clear(rail);
    const btn = (id, title, content) => h('button', {
      class: `mp-tab${tab === id && !search.value.trim() ? ' on' : ''}`, type: 'button', title,
      onclick: () => { tab = id; localStorage.setItem(TAB_KEY, id); search.value = ''; active = -1; draw(); search.focus(); }
    }, content);
    rail.append(btn('fav', 'Favoritos', icon('star', 'mp-star-tab')));
    for (const p of providers) {
      rail.append(btn(p.id, connected(p.id) ? p.label : `${p.label} · ${blocker(p.id)}`, providerMark(p.id)));
    }
  };

  const drawList = () => {
    clear(list);
    const { models, fav } = visible();
    const cur = currentModelId();
    if (!models.length) {
      list.append(h('div', { class: 'mp-empty' }, search.value.trim()
        ? 'Ningún modelo coincide'
        : tab === 'fav' ? `Marca modelos con la estrella para tenerlos aquí y elegirlos con ${MOD}1…9` : 'No hay modelos'));
      return;
    }
    if (active >= models.length) active = models.length - 1;
    models.forEach((m, i) => {
      const provider = providerOf(m);
      const on = connected(provider);
      const favIndex = fav.indexOf(m.id);
      const star = h('button', { class: `mp-star${favIndex >= 0 ? ' on' : ''}`, type: 'button', title: favIndex >= 0 ? 'Quitar de favoritos' : 'Añadir a favoritos',
        onclick: (e) => { e.stopPropagation(); toggleFavorite(m.id); draw(); } }, icon('star'));
      const row = h('div', {
        class: `mp-row${m.id === cur ? ' selected' : ''}${i === active ? ' active' : ''}${on ? '' : ' off'}`, role: 'option', 'aria-selected': m.id === cur ? 'true' : 'false',
        onclick: () => { if (choose(m)) closePopover(); },
        onmousemove: () => { if (active !== i) { active = i; markActive(); } }
      },
        h('div', { class: 'mp-text' },
          h('span', { class: 'mp-name' }, m.name),
          h('span', { class: 'mp-sub' }, providerMark(provider), PROVIDERS.find(p => p.id === provider)?.label || provider,
            on ? null : h('span', { class: 'mp-warn' }, `· ${blocker(provider)}`),
            m.tag && provider === 'claude' ? h('span', { class: 'mp-tag' }, m.tag) : null)),
        favIndex >= 0 && favIndex < 9 ? h('kbd', { class: 'mp-kbd' }, `${MOD}${favIndex + 1}`) : null,
        star,
        m.id === cur ? icon('check', 'mp-check') : h('span', { class: 'mp-check-gap' }));
      list.append(row);
    });
  };

  const markActive = () => {
    [...list.querySelectorAll('.mp-row')].forEach((r, i) => r.classList.toggle('active', i === active));
    list.querySelectorAll('.mp-row')[active]?.scrollIntoView({ block: 'nearest' });
  };

  const drawFoot = () => {
    clear(foot);
    const levels = effortLevelsFor(currentModelId());
    if (!levels.length) { foot.hidden = true; return; }
    foot.hidden = false;
    const chosen = levels.includes(state.prefs.effort) ? state.prefs.effort : 'auto';
    foot.append(h('span', { class: 'mp-foot-label' }, 'Esfuerzo'),
      h('div', { class: 'mp-effort' }, ['auto', ...levels].map(l => h('button', { class: l === chosen ? 'on' : '', type: 'button',
        onclick: () => { setPref('effort', l); drawFoot(); } }, EFFORT_LABEL[l] || l))));
  };

  function draw() { drawRail(); drawList(); drawFoot(); pop?.place(); }

  search.addEventListener('input', () => { active = search.value.trim() ? 0 : -1; drawRail(); drawList(); });
  search.addEventListener('keydown', (e) => {
    const rows = visible().models;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(rows.length - 1, active + 1); markActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); markActive(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const m = rows[active >= 0 ? active : 0];
      if (m && choose(m)) closePopover();
    }
  });

  const panel = h('div', { class: 'mp' }, rail,
    h('div', { class: 'mp-main' }, h('label', { class: 'mp-search' }, icon('search'), search), list, foot));
  draw();
  pop = showPopover(anchor, panel, { side: 'top', className: 'mp-pop' });
  search.focus();
  list.querySelector('.mp-row.selected')?.scrollIntoView({ block: 'nearest' });
  return pop;
}
