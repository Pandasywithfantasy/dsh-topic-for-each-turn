import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../src/core.js';
import { BatchOrganizer } from '../src/batch.js';
import { failureError } from '../src/llm-error.js';
import * as modelSettings from '../src/model-settings.js';
import * as settingsStore from '../src/settings-store.js';
import * as settingsCompatibility from '../src/settings-bridge.js';

test('client uses official header and right-sidebar registrations; disposes effects', async () => {
  const entries = [], effects = [], types = [], opens = []; let plugin;
  const React = { createElement: (tag, props, ...children) => ({ tag, props, children }) };
  const document = { head: { appendChild() {} }, createElement: () => ({ remove() {} }) };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: definition => { plugin = definition.factory(() => React); } } }, document, setTimeout, clearTimeout, console });
  const ctx = { connection: {}, sessions: {}, uiConversation: {}, sidebarRight: { openTabIn: (...args) => opens.push(args) }, sidebarRightTabs: { register: def => { types.push(def); return () => {}; } },
    effect: fn => { const dispose = fn(); if (dispose) effects.push(dispose); }, slots: { inject: (_name, fn) => fn(), register: (options, component) => { entries.push({ options, component }); return () => {}; } } };
  plugin.apply(ctx);
  assert.deepEqual(types.map(x => x.kind), ['turn-topics']);
  // 0.2.1 把 `id` 用作正文/标题插槽的 key，并要求 kind 声明优先级档；两版都接受这些字段。
  const [type] = types;
  assert.equal(type.id, 'dsh-topic-for-each-turn/topics');
  assert.equal(type.priority, 'extension');
  assert.equal(type.title(), '轮次主题');
  // Arrays built inside the vm context carry another realm's prototype, so compare rendered text.
  assert.equal(Array.from(type.guide, x => `${x.id}:${x.order}`).join('|'), `${type.id}:80`);
  assert.equal(type.guide[0].title(), '轮次主题');
  assert.match(type.guide[0].description(), /主题/);
  assert.deepEqual(entries.map(x => x.options.name), ['settings.section', 'conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
  assert.equal(entries[0].options.id, 'turn-topic-outline');
  assert.equal(entries[3].options.key, type.id, 'title seat key must equal the registered type id');
  assert.equal(entries[3].component({}).children[0], '轮次主题');
   const button = entries[1].component({ sessionId: 's1' }); button.props.onClick(); assert.deepEqual(opens[0], ['s1', 'turn-topics']);
  effects.reverse().forEach(fn => fn());
});

test('a runtime that rejects unknown registration fields still opens the panel', async () => {
  const entries = [], effects = [], opens = [], warnings = []; let plugin;
  const React = { createElement: (tag, props, ...children) => ({ tag, props, children }) };
  const document = { head: { appendChild() {} }, createElement: () => ({ remove() {} }) };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: definition => { plugin = definition.factory(() => React); } } }, document, setTimeout, clearTimeout, console });
  // 0.2.0-rc.2 accepted a three-field definition; a stricter host rejects `priority` and `guide`.
  const accepted = [];
  const ctx = { connection: {}, sessions: {}, uiConversation: {}, sidebarRight: { openTabIn: (...args) => opens.push(args) },
    logger: { warn: message => warnings.push(message) },
    sidebarRightTabs: { register: def => { const extra = Object.keys(def).filter(k => !['id', 'kind', 'title'].includes(k)); if (extra.length > 0) throw new Error(`unknown fields: ${extra}`); accepted.push(def); return () => {}; } },
    effect: fn => { const dispose = fn(); if (dispose) effects.push(dispose); }, slots: { inject: (_name, fn) => fn(), register: (options, component) => { entries.push({ options, component }); return () => {}; } } };
  plugin.apply(ctx);
  // The fallback keeps the tab type registered, so the panel body has a matching kind.
  assert.deepEqual(accepted.map(x => x.kind), ['turn-topics']);
  assert.deepEqual(Object.keys(accepted[0]).sort(), ['id', 'kind', 'title']);
  // It first drops only keepMounted, then falls back to the three-field form.
  assert.match(warnings.join('\n'), /省略 keepMounted/);
  assert.match(warnings.join('\n'), /兼容声明/);
  const button = entries[1].component({ sessionId: 's9' }); button.props.onClick(); assert.deepEqual(opens[0], ['s9', 'turn-topics']);
  assert.deepEqual(entries.map(x => x.options.name), ['settings.section', 'conversation.session.header.utilities', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
});

