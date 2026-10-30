#!/usr/bin/env bash
# Prueba rápida de una instalación: arranca el servidor con datos temporales, comprueba que responde
# y que el Claude Code incluido funciona (si lo lleva). Uso: bash packaging/smoke-test.sh <node> <carpeta app>
set -euo pipefail

NODE="$1"; APP="$2"
WORK="$(mktemp -d)"
# En Windows (Git Bash) node.exe necesita rutas de Windows, no /tmp/...
NATIVE_WORK="$WORK"
if command -v cygpath >/dev/null; then NATIVE_WORK="$(cygpath -m "$WORK")"; fi
PORT=5091
printf 'PORT=%s\nHOST=127.0.0.1\nAPP_NAME=Prueba\n' "$PORT" > "$WORK/.env"

if [ -e "$APP/node_modules/.bin/claude.cmd" ]; then CLAUDE="$APP/node_modules/.bin/claude.cmd"; else CLAUDE="$APP/node_modules/.bin/claude"; fi
# La app de escritorio no lo lleva dentro: se instala desde Ajustes
if [ -e "$CLAUDE" ]; then echo "Claude Code: $("$CLAUDE" --version)"; else echo "Claude Code: no incluido (se instala desde la app)"; fi

ZER0CODE_DATA_DIR="$NATIVE_WORK/data" ZER0CODE_ENV_FILE="$NATIVE_WORK/.env" "$NODE" "$APP/server/index.js" > "$WORK/server.log" 2>&1 &
PID=$!
# Esperar al servidor evita desmontar el .dmg mientras su ejecutable sigue abierto.
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:$PORT/manifest.json" -o "$WORK/manifest.json"; then break; fi
  sleep 1
done
cat "$WORK/server.log"
grep -q '"name":"Prueba"' "$WORK/manifest.json" || { echo "El servidor no responde como debería"; exit 1; }
[ -f "$WORK/data/auth.json" ] || { echo "No ha creado los datos en ZER0CODE_DATA_DIR"; exit 1; }
echo "Prueba superada"
