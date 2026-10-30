import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Analizador acotado al YAML de workflows: conserva la sangría e ignora comentarios
// y cuerpos de escalares multilínea (por ejemplo, scripts de run: |).
function lineasYaml(texto) {
  const lineas = [];
  let bloque = null;
  for (const [indice, original] of texto.split(/\r?\n/).entries()) {
    if (!original.trim() || /^\s*#/.test(original)) continue;
    const sangria = original.match(/^ */)[0].length;
    if (bloque !== null && sangria > bloque) continue;
    bloque = null;
    const lista = /^\s*-\s+/.test(original);
    const contenido = original.trim().replace(/^-\s+/, '');
    lineas.push({ numero: indice + 1, sangria, lista, contenido });
    if (/^[\w-]+:\s*[|>][\d+-]*\s*(?:#.*)?$/.test(contenido)) {
      bloque = sangria + (lista ? 2 : 0);
    }
  }
  return lineas;
}

test('los workflows mantienen las garantías de seguridad de GitHub Actions', async () => {
  const directorio = new URL('../.github/workflows/', import.meta.url);
  const archivos = (await readdir(directorio)).filter(nombre => nombre.endsWith('.yml')).sort();
  const errores = [];
  assert.ok(archivos.length, '.github/workflows/:1: no se encontraron workflows .yml');

  for (const archivo of archivos) {
    const lineas = lineasYaml(await readFile(new URL(archivo, directorio), 'utf8'));
    const error = (linea, mensaje) => errores.push(`.github/workflows/${archivo}:${linea}: ${mensaje}`);
    if (!lineas.some(l => l.sangria === 0 && /^(?:permissions|'permissions'|"permissions")\s*:/.test(l.contenido))) {
      error(1, 'falta permissions: en el nivel superior');
    }

    let enEventos = false;
    for (const [indice, linea] of lineas.entries()) {
      const { contenido, sangria, numero } = linea;
      if (sangria === 0) enEventos = /^(?:on|'on'|"on")\s*:/.test(contenido);
      if (enEventos && /(?:^|[\s\[,{:'"])pull_request_target(?=$|[\s\]},:'"#])/.test(contenido.replace(/\s+#.*$/, ''))) {
        error(numero, 'el evento pull_request_target está prohibido');
      }

      const uso = contenido.match(/^(?:uses|'uses'|"uses")\s*:\s*(.*?)\s*$/);
      if (!uso) continue;
      const valor = uso[1].replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
      if (valor.startsWith('./') || valor.startsWith('docker://')) continue;
      if (!/^[\w.-]+\/[\w./-]+@[a-f\d]{40}$/i.test(valor)
          || !/\s+#\s+v\d[^\s]*\s*$/.test(uso[1])) {
        error(numero, 'la acción externa debe fijarse a un SHA de 40 hexadecimales y llevar un comentario # v…');
      }
      if (!/^actions\/checkout@/i.test(valor)) continue;

      // El bloque pertenece al paso completo: uses: puede ir antes o después de with:.
      let inicio = indice;
      while (inicio >= 0 && !(lineas[inicio].lista && lineas[inicio].sangria <= sangria)) inicio--;
      const paso = lineas[inicio];
      let fin = indice + 1;
      while (fin < lineas.length && lineas[fin].sangria > (paso?.sangria ?? sangria)) fin++;
      const propiedades = lineas.slice(inicio + 1, fin);
      if (paso) propiedades.unshift({ ...paso, sangria: paso.sangria + 2 });
      const con = propiedades.find(l => l.sangria === paso?.sangria + 2 && /^with:\s*(?:#.*)?$/.test(l.contenido));
      const posicion = propiedades.indexOf(con);
      let credenciales = false;
      if (con) {
        for (const hija of propiedades.slice(posicion + 1)) {
          if (hija.sangria <= con.sangria) break;
          if (hija.sangria === con.sangria + 2 && /^persist-credentials:\s*false\s*(?:#.*)?$/.test(hija.contenido)) credenciales = true;
        }
      }
      if (!credenciales) error(numero, 'actions/checkout debe declarar persist-credentials: false en su bloque with:');
    }
  }
  assert.equal(errores.length, 0, `Incumplimientos de seguridad:\n${errores.join('\n')}`);
});
