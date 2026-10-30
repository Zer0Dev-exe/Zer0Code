import { h, clear, icon, providerMark, openDialog, toast, basename, timeAgo, esc } from '../dom.js';
import { api } from '../api.js';
import {
  state, setUi, applyTheme, newThread, openSession, addProject, saveOrchestration, loadOrchestration, modelInfo, setPref, currentModelId,
  effortLevelsFor, logout, projectList, loadStatus, updateActions, on, saveDisplayName, toolFor, installTool, uninstallTool, loadTools
} from '../store.js';

import { openWhatsNew } from './whatsnew.js';

const short = (n) => String(n || '').replace(/^Claude\s+/i, '');
const EFFORT_LABEL = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };

export function openDisplayName() {
  const input = h('input', { id: 'profile-display-name', class: 'input', type: 'text', maxlength: 40, value: state.profile?.displayName || state.user?.username || '', autocomplete: 'nickname' });
  const error = h('div', { class: 'hint', role: 'alert' });
  const save = h('button', { class: 'btn-sm btn-primary', type: 'submit' }, 'Guardar');
  const form = h('form', null,
    h('label', { for: 'profile-display-name' }, 'Nombre visible'), input,
    h('p', { class: 'hint' }, 'Se guarda en tu cuenta para todos tus dispositivos. Déjalo vacío para usar el nombre automático.'),
    error, save);
  const dialog = openDialog({ title: 'Cambiar nombre visible', body: form, width: 400 });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      await saveDisplayName(input.value.trim());
      dialog.close();
      toast('Nombre visible guardado');
    } catch (failure) {
      error.textContent = failure.message || 'No se pudo guardar el nombre visible.';
    } finally {
      save.disabled = false;
    }
  });
  input.focus();
  input.select();
}

// --------------------------------------------------------------------------
// Paleta de comandos (Ctrl K)
// --------------------------------------------------------------------------
let paletteOpen = false;
export function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const input = h('input', { class: 'palette-input', placeholder: 'Buscar conversaciones, proyectos y acciones…', type: 'text' });
  const list = h('div', { class: 'palette-list' });
  const overlay = h('div', { class: 'palette' }, h('div', { class: 'palette-box' }, input, list));
  let items = [];
  let sel = 0;
  const close = () => { overlay.remove(); paletteOpen = false; document.removeEventListener('keydown', onKey, true); };

  const actions = [
    { t: 'Nuevo hilo', ic: 'square-pen', run: () => newThread() },
    { t: 'Añadir proyecto…', ic: 'folder-plus', run: () => openFolderPicker() },
    { t: 'Orquestador de agentes', ic: 'orch', run: () => openOrchestrator() },
    { t: 'Ajustes', ic: 'settings', run: () => openSettings() },
    { t: 'Uso y gasto', ic: 'chart', run: () => openUsage() },
    ...(state.update?.current ? [{ t: 'Novedades y actualizaciones', ic: 'zap', run: () => openWhatsNew() }] : []),
    ...(state.user?.role === 'admin' ? [{ t: 'Gestionar usuarios', ic: 'shield', run: () => openUsers() }] : []),
    { t: state.ui.panel.open ? 'Ocultar panel de cambios' : 'Mostrar panel de cambios', ic: 'panel-right', run: () => setUi({ panel: { ...state.ui.panel, open: !state.ui.panel.open } }) }
  ];

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = [
      ...state.sessions.filter(s => !q || (s.title + ' ' + basename(s.workspace)).toLowerCase().includes(q)).slice(0, 12)
        .map(s => ({ t: s.title, s: `${basename(s.workspace)} · ${timeAgo(s.updatedAt)}`, ic: 'square-pen', run: () => openSession(s.id) })),
      ...projectList().filter(p => q && p.name.toLowerCase().includes(q)).slice(0, 5)
        .map(p => ({ t: p.name, s: 'Nuevo hilo en este proyecto', ic: 'folder', run: () => newThread({ workspace: p.dir }) })),
      ...actions.filter(a => !q || a.t.toLowerCase().includes(q))
    ];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    clear(list);
    if (!items.length) list.append(h('div', { class: 'empty-list' }, 'Sin resultados'));
    items.forEach((it, i) => list.append(h('button', { class: `palette-item${i === sel ? ' sel' : ''}`, type: 'button', onclick: () => { close(); it.run(); }, onmousemove: () => { sel = i; [...list.children].forEach((c, j) => c.classList.toggle('sel', j === i)); } },
      icon(it.ic), h('span', { class: 't truncate' }, it.t), it.s ? h('span', { class: 's' }, it.s) : null)));
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { close(); it.run(); } }
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  draw();
  input.focus();
}

