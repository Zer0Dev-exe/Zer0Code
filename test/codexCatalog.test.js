import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexCatalog } from '../server/codexCatalog.js';

async function fixture(t, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-catalog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'codex');
  await writeFile(binary, `#!${process.execPath}\nconst rl = require('node:readline').createInterface({input:process.stdin});\nrl.on('line', line => { const req=JSON.parse(line); const reply=result=>console.log(JSON.stringify({id:req.id,result})); ${body} });`, { mode: 0o700 });
  return binary;
}

test('initializes, reads every page, excludes hidden models and deduplicates', async t => {
  const bin = await fixture(t, `
    if(req.method==='initialize') reply({});
    if(req.method==='model/list') {
      if(!req.params.cursor) reply({data:[{model:'first',displayName:'First',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:'hidden',hidden:true}],nextCursor:'page2'});
      else reply({data:[{model:'first'},{model:'second',isDefault:true}],nextCursor:null});
    }`);
  const models = await readCodexCatalog(bin);
  assert.deepEqual(models.map(m=>m.slug), ['first', 'second']);
  assert.equal(models[0].supported_reasoning_levels[0].reasoningEffort, 'high');
  assert.equal(models[1].isDefault, true);
});

test('rejects protocol errors instead of returning a fabricated model', async t => {
  const bin = await fixture(t, `if(req.id) console.log(JSON.stringify({id:req.id,error:{message:'Unavailable'}}));`);
  await assert.rejects(readCodexCatalog(bin), /Unavailable/);
});

test('stops an unresponsive CLI', async t => {
  const bin = await fixture(t, '');
  await assert.rejects(readCodexCatalog(bin, {timeout:100}), /timed out/);
});

test('rejects repeated pagination cursors', async t => {
  const bin = await fixture(t, `if(req.method==='initialize') reply({}); if(req.method==='model/list') reply({data:[{model:'first'}],nextCursor:'same'});`);
  await assert.rejects(readCodexCatalog(bin), /Repeated/);
});
