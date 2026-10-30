# Política de seguridad

## Versiones con soporte

Solo la última versión publicada en [Releases](https://github.com/Zer0Dev-exe/Zer0Code/releases) recibe correcciones de seguridad. La app de escritorio y la de Android se actualizan solas; el servidor se actualiza con `git pull` o con el instalador de la nueva versión.

## Cómo informar de una vulnerabilidad

**No abras un issue público.** Usa el aviso privado de GitHub:

1. Ve a la pestaña [Security → Report a vulnerability](https://github.com/Zer0Dev-exe/Zer0Code/security/advisories/new).
2. Describe el problema, la versión afectada y, si puedes, los pasos para reproducirlo.

Recibirás respuesta en un plazo de 7 días. Cuando haya una corrección se publicará una versión nueva y un aviso de seguridad (GHSA) con los créditos que quieras.

## Qué cubre

- El servidor de Zer0Code (`server/`): autenticación, sesiones, permisos de herramientas, acceso a carpetas y la API.
- La web y la interfaz de escritorio (`public/`).
- La app de escritorio (`desktop/`), incluido el actualizador.
- La app de Android (`packaging/android/`), incluido el actualizador.
- Los instaladores y el flujo de publicación (`.github/workflows/`, `packaging/`).

Los fallos de Claude Code, Codex o Gemini CLI se notifican a sus autores.