// --------------------------------------------------------------------------
// Orquestador
// --------------------------------------------------------------------------
export async function openOrchestrator() {
  await loadOrchestration();
  const orch = state.orch;
  if (!orch) { toast('Este servidor no tiene orquestador: actualízalo', 'error'); return; }
  const cfg = orch.config;

  const sw = (id, title, desc, checked) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', id, checked }), h('span', { class: 'track' }),
    h('span', { class: 'text' }, h('b', { style: { fontWeight: 500 } }, title), h('small', null, desc)));
  const enabled = sw('o-enabled', 'Revisión automática', 'Cada tarea la revisa otro modelo', cfg.enabled);
  const live = sw('o-live', 'Revisar mientras trabaja', 'Cuando el desarrollador deja de editar un momento (hasta 3 por tarea). Si no, solo revisa al terminar', cfg.live);
  const autofix = sw('o-autofix', 'Corregir solo', 'Si el revisor pide cambios, el desarrollador los aplica sin esperar a que se lo pidas', cfg.autoFix);

  const reviewer = h('select', { class: 'select' });
  const effort = h('select', { class: 'select' });
  const rounds = h('select', { class: 'select' }, [1, 2, 3, 4, 5].map(n => h('option', { value: n }, n)));
  rounds.value = String(cfg.maxRounds);
  const flow = h('div', { class: 'flow' });
  const reason = h('div', { class: 'hint' });
  const status = h('div', { class: 'status-box', hidden: true });
  const options = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

  const rec = orch.recommended;
  const recModel = rec.reviewer && modelInfo(rec.reviewer.model);
  const fillReviewer = () => {
    clear(reviewer);
    reviewer.append(h('option', { value: '' }, `Automático (recomendado)${recModel ? ` · ${short(recModel.name)}` : ''}`));
    for (const [provider, label] of [['claude', 'Claude'], ['codex', 'ChatGPT'], ['gemini', 'Gemini']]) {
      const models = state.models.filter(m => (m.provider || 'claude') === provider);
      if (!models.length) continue;
      const connected = provider === 'claude' || state.providers[provider]?.loggedIn;
      const group = h('optgroup', { label: label + (connected ? '' : ' (sin conectar)') });
      models.forEach(m => group.append(h('option', { value: m.id, disabled: !connected }, short(m.name))));
      reviewer.append(group);
    }
    reviewer.value = cfg.reviewerModel && state.models.some(m => m.id === cfg.reviewerModel) ? cfg.reviewerModel : '';
  };
  const fillEffort = (selected) => {
    const id = reviewer.value || rec.reviewer?.model;
    const levels = effortLevelsFor(id);
    clear(effort);
    effort.append(h('option', { value: '' }, 'Automático (alto)'), levels.map(l => h('option', { value: l }, EFFORT_LABEL[l] || l)));
    effort.value = levels.includes(selected) ? selected : '';
    effort.disabled = !levels.length;
  };
  const drawFlow = () => {
    const rid = reviewer.value || rec.reviewer?.model;
    const dev = modelInfo(currentModelId());
    clear(flow);
    flow.append(
      h('div', { class: 'node' }, h('small', null, 'Desarrolla'), h('b', null, providerMark(dev.provider || 'claude'), short(dev.name))),
      icon('chevron-right', 'arrow'),
      h('div', { class: 'node' }, h('small', null, 'Revisa'), h('b', null, rid ? [providerMark(modelInfo(rid).provider || 'claude'), short(modelInfo(rid).name)] : 'sin revisor')));
    reason.textContent = reviewer.value ? '' : (rec.reviewer?.reason || '');
  };
  const dep = () => {
    options.style.opacity = enabled.querySelector('input').checked ? '1' : '0.45';
    options.style.pointerEvents = enabled.querySelector('input').checked ? '' : 'none';
    roundsField.hidden = !autofix.querySelector('input').checked;
  };
  const roundsField = h('div', { class: 'field' }, h('label', null, 'Rondas de corrección como máximo'), rounds);

  fillReviewer(); fillEffort(cfg.reviewerEffort); drawFlow();
  options.append(
    h('div', { class: 'field' }, h('label', null, 'Revisor'), reviewer, reason),
    h('div', { class: 'field' }, h('label', null, 'Esfuerzo del revisor'), effort, h('div', { class: 'hint' }, 'Las revisiones durante el desarrollo usan esfuerzo medio para gastar menos; la final usa el que elijas.')),
    live, autofix, roundsField);
  reviewer.addEventListener('change', () => { fillEffort(null); drawFlow(); });
  enabled.querySelector('input').addEventListener('change', dep);
  autofix.querySelector('input').addEventListener('change', dep);
  dep();

  const useRecommended = () => {
    const dev = rec.developer;
    if (dev && state.models.some(m => m.id === dev.model)) { setPref('model', dev.model); setPref('effort', dev.effort || 'auto'); }
    reviewer.value = '';
    enabled.querySelector('input').checked = true;
    fillEffort(null); drawFlow(); dep();
    status.hidden = false; status.className = 'status-box ok'; status.textContent = 'Listo: pulsa Guardar para activarlo.';
  };

  const dlg = openDialog({
    title: 'Orquestador de agentes', width: 520,
    body: [
      h('p', { class: 'hint', style: { margin: 0 } }, 'Un modelo desarrolla y otro, de otra familia, revisa el código a la vez: encuentra fallos que el primero no ve. Se guarda en tu cuenta y vale en todos tus dispositivos.'),
      enabled, flow, options, status,
      h('div', null, h('button', { class: 'btn-sm', type: 'button', onclick: useRecommended }, icon('zap'), 'Usar los modelos que recomienda Zer0Code'))
    ],
    footer: [
      h('button', { class: 'btn-sm', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
      h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: async (e) => {
        e.currentTarget.disabled = true;
        const res = await saveOrchestration({
          enabled: enabled.querySelector('input').checked, reviewerModel: reviewer.value || null, reviewerEffort: effort.value || null,
          live: live.querySelector('input').checked, autoFix: autofix.querySelector('input').checked, maxRounds: Number(rounds.value)
        }).catch(() => null);
        if (res?.success) { dlg.close(); toast(res.config.enabled ? 'Orquestador activado' : 'Orquestador desactivado'); }
        else { e.currentTarget.disabled = false; status.hidden = false; status.className = 'status-box error'; status.textContent = 'No se pudo guardar'; }
      } }, 'Guardar')
    ]
  });
}

