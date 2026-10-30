import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../public/js/markdown.js';

test('Markdown: elimina HTML peligroso y conserva el contenido permitido', async (t) => {
  const dom = new JSDOM('');
  const anterior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = dom.window;
  dom.window.marked = marked;
  dom.window.DOMPurify = createDOMPurify(dom.window);
  // Los scripts clásicos del navegador también exponen estos nombres globales.
  const globals = ['marked', 'DOMPurify'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  globalThis.marked = marked;
  globalThis.DOMPurify = dom.window.DOMPurify;
  t.after(() => {
    for (const [key, descriptor] of [...globals, ['window', anterior]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  });

  for (const [nombre, entrada, selector, atributo] of [
    ['evento onerror', '<img src=x onerror=alert(1)>', 'img', 'onerror'],
    ['script', '<script>alert(1)</script>', 'script'],
    ['URL javascript', '[abrir](javascript:alert%281%29)', 'a', 'href'],
    ['iframe', '<iframe src="https://example.com"></iframe>', 'iframe'],
    ['formulario', '<form><input><button>Enviar</button></form>', 'form, input, button'],
    ['estilo en atributo', '<p style="color:red">Texto</p>', 'p', 'style'],
    ['etiqueta style', '<style>body { display:none }</style>', 'style']
  ]) {
    await t.test(nombre, () => {
      const html = renderMarkdown(entrada);
      const fragment = JSDOM.fragment(html);
      if (atributo) {
        const elemento = fragment.querySelector(selector);
        assert.ok(elemento, 'se conserva el elemento permitido');
        assert.equal(elemento.hasAttribute(atributo), false, html);
      } else assert.equal(fragment.querySelector(selector), null, html);
    });
  }

  await t.test('conserva negrita, listas, código, tablas y enlaces HTTPS', () => {
    const entrada = '**Negrita**\n\n- Uno\n- Dos\n\n`const x = 1`\n\n```js\nconst y = 2;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Web](https://example.com)';
    const html = renderMarkdown(entrada);
    assert.equal(html, marked.parse(entrada));
    const fragment = JSDOM.fragment(html);
    for (const selector of ['strong', 'ul li', 'code', 'pre code.language-js', 'table tbody td', 'a[href="https://example.com"]']) {
      assert.ok(fragment.querySelector(selector), selector);
    }
  });

  for (const libreria of ['marked', 'DOMPurify']) {
    await t.test(`sin ${libreria} devuelve texto escapado`, () => {
      const original = dom.window[libreria];
      delete dom.window[libreria];
      try {
        assert.equal(renderMarkdown('<img onerror="x"> & \' **texto**'), '&lt;img onerror=&quot;x&quot;&gt; &amp; &#039; **texto**');
        assert.equal(renderMarkdown(null), '');
      } finally {
        dom.window[libreria] = original;
      }
    });
  }
});
