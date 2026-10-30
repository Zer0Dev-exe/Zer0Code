import { h, clear, icon } from './dom.js';
import { state, on, setUi, applyTheme, verifySession, startSession, newThread, loadSessions } from './store.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountWorkspace } from './ui/workspace.js';
import { renderLogin } from './ui/login.js';
import { openPalette } from './ui/dialogs.js';
import { watchUpdateNotices } from './ui/whatsnew.js';

const root = document.getElementById('root');
let started = false;

async function boot() {
  applyTheme();
  const v = await verifySession();
  if (!v.ok) return renderLogin(root, { onDone: boot });
  if (v.mustChangePassword) return renderLogin(root, { onDone: boot, mustChange: true });
  await mountApp();
}

async function mountApp() {
  clear(root);
  const sidebar = h('aside', { class: 'sidebar' });
  const workspace = h('main', { class: 'workspace' });
  const app = h('div', { class: `app${state.ui.sidebar ? '' : ' sidebar-closed'}` }, sidebar, workspace);
  root.append(app);

  // El área de controles nativos de la ventana (Windows y Linux) no se solapa con los botones de la barra superior
  const inset = () => {
    const overlay = navigator.windowControlsOverlay;
    const w = overlay?.visible ? window.innerWidth - overlay.getTitlebarAreaRect().right : 0;
    document.documentElement.style.setProperty('--native-controls-inset', `${Math.max(0, w)}px`);
  };
  inset();
  navigator.windowControlsOverlay?.addEventListener('geometrychange', inset);

  mountSidebar(sidebar);
  mountWorkspace(workspace);
  on('ui', () => { app.classList.toggle('sidebar-closed', !state.ui.sidebar); });
  on('logout', () => { started = false; boot(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.ui.theme === 'system') applyTheme(); });

  newThread();
  if (!started) {
    started = true;
    watchUpdateNotices();
    await startSession().catch((err) => { console.error(err); });
  }
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newThread(); }
  else if (mod && e.key === 'b') { e.preventDefault(); setUi({ sidebar: !state.ui.sidebar }); }
  else if (mod && e.key === 'd') { e.preventDefault(); setUi({ panel: { ...state.ui.panel, open: !state.ui.panel.open } }); }
});

boot();