// --------------------------------------------------------------------------
// Ajustes
// --------------------------------------------------------------------------
export async function openSettings() {
  await Promise.all([loadStatus().catch(() => {}), loadTools().catch(() => {})]);
  const desktop = window.Zer0CodeDesktop;
  const seg = h('div', { class: 'segmented' }, [['light', 'sun', 'Claro'], ['dark', 'moon', 'Oscuro'], ['system', 'monitor', 'Sistema']].map(([v, ic, label]) =>
    h('button', { type: 'button', class: state.ui.theme === v ? 'on' : '', onclick: () => { setUi({ theme: v }); applyTheme(); [...seg.children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); }, dataset: { v } }, icon(ic), label)));

  // Cada cuenta necesita su herramienta (Claude Code, Codex, Gemini CLI): si no está, se instala desde aquí
  const acct = (provider, name, ok, detail) => {
    const tool = toolFor(provider);
    if (tool && !tool.installed) {
      const busy = tool.installing;
      return h('div', { class: 'acct tool-row' }, providerMark(provider),
        h('div', { class: 'grow' }, name,
          h('small', null, busy ? `Instalando ${tool.label}… ${tool.progress || 0}%` : tool.error ? `Error: ${tool.error}` : `${tool.label} no está instalado · unos ${tool.sizeMB} MB`),
          busy ? h('span', { class: 'tool-bar' }, h('i', { style: { width: `${tool.progress || 0}%` } })) : null),
        state.canManageTools
          ? h('button', { class: 'btn-sm btn-primary', type: 'button', disabled: busy, onclick: () => installTool(tool.id).catch(err => toast(err.message, 'error')) },
            busy ? icon('loader', 'spin') : icon('arrow-up'), busy ? 'Instalando' : tool.error ? 'Reintentar' : 'Instalar')
          : h('span', { class: 'hint' }, 'Pide al administrador que lo instale'));
    }
    const removable = tool?.source === 'app' && state.canManageTools;
    return h('div', { class: 'acct' }, providerMark(provider),
      h('div', { class: 'grow' }, name, h('small', null, (ok ? (detail || 'Conectado') : 'Sin conectar') + (tool?.version ? ` · ${tool.label} ${tool.version}` : ''))),
      removable ? h('button', { class: 'btn-sm btn-ghost', type: 'button', title: `Desinstalar ${tool.label} (libera unos ${tool.sizeMB} MB)`,
        onclick: () => { if (confirm(`¿Desinstalar ${tool.label}? Podrás volver a instalarlo desde aquí.`)) uninstallTool(tool.id).catch(err => toast(err.message, 'error')); } }, icon('trash')) : null,
      ok ? h('span', { class: 'badge ok' }, 'Conectado')
        : (desktop?.linkAccount ? h('button', { class: 'btn-sm', type: 'button', onclick: () => desktop.linkAccount(provider) }, 'Vincular…')
          : h('span', { class: 'hint' }, provider === 'codex' ? 'codex login' : provider === 'gemini' ? 'gemini login' : 'claude auth login')));
  };
  const accounts = h('div', { class: 'field' });
  const drawAccounts = () => {
    clear(accounts);
    accounts.append(h('span', { class: 'label' }, 'Cuentas del servidor'),
      acct('claude', 'Claude', !!state.authInfo?.loggedIn, state.authInfo?.email),
      acct('codex', 'ChatGPT (Codex)', !!state.providers.codex?.loggedIn),
      acct('gemini', 'Gemini', !!state.providers.gemini?.loggedIn));
  };
  drawAccounts();
  const offTools = on('tools', drawAccounts);
  const offStatus = on('status', drawAccounts);

  const notif = 'Notification' in window ? h('div', { class: 'acct' }, icon('eye'), h('div', { class: 'grow' }, 'Notificaciones del sistema', h('small', null, 'Avisos cuando una tarea termina o necesita tu permiso')),
    Notification.permission === 'granted' ? h('span', { class: 'badge ok' }, 'Activadas')
      : h('button', { class: 'btn-sm', type: 'button', onclick: async (e) => { const r = await Notification.requestPermission(); e.currentTarget.replaceWith(h('span', { class: `badge ${r === 'granted' ? 'ok' : ''}` }, r === 'granted' ? 'Activadas' : 'Bloqueadas')); } }, 'Activar')) : null;

  // Versión y actualizaciones (solo la app de escritorio tiene el puente con GitHub)
  const verRow = h('div', { class: 'field' });
  const drawVersion = () => {
    const u = state.update;
    if (!u) { clear(verRow); return; }
    const status = u.status === 'checking' ? 'Comprobando…' : u.status === 'available' ? `Hay una versión nueva: ${u.latest.version}`
      : u.status === 'error' ? u.error : u.checkedAt ? 'Estás al día' : 'Sin comprobar todavía';
    clear(verRow);
    verRow.append(h('span', { class: 'label' }, 'Versión'),
      h('div', { class: 'acct' }, icon('zap'), h('div', { class: 'grow' }, `Zer0Code ${u.current}`, h('small', null, status)),
        h('button', { class: 'btn-sm', type: 'button', onclick: () => { dlg.close(); openWhatsNew(); } }, 'Novedades'),
        u.status === 'available'
          ? h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => { updateActions.install(); } }, 'Actualizar')
          : h('button', { class: 'btn-sm', type: 'button', disabled: u.status === 'checking' || u.status === 'downloading', onclick: () => updateActions.check() }, 'Buscar actualizaciones')),
      null);
  };
  drawVersion();
  const offUpdate = on('update', drawVersion);

  const dlg = openDialog({
    title: 'Ajustes', width: 520, onClose: () => { offUpdate(); offTools(); offStatus(); },
    body: [
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Apariencia'), seg),
      accounts,
      notif, verRow,
      state.user?.role === 'admin' ? h('div', { class: 'field' }, h('span', { class: 'label' }, 'Usuarios'),
        h('div', { class: 'acct' }, icon('shield'), h('div', { class: 'grow' }, 'Gestionar usuarios', h('small', null, 'Crear, editar y eliminar cuentas')),
          h('button', { class: 'btn-sm', type: 'button', onclick: () => { dlg.close(); openUsers(); } }, 'Abrir'))) : null,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Servidor'),
        h('div', { class: 'hint' }, `Conectado a ${location.origin}. Tus conversaciones viven ahí y son las mismas en la web, el móvil y esta app.`),
        desktop?.changeServer ? h('div', null, h('button', { class: 'btn-sm', type: 'button', onclick: () => desktop.changeServer() }, 'Cambiar de servidor')) : null)
    ],
    footer: [
      h('button', { class: 'btn-sm btn-danger', type: 'button', onclick: async () => { dlg.close(); await logout(); } }, icon('log-out'), 'Cerrar sesión'),
      h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => dlg.close() }, 'Listo')
    ]
  });
}

