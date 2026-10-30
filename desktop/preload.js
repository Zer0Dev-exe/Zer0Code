// Puente entre la web de Zer0Code y la app de escritorio. La web solo ve lo que se expone aquí.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('Zer0CodeDesktop', {
  platform: process.platform,
  // Volver a la pantalla de elegir servidor
  changeServer: () => ipcRenderer.invoke('desktop:change-server'),
  // Traer la ventana al frente (al tocar una notificación)
  focus: () => ipcRenderer.invoke('desktop:focus'),
  // Actualizaciones: estado, comprobar, instalar la nueva versión y omitir una versión
  getUpdate: () => ipcRenderer.invoke('desktop:get-update'),
  checkUpdate: () => ipcRenderer.invoke('desktop:check-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  skipUpdate: (version) => ipcRenderer.invoke('desktop:skip-update', version),
  onUpdate: (callback) => ipcRenderer.on('desktop:update', (_event, state) => callback(state)),
  // Novedades: los últimos releases con sus notas, y descartar el aviso de «actualizado a…»
  getReleases: () => ipcRenderer.invoke('desktop:releases'),
  dismissUpdateNotice: () => ipcRenderer.invoke('desktop:dismiss-update-notice'),
  // Linux (ventana sin marco): minimizar, maximizar y cerrar
  windowControl: (action) => ipcRenderer.invoke('desktop:window', action),
  // Colores de los controles de ventana (Windows y Linux) según el tema de la web
  setTheme: (theme) => ipcRenderer.invoke('desktop:set-theme', theme),
  // Vincular una cuenta (claude, codex o gemini) con su CLI; solo con el servidor integrado
  linkAccount: (provider) => ipcRenderer.invoke('desktop:link-account', provider),
  // Solo los usa la pantalla de conexión (el proceso principal comprueba que vienen de ella)
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  testServer: (url) => ipcRenderer.invoke('desktop:test-server', url),
  connect: (options) => ipcRenderer.invoke('desktop:connect', options),
  onNotice: (callback) => ipcRenderer.on('desktop:notice', (_event, message) => callback(message))
});
