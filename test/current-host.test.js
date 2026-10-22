import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/core.js';
import * as bridge from '../src/settings-bridge.js';
import * as models from '../src/model-settings.js';
import * as stores from '../src/settings-store.js';
import { failureError } from '../src/llm-error.js';
import { BatchOrganizer } from '../src/batch.js';
// Reproduces the reported failure: the plugin Config entry is owned by a profile
// `insert:` patch row, so the current Host exposes describe-only reads there and
// refuses every settings write for that entry id. Model settings must therefore
// save without touching the settings service at all.
test('current Host that refuses entry writes still boots, registers RPC, and saves model settings to the plugin store', async () => {
  const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const schema = () => ({ default() { return this; }, min() { return this; }, max() { return this; } });
  const z = { object: x => x, string: schema, number: schema, boolean: schema };
  const root = await mkdtemp(join(tmpdir(), 'topic-current-host-'));
  const box = { ...core, ...bridge, ...models, ...stores, failureError, BatchOrganizer, z, AbortSignal, BlockAssembler: class {}, createUserMessage: x => x, dshHomePath: () => root };
  vm.runInNewContext(source + '\nglobalThis.hostApply=apply;', box);
  let rpc, documentWrite = 0;
  const effects = [];
  let model = 'demo-model-1';
  const refusal = () => { documentWrite++; throw new Error('Configuration for "topic-for-each-turn" is overridden by a home patch or command-line overlay'); };
  const raw = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: { base: { models: [{ id: 'demo-model-1', reasoningEfforts: { low: 'low' } }, { id: 'other' }] } } } }],
    update: async () => refusal(), mutate: async () => refusal()
  };
  const ctx = { settings: raw, sessionQuery: { readSession: async () => ({ events: [] }) }, llm: {}, connection: { register: (_owner, path, fn) => { assert.equal(path, '/turn-topic-outline'); rpc = fn; } }, on() {}, effect: fn => effects.push(fn()), logger: { warn() {} } };
  box.hostApply(ctx, { provider: { get: () => 'base' }, model: { get: () => model }, reasoningEffort: { get: () => 'low' }, maxTokens: { get: () => 1024 }, continuity: true, maxInputChars: 12000, timeoutMs: 90000 });
  assert.equal(typeof rpc, 'function');
  const state = await rpc('settings-state', {});
  assert.equal(state.ok, true); assert.equal(state.value.config.provider, 'base'); assert.equal(state.value.config.model, 'demo-model-1');
  assert.equal(state.value.stored, false); assert.equal(state.value.batchSupported, true);
  assert.equal((await rpc('batch-state', { sessionId: null })).value.phase, 'idle');
  assert.equal((await rpc('batch-start', { sessionId: null })).ok, true);
  for (let i=0;i<20;i++) { if (!(await rpc('batch-state', {})).value.running) break; await new Promise(r=>setImmediate(r)); }
  const unavailable=(await rpc('batch-state', {})).value; assert.equal(unavailable.running,false); assert.match(unavailable.errors[0].message,/归档状态/);
  ctx.workspaceRegistry = { archivedSessionIds: [] };
  let releaseList; ctx.sessionQuery.listSessions = () => new Promise(resolve => { releaseList = resolve; });
  await rpc('batch-start', {}); await new Promise(r=>setImmediate(r));
  const blockedSave = await rpc('settings-save', { provider:'base',model:'other',reasoningEffort:'',maxTokens:1024 });
  assert.equal(blockedSave.ok,false); assert.match(blockedSave.error.message,/停止或等待/);
  releaseList([]);
  for (let i=0;i<20;i++) { if (!(await rpc('batch-state', {})).value.running) break; await new Promise(r=>setImmediate(r)); }
  assert.equal((await rpc('batch-state', {})).value.phase,'finished');
  const saving = rpc('settings-save', { provider: 'base', model: 'other', reasoningEffort: '', maxTokens: 1024 });
  const overlapping = await rpc('organize', { sessionId: 's1' });
  assert.equal(overlapping.ok, false); assert.match(overlapping.error.message, /正在保存/);
  const saved = await saving;
  assert.equal(saved.ok, true, saved.error?.message);
  assert.equal(saved.value.config.model, 'other'); assert.equal(saved.value.stored, true);
  assert.equal(documentWrite, 0, 'model save must not write through the settings service');
  model = 'other';
  const reread = await rpc('settings-state', {});
  assert.equal(reread.value.config.model, 'other'); assert.equal(reread.value.stored, true);
  assert.equal((await rpc('keys-state', {})).ok, false, 'credential-management endpoints are gone in the publishable build');
  const persisted = JSON.parse(await readFile(join(root, 'model-settings.json'), 'utf8'));
  assert.deepEqual(persisted, { version: 1, provider: 'base', model: 'other', reasoningEffort: '', maxTokens: 1024 });
  assert.equal((await rpc('settings-save', { provider: 'base', model: 'nope', reasoningEffort: '', maxTokens: 1024 })).ok, false);
  const capabilities = (await rpc('state', { sessionId: 's1' })).value.capabilities;
  assert.equal(capabilities.includes('key-pool'), false); assert.equal(capabilities.includes('batch-organize'), true);
  effects.reverse().forEach(f => f?.());
});

test('an unconfigured install still loads and asks for a model instead of failing', async () => {
  const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const schema = () => ({ default() { return this; }, min() { return this; }, max() { return this; } });
  const z = { object: x => x, string: schema, number: schema, boolean: schema };
  const root = await mkdtemp(join(tmpdir(), 'topic-unconfigured-'));
  const box = { ...core, ...bridge, ...models, ...stores, failureError, BatchOrganizer, z, AbortSignal, BlockAssembler: class {}, createUserMessage: x => x, dshHomePath: () => root };
  vm.runInNewContext(source + '\nglobalThis.hostApply=apply;', box);
  let rpc, effects = [];
  const raw = { describe: () => [{ ns: 'llm-pi-ai', value: { providers: { base: { models: [{ id: 'm1' }] } } } }], update: async () => { throw new Error('must not write'); }, mutate: async () => { throw new Error('must not write'); } };
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] } }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }];
  const ctx = { settings: raw, sessionQuery: { readSession: async () => ({ session: { id: 's1' }, inheritedEventCount: 0, events }) }, llm: {}, connection: { register: (_owner, _path, fn) => { rpc = fn; } }, on() {}, effect: fn => effects.push(fn()), logger: { warn() {} } };
  assert.doesNotThrow(() => box.hostApply(ctx, { provider: { get: () => '' }, model: { get: () => '' }, reasoningEffort: { get: () => '' }, maxTokens: { get: () => 1024 }, continuity: true, maxInputChars: 12000, timeoutMs: 90000 }));
  const state = await rpc('settings-state', {});
  assert.equal(state.ok, true); assert.equal(state.value.configured, false); assert.equal(state.value.writable, true);
  assert.equal(state.value.providers[0].models[0].id, 'm1', 'catalog of the user own DSH models is offered');
  await rpc('generate', { sessionId: 's1' });
  let job; for (let i = 0; i < 50; i++) { job = (await rpc('state', { sessionId: 's1' })).value.job; if (!job.running) break; await new Promise(r => setImmediate(r)); }
  assert.match(job.error, /尚未配置主题模型/);
  effects.reverse().forEach(f => f?.());
});