test('host RPC errors contained, turn/end queues automatically, no session append', async () => {
  const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const root = await mkdtemp(join(tmpdir(), 'dsh-topic-host-test-'));
  const z = { boolean: () => ({ default: () => ({}) }), object: x => x, string: () => ({ default: () => ({}) }), number: () => ({ min() { return this; }, max() { return this; }, default() { return {}; } }) };
  let host, handler, rpc, calls = 0, timeoutFailure = false;
  class Assembler { push(chunk) { this.finish = chunk.reason; } blocks() { return [{ type: 'text', text: '{"topic":"核验官方轮次接口","summary":"已核验事件与主题接口。"}' }]; } }
  vm.runInNewContext(source + '\n globalThis.host = {apply, inject};', { ...core, ...modelSettings, ...settingsStore, ...settingsCompatibility, failureError, BatchOrganizer, z, BlockAssembler: Assembler, createUserMessage: x => x, dshHomePath: () => root, AbortSignal, Date, globalThis: host = {} });
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查接口' }] } }, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }];
  let dispose;
  host.host.apply({ sessions: {}, sessionQuery: { readSession: async () => ({ events }) }, webServer: {}, connection: { register: (owner, _path, fn) => { assert.ok(owner.webServer, 'RPC channel requires owner.webServer'); assert.ok(host.host.inject.includes('webServer'), 'webServer must be declared in inject'); rpc = fn; } }, on: (_name, fn) => handler = fn, logger: { warn() {} }, effect: fn => dispose = fn(), llm: { async *stream(options) { calls++; if (timeoutFailure) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } assert.equal(options.reasoningEffort, 'low'); assert.equal(options.purpose, 'turn-topic'); assert.ok(!options.tools); yield { type: 'finish', reason: { kind: 'stop' } }; } } }, { provider: 'test', model: 'test', reasoningEffort: 'low', maxTokens: 240, maxInputChars: 12000, timeoutMs: 30000 });
  assert.equal((await rpc('state', { sessionId: '../bad' })).ok, false);
  assert.equal((await rpc('state', { sessionId: 's1' })).value.items[0].generated, false); assert.equal(calls, 0);
   const compatibility = (await rpc('state', { sessionId: 's1' })).value;
   assert.equal(compatibility.apiVersion, 2); assert.ok(compatibility.capabilities.includes('organize')); assert.ok(compatibility.capabilities.includes('edit-text'));
  handler({ id: 's1', snapshotEvents: () => events, append() { throw new Error('must not append'); } }, events.at(-1));
  // Await the asynchronous queue through its persisted result, with a bounded test timeout.
  let state; for (let i = 0; i < 100; i++) { state = (await rpc('state', { sessionId: 's1' })).value; if (!state.job.running && state.items[0].generated) break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal(state.items[0].generated, true); assert.equal(calls, 1);
   for (let repeat = 0; repeat < 2; repeat++) {
     assert.equal((await rpc('organize', { sessionId: 's1' })).ok, true);
     for (let i = 0; i < 100; i++) { state = (await rpc('state', { sessionId: 's1' })).value; if (!state.job.running) break; await new Promise(r => setTimeout(r, 5)); }
   }
   assert.equal(calls, 1, 'organize skips already generated valid entries');
   assert.equal((await rpc('edit', { sessionId: 's1', seq: 0, patch: { topic: '用户修改的标题', summary: '用户修改的详情。' } })).ok, true);
   await rpc('organize', { sessionId: 's1' });
   for (let i = 0; i < 100; i++) { state = (await rpc('state', { sessionId: 's1' })).value; if (!state.job.running) break; await new Promise(r => setTimeout(r, 5)); }
   assert.equal(calls, 1); assert.equal(state.items[0].topic, '用户修改的标题'); assert.equal(state.items[0].summary, '用户修改的详情。');
   timeoutFailure = true; await rpc('generate', { sessionId: 's2' });
   for (let i = 0; i < 100; i++) { state = (await rpc('state', { sessionId: 's2' })).value; if (!state.job.running) break; await new Promise(r => setTimeout(r, 5)); }
   assert.equal(state.items[0].status, 'failed'); assert.match(state.items[0].error, /模型请求超过 30 秒/);
   assert.match(state.items[0].error, /已保留其他主题/); dispose();
});
