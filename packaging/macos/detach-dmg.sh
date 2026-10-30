#!/usr/bin/env bash
# Desmonta el volumen temporal de una prueba; macOS puede tardar en liberarlo.
set -euo pipefail

MOUNT="${1:?Falta el punto de montaje temporal}"
for attempt in 1 2 3; do
  if hdiutil detach "$MOUNT"; then exit 0; fi
  if [ "$attempt" -lt 3 ]; then sleep 2; fi
done

# La prueba ya ha terminado y este volumen solo contiene el instalador de CI.
hdiutil detach -force "$MOUNT"
