#!/usr/bin/env bash
# Prepara la aplicación lista para empaquetar en <destino>:
#   <destino>/app      -> servidor, web y dependencias de producción (sin enlaces simbólicos)
#   <destino>/runtime  -> el ejecutable de Node con el que se ha instalado (mismo sistema y arquitectura)
# Se ejecuta en el mismo sistema para el que se empaqueta: Claude Code trae un binario nativo por plataforma.
# Con --no-runtime no copia Node (la app de escritorio usa el que lleva Electron).
# Con --no-ai-tools no incluye Claude Code, Codex ni Gemini CLI (dependencias opcionales, más de 700 MB):
# la app de escritorio los instala desde Ajustes cuando hacen falta.
# Uso: bash packaging/stage-app.sh <destino> [--no-runtime] [--no-ai-tools]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?Uso: stage-app.sh <destino> [--no-runtime] [--no-ai-tools]}"
WITH_RUNTIME=1
WITH_AI_TOOLS=1
for arg in "${@:2}"; do
  case "$arg" in
    --no-runtime) WITH_RUNTIME=0 ;;
    --no-ai-tools) WITH_AI_TOOLS=0 ;;
    *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
  esac
done

rm -rf "$DEST"
mkdir -p "$DEST/app" "$DEST/runtime"
cd "$ROOT"
cp -R server public package.json pnpm-lock.yaml pnpm-workspace.yaml .env.example LICENSE "$DEST/app/"

# node-linker=hoisted: node_modules plano, sin enlaces de pnpm (Inno Setup y algunos zip no los soportan)
if [ "$WITH_AI_TOOLS" = 1 ]; then
  (cd "$DEST/app" && pnpm install --prod --frozen-lockfile --config.node-linker=hoisted)

  # Claude Code copia su binario nativo (~280 MB) del paquete de plataforma a bin/ al instalarse:
  # el paquete de plataforma sobra y duplicaría el tamaño del instalador
  CLAUDE_BIN="$DEST/app/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
  if [ "$(wc -c < "$CLAUDE_BIN")" -gt 1000000 ]; then
    rm -rf "$DEST/app/node_modules/@anthropic-ai/"claude-code-*
  else
    echo "Claude Code no ha instalado su binario nativo (¿se ha saltado su postinstall?)" >&2
    exit 1
  fi
else
  (cd "$DEST/app" && pnpm install --prod --frozen-lockfile --no-optional --config.node-linker=hoisted)
  for pkg in @anthropic-ai/claude-code @openai/codex @google/gemini-cli; do
    if [ -e "$DEST/app/node_modules/$pkg" ]; then echo "No debería incluir $pkg" >&2; exit 1; fi
  done
fi

if [ "$WITH_RUNTIME" = 1 ]; then
  NODE_BIN="$(node -p 'process.execPath')"
  cp "$NODE_BIN" "$DEST/runtime/"
else
  rmdir "$DEST/runtime"
fi
echo "App preparada en $DEST (Node $(node -v), $(node -p 'process.platform + "-" + process.arch'))"