// --------------------------------------------------------------------------
// Usuarios (solo administrador)
// --------------------------------------------------------------------------
const USER_MODES = [['manual', 'Manual'], ['acceptEdits', 'Aceptar ediciones'], ['plan', 'Plan'], ['auto', 'Auto']];

export function openUsers() {
  const body = h('div', null);
  const dlg = openDialog({ title: 'Usuarios', width: 560, body });
  let users = [];

  const call = async (path, method, payload) => {
    const data = await api(path, { method, body: payload });
    if (!data.success) throw new Error(data.error || 'No se pudo completar la acción');
    users = data.users || users;
    return data;
  };

  const showList = () => {
    clear(body);
    body.append(h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
      h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => showForm(null) }, icon('plus'), 'Nuevo usuario')));
    for (const u of users) {
      const admin = u.role === 'admin';
      const detail = admin ? 'Administrador · acceso total'
        : `${(u.allowedModes || []).length} modos · ${(u.roots || []).join(', ')}${u.monthlyLimitUSD != null ? ` · límite $${u.monthlyLimitUSD}` : ''}`;
      body.append(h('div', { class: 'acct' }, icon(admin ? 'shield' : 'bot'),
        h('div', { class: 'grow' }, u.username, h('small', null, detail)),
        admin ? h('span', { class: 'badge ok' }, 'Admin') : [
          h('button', { class: 'icon-btn', type: 'button', title: 'Editar', onclick: () => showForm(u) }, icon('pencil')),
          h('button', { class: 'icon-btn', type: 'button', title: 'Eliminar', onclick: () => remove(u) }, icon('trash'))
        ]));
    }
  };

  const remove = async (u) => {
    if (!confirm(`¿Eliminar al usuario "${u.username}" y todas sus conversaciones?`)) return;
    try { await call(`/api/users/${encodeURIComponent(u.username)}`, 'DELETE'); toast('Usuario eliminado'); showList(); }
    catch (e) { toast(e.message, 'error'); }
  };

  const showForm = (u) => {
    const isNew = !u;
    const name = h('input', { class: 'input', type: 'text', value: u?.username || '', disabled: !isNew, autocomplete: 'off' });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: isNew ? 'Mínimo 8 caracteres' : 'Déjalo vacío para no cambiarla' });
    const roots = h('textarea', { class: 'input mono', rows: 3, style: { height: 'auto', padding: '8px 12px' }, placeholder: '/ruta/a/la/carpeta (una por línea)' });
    roots.value = (u?.roots || []).join('\n');
    const limit = h('input', { class: 'input', type: 'number', min: 0, step: 0.01, value: u?.monthlyLimitUSD ?? '', placeholder: 'Sin límite' });
    const allowed = u?.allowedModes || ['manual', 'acceptEdits', 'plan'];
    const modes = USER_MODES.map(([id, label]) => ({ id, box: h('input', { type: 'checkbox', checked: allowed.includes(id) }), label }));
    const error = h('div', { class: 'status-box error', hidden: true });
    const save = h('button', { class: 'btn-sm btn-primary', type: 'button' }, isNew ? 'Crear usuario' : 'Guardar');

    save.addEventListener('click', async () => {
      error.hidden = true;
      save.disabled = true;
      const payload = {
        password: pass.value || undefined,
        roots: roots.value.split('\n').map(r => r.trim()).filter(Boolean),
        allowedModes: modes.filter(m => m.box.checked).map(m => m.id),
        monthlyLimitUSD: limit.value === '' ? null : Number(limit.value)
      };
      try {
        if (isNew) await call('/api/users', 'POST', { ...payload, username: name.value.trim() });
        else await call(`/api/users/${encodeURIComponent(u.username)}`, 'PATCH', payload);
        toast(isNew ? 'Usuario creado' : 'Usuario actualizado');
        showList();
      } catch (e) {
        error.hidden = false;
        error.textContent = e.message;
        save.disabled = false;
      }
    });

    clear(body);
    body.append(
      h('div', { class: 'field' }, h('label', null, 'Usuario'), name),
      h('div', { class: 'field' }, h('label', null, isNew ? 'Contraseña inicial' : 'Nueva contraseña'), pass,
        h('div', { class: 'hint' }, 'El usuario tendrá que cambiarla al entrar.')),
      h('div', { class: 'field' }, h('label', null, 'Carpetas permitidas'), roots),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Modos de ejecución'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } },
          modes.map(m => h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' } }, m.box, m.label)))),
      h('div', { class: 'field' }, h('label', null, 'Límite mensual (USD)'), limit),
      error,
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn-sm', type: 'button', onclick: showList }, 'Volver'), save));
    (isNew ? name : pass).focus();
  };

  body.append(h('div', { class: 'hint' }, 'Cargando…'));
  api('/api/users').then(data => {
    if (!data.success) throw new Error(data.error);
    users = data.users;
    showList();
  }).catch(e => { clear(body); body.append(h('div', { class: 'status-box error' }, e.message || 'No se pudieron cargar los usuarios')); });
  return dlg;
}

