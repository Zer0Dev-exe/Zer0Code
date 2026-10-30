import { h, clear, icon, openDialog } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { state, on, updateActions } from '../store.js';

// Novedades (el botón de la versión de la barra lateral, como en T3 Code): la versión instalada, si hay una
// nueva, el estado de la descarga y las notas de los últimos releases.

const REPO_RELEASES = 'https://github.com/Zer0Dev-exe/Zer0Code/releases';
const cmp = (a, b) => {
  const p = (v) => (String(v || '').match(/^v?(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
  const x = p(a), y = p(b);
  if (x.length < 3 || y.length < 3) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const fmtDate = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; }
};
const MB = (n) => n ? `${(n / 1024 / 1024).toFixed(0)} MB` : '';

let open = null;
let noticeShown = '';
let watching = false;

/** Avisos tras reiniciar: abrir las novedades una sola vez por versión */
export function watchUpdateNotices() {
  if (watching) return;
  watching = true;
  on('just-updated', (notice) => {
    const key = `${notice.version}:${notice.failed ? 'x' : 'ok'}`;
    if (noticeShown === key) return;
    noticeShown = key;
    openWhatsNew({ notice });
  });
}

export function openWhatsNew({ notice = null } = {}) {
  if (open) return open;
  const hero = h('div', { class: 'wn-hero' });
  const list = h('div', { class: 'wn-list' }, h('div', { class: 'wn-loading' }, icon('loader', 'spin'), 'Cargando novedades…'));
  let releases = null;

  const drawHero = () => {
    const u = state.update;
    const current = u?.current || '';
    const latest = u?.latest;
    clear(hero);

    let status, action = null;
    if (!u) status = 'Las actualizaciones las gestiona la app de escritorio.';
    else if (u.status === 'checking') status = 'Buscando actualizaciones…';
    else if (u.status === 'downloading') status = `Descargando v${latest?.version} · ${u.progress}%`;
    else if (u.status === 'ready') status = latest?.inPlace ? 'Instalando… la app se reiniciará sola' : 'Descarga verificada';
    else if (u.status === 'opened') status = 'Instalador abierto: sigue sus pasos y vuelve a abrir Zer0Code';
    else if (u.status === 'available' && latest) status = `Disponible la v${latest.version}`;
    else if (u.status === 'error') status = u.error || 'No se pudo actualizar';
    else status = u.checkedAt ? 'Tienes la última versión' : 'Sin comprobar todavía';

    if (u?.status === 'available' && latest) {
      action = h('div', { class: 'wn-action' },
        h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => updateActions.install() }, icon('arrow-up'), `Actualizar a v${latest.version}`),
        h('span', { class: 'hint' }, !latest.asset ? 'Se abrirá la página del release para descargarla'
          : latest.inPlace ? `${MB(latest.asset.size)} · se descarga, se verifica y la app se reinicia sola`
            : `${MB(latest.asset.size)} · se descarga, se verifica y se abre el instalador`));
    } else if (u && ['downloading', 'ready'].includes(u.status)) {
      action = h('div', { class: 'wn-progress' }, h('i', { style: { width: `${u.status === 'ready' ? 100 : u.progress}%` } }));
    } else if (u) {
      action = h('div', { class: 'wn-action' },
        h('button', { class: 'btn-sm', type: 'button', disabled: u.status === 'checking', onclick: () => updateActions.check() },
          icon('refresh'), u.status === 'error' && latest ? 'Reintentar' : 'Buscar actualizaciones'),
        u.status === 'error' && latest ? h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => updateActions.install() }, 'Reintentar la descarga') : null);
    }

    const noticeBox = notice?.failed
      ? h('div', { class: 'status-box error wn-notice' }, icon('alert'),
        h('div', null, h('b', null, `La actualización a v${notice.version} no llegó a aplicarse.`),
          h('div', null, `Sigues con la v${current}. Vuelve a intentarlo o descárgala desde GitHub. El detalle queda en el registro (logs/updater.log de la carpeta de datos).`)))
      : notice ? h('div', { class: 'status-box ok wn-notice' }, icon('circle-check'), h('div', null, h('b', null, `Zer0Code actualizado a la v${notice.version}.`), h('div', null, 'Esto es lo nuevo:')))
        : null;

    hero.append(
      h('div', { class: 'wn-head' },
        h('img', { class: 'wn-logo', src: '../icon.svg', alt: '' }),
        h('div', { class: 'grow' },
          h('div', { class: 'wn-title' }, h('b', null, 'Zer0'), 'Code', current ? h('span', { class: 'wn-ver' }, `v${current}`) : null),
          h('div', { class: `wn-status${u?.status === 'available' ? ' new' : u?.status === 'error' ? ' err' : ''}` }, status))),
      noticeBox, action);
  };

  const drawList = () => {
    if (!releases) return;
    const current = state.update?.current;
    clear(list);
    if (!releases.length) { list.append(h('div', { class: 'wn-loading' }, 'Aún no hay versiones publicadas.')); return; }
    releases.forEach((r, i) => {
      const newer = current && cmp(r.version, current) > 0;
      const installed = current && cmp(r.version, current) === 0;
      const notes = h('div', { class: 'md wn-notes', html: r.notes ? renderMarkdown(r.notes) : '<p class="muted">Sin notas.</p>' });
      const head = [
        h('span', { class: 'wn-dot' }),
        h('span', { class: 'wn-rel-ver' }, `v${r.version}`),
        newer ? h('span', { class: 'badge running' }, 'Nueva') : null,
        installed ? h('span', { class: 'badge ok' }, 'Instalada') : null,
        r.prerelease ? h('span', { class: 'badge warn' }, 'Prueba') : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'wn-date' }, fmtDate(r.date))
      ];
      // Las versiones nuevas, la instalada y la más reciente se ven abiertas; las antiguas, plegadas
      const expanded = newer || installed || i === 0;
      list.append(h('details', { class: `wn-rel${newer ? ' newer' : ''}${installed ? ' installed' : ''}`, open: expanded || null },
        h('summary', null, ...head, icon('chevron-down', 'wn-chev')), notes));
    });
    for (const a of list.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noreferrer noopener'; }
  };

  drawHero();
  const offUpdate = on('update', () => { drawHero(); drawList(); });
  updateActions.releases().then((r) => { releases = r || []; drawList(); }).catch((err) => {
    clear(list);
    list.append(h('div', { class: 'wn-loading' }, `No se pudieron cargar las novedades (${err.message}).`));
  });
  if (notice) updateActions.dismissNotice();

  const dlg = openDialog({
    title: 'Novedades', width: 600,
    onClose: () => { offUpdate(); open = null; },
    body: [hero, h('div', { class: 'label wn-label' }, 'Versiones'), list],
    footer: [
      h('a', { class: 'btn-sm btn-ghost', href: REPO_RELEASES, target: '_blank', rel: 'noreferrer noopener' }, icon('globe'), 'Ver en GitHub'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn-sm btn-primary', type: 'button', onclick: () => dlg.close() }, 'Listo')
    ]
  });
  open = dlg;
  return dlg;
}