// --------------------------------------------------------------------------
// Uso y gasto
// --------------------------------------------------------------------------
export async function openUsage() {
  const body = h('div', null, h('div', { class: 'hint' }, 'Cargando…'));
  openDialog({ title: 'Uso y gasto', body, width: 460 });
  try {
    const [data, providerUsage] = await Promise.all([api('/api/usage'), api('/api/usage/providers')]);
    const models = Object.entries(data.usage?.models || {}).sort((a, b) => b[1].costUSD - a[1].costUSD);
    clear(body);
    body.append(h('div', { class: 'flow' }, h('div', { class: 'node' }, h('small', null, 'Claude: referencia acumulada a tarifa API'), h('b', null, `$${(data.usage?.totalCostUSD || 0).toFixed(2)}`))));
    if (data.monthlyLimit) body.append(h('div', { class: 'hint' }, `Límite mensual: $${data.monthlyLimit.spentUSD.toFixed(2)} de $${data.monthlyLimit.limitUSD.toFixed(2)}`));
    body.append(h('div', { class: 'hint' }, 'Con suscripción, los precios de API son una referencia, no un cobro. Los tokens locales no equivalen a la cuota de una suscripción.'));
    for (const provider of providerUsage.providers || []) {
      const quota = provider.quota;
      const limits = [['Sesión', quota.session], ['Semana', quota.weekly]].filter(([, value]) => value).map(([label, value]) => `${label}: ${Math.round(value.percent)}% usado`).join(' · ');
      const usage = provider.localUsage;
      body.append(h('section', { class: 'provider-usage-card' },
        h('b', null, provider.name),
        h('div', { class: 'hint' }, quota.available ? limits : quota.message),
        quota.scopeLabel ? h('div', { class: 'hint' }, quota.scopeLabel) : null,
        h('div', { class: 'hint' }, `Tu uso en Zer0Code: ${usage.responses} ejecuciones (incluye revisiones) · ${usage.tokensAvailable ? `${usage.totalTokens.toLocaleString()} tokens` : 'tokens no disponibles'}`),
        usage.note ? h('div', { class: 'hint' }, usage.note) : null));
    }
    if (!models.length) body.append(h('div', { class: 'empty-list' }, 'Todavía no hay gasto registrado'));
    for (const [name, m] of models) {
      const provider = modelInfo(name).provider;
      const knownCost = provider ? provider === 'claude' : !/^(gpt|codex|gemini|o\d)/i.test(name);
      body.append(h('div', { class: 'acct' }, h('div', { class: 'grow' }, name), h('span', { class: 'tabular', title: knownCost ? 'Referencia a tarifa API' : 'Precio no disponible' }, knownCost ? `$${m.costUSD.toFixed(2)}` : '—')));
    }
  } catch {
    body.replaceChildren(h('div', { class: 'status-box error' }, 'No se pudo cargar el uso'));
  }
}

// --------------------------------------------------------------------------
// Elegir carpeta de proyecto (en el servidor)
// --------------------------------------------------------------------------
export async function openFolderPicker() {
  let current = '';
  const path = h('input', { class: 'input mono', type: 'text', spellcheck: false });
  const quick = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
  const list = h('div', { class: 'folder-list' });
  const err = h('div', { class: 'status-box error', hidden: true });

  const load = async (dir) => {
    err.hidden = true;
    try {
      const data = await api(`/api/workspace?dir=${encodeURIComponent(dir || '')}`);
      if (!data.success) throw new Error(data.error || 'No se puede abrir esa carpeta');
      current = data.current;
      path.value = current;
      clear(list);
      if (data.parent) list.append(h('button', { class: 'menu-item', type: 'button', onclick: () => load(data.parent) }, icon('chevron-up'), h('span', { class: 'menu-label' }, '..')));
      for (const f of data.folders) list.append(h('button', { class: 'menu-item', type: 'button', onclick: () => load(f.path) }, icon('folder'), h('span', { class: 'menu-label' }, f.name)));
      if (!data.folders.length) list.append(h('div', { class: 'empty-list' }, 'Sin subcarpetas'));
    } catch (e) { err.hidden = false; err.textContent = e.message; }
  };
  path.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(path.value); });

  const dlg = openDialog({
    title: 'Añadir proyecto', width: 560,
    body: [h('div', { class: 'hint', style: { margin: 0 } }, 'Elige la carpeta del proyecto en el equipo donde corre el servidor.'), quick, path, list, err],
    footer: [
      h('button', { class: 'btn-sm', type: 'button', onclick: () => dlg.close() }, 'Cancelar'),
      h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => { if (!current) return; addProject(current); newThread({ workspace: current }); dlg.close(); } }, 'Usar esta carpeta')
    ]
  });
  try {
    const q = await api('/api/quick-locations');
    (q.locations || []).forEach(l => quick.append(h('button', { class: 'btn-sm', type: 'button', onclick: () => load(l.path) }, icon('folder'), l.name)));
  } catch { /* sin accesos rápidos */ }
  load(state.workspace || '');
}
