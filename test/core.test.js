import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTurns, parseResult, TopicStore, TopicEngine, bounded, sessionId } from '../src/core.js';
const event = (type, seq, data) => ({ type, seq, data });
function log(turn = 1, offset = 0) {
  return [event('turn/start', offset, { turn }), event('user/message', offset + 1, { source: { kind: 'user' }, content: [{ type: 'text', text: '修复轮次导航问题' }] }), event('assistant/message', offset + 2, { message: { content: [{ type: 'text', text: '已修复并测试。' }] } }), event('turn/end', offset + 3, { turn, reason: { kind: 'completed' } })];
}
const result = { topic: '修复对话轮次导航', summary: '已修复轮次导航并完成测试。' };
async function setup(generate = async () => result, events = log()) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-topics-test-'));
  const store = new TopicStore(root); const ref = { events };
  const engine = new TopicEngine({ store, readTurns: async () => extractTurns(ref.events), generate });
  return { engine, store, ref, root };
}
test('extracts only ended real user turns, ignores tool and synthetic text', () => {
  const events = log(); events.splice(1, 0, event('user/message', 99, { source: { kind: 'system' }, content: [{ type: 'text', text: 'ignore me' }] }));
  events.splice(4, 0, event('assistant/message', 100, { message: { content: [{ type: 'tool-call' }] } }));
  const turns = extractTurns([...events, event('turn/start', 10, { turn: 2 })]);
  assert.equal(turns.length, 1); assert.equal(turns[0].seq, 0); assert.equal(turns[0].input.answer, '已修复并测试。');
});
test('uses latest text assistant and retains cancellation reason', () => {
  const events = log(); events.splice(3, 0, event('assistant/message', 3, { message: { content: [{ type: 'text', text: '尚未验证' }] } })); events.at(-1).data.reason.kind = 'aborted';
  assert.equal(extractTurns(events)[0].input.answer, '尚未验证'); assert.equal(extractTurns(events)[0].input.endReason, 'aborted');
});
test('input bounded, fingerprint changes on source edits', () => {
  const events = log(); const original = extractTurns(events)[0].fingerprint;
  events[2].data.message.content[0].text = 'x'.repeat(10000);
  const turn = extractTurns(events, 1000)[0]; assert.notEqual(turn.fingerprint, original); assert.ok(JSON.stringify(turn.input).length < 1100);
  assert.ok(bounded('x'.repeat(100), 50).length <= 50);
});
test('strict output validation accepts text and rejects markdown/invalid schema/control chars', () => {
  assert.deepEqual(parseResult(JSON.stringify(result)), result);
  for (const raw of ['```json\n{}\n```', '{}', '{"topic":"","summary":"x"}', JSON.stringify({ topic: 'x'.repeat(41), summary: 's' }), JSON.stringify({ topic: 'x\u0000', summary: 's' })]) assert.throws(() => parseResult(raw));
});
test('rejects traversal and malformed session ids', () => { for (const id of ['../evil', 'a/b', '', null, 'CON:']) assert.throws(() => sessionId(id)); });
test('atomic cache roundtrip and malformed cache rejection', async () => {
  const { store, engine } = await setup(); await engine.start('s1'); await engine.idle();
  assert.equal((await store.read('s1'))[0].topic, result.topic); assert.deepEqual(await store.read('absent'), []);
  const data = JSON.parse(await readFile(store.path('s1'), 'utf8')); assert.equal(data.version, 1); assert.ok(!JSON.stringify(data).includes('修复轮次导航问题'));
  await writeFile(store.path('s1'), '{"version":99}'); await assert.rejects(store.read('s1'));
});
test('opening state never triggers a generation', async () => {
  let calls = 0; const { engine } = await setup(async () => { calls++; return result; });
  const state = await engine.state('s1'); assert.equal(state.items[0].generated, false); assert.equal(calls, 0);
});
test('failed turn is identifiable and manual retry preserves completed topics', async () => {
  let calls = 0, fail = true;
  const { engine } = await setup(async turn => { calls++; if (turn.turn === 2 && fail) throw new Error('模型请求超过 90 秒'); return result; }, [...log(), ...log(2, 4)]);
  await engine.start('s1'); await engine.idle();
  const state = await engine.state('s1');
  assert.equal(state.items[0].status, 'generated'); assert.equal(state.items[1].status, 'failed');
  assert.equal(state.items[1].topic, '待生成主题'); assert.equal(state.items[1].preview, '修复轮次导航问题');
  assert.match(state.items[1].error, /90 秒/); assert.match(state.job.error, /第 2 轮/);
  fail = false; await engine.start('s1'); await engine.idle();
  assert.equal(calls, 3); assert.equal((await engine.state('s1')).items[1].status, 'generated');
  assert.equal((await engine.state('s1')).items[1].error, undefined);
});
test('missing preview uses only the beginning without head-tail splice', async () => {
  const events = log(); events[1].data.content[0].text = '前'.repeat(100) + '末尾内容';
  const { engine } = await setup(undefined, events); const item = (await engine.state('s1')).items[0];
  assert.equal(item.status, 'missing'); assert.equal(item.topic, '待生成主题');
  assert.equal(item.preview, '前'.repeat(49) + '…');
});
test('manual backfill fills missing entries once and automatic generation scopes one turn', async () => {
  let calls = 0; const { engine } = await setup(async () => { calls++; return result; }, [...log(), ...log(2, 4)]);
  await engine.start('s1', 4); await engine.idle(); assert.equal(calls, 1); assert.equal((await engine.state('s1')).items[0].generated, false);
  await engine.start('s1'); await engine.idle(); assert.equal(calls, 2);
  await engine.start('s1'); await engine.idle(); assert.equal(calls, 2);
});
test('content edits invalidate cached topic', async () => {
  const { engine, ref } = await setup(); await engine.start('s1'); await engine.idle(); ref.events[1].data.content[0].text = 'changed'; assert.equal((await engine.state('s1')).items[0].generated, false);
});
test('explicit single-worker mode stays serial; failures are isolated and retry is manual', async () => {
  let inFlight = 0, max = 0, calls = 0;
  const { engine } = await setup(async () => { inFlight++; max = Math.max(max, inFlight); await Promise.resolve(); inFlight--; if (++calls === 1) throw new Error('test failure'); return result; });
  engine.concurrency = 1;
  await Promise.all([engine.start('s1'), engine.start('s2')]); await engine.idle(); assert.equal(max, 1); assert.equal((await engine.state('s1')).job.failed, 1); assert.equal((await engine.state('s2')).items[0].generated, true);
  await engine.start('s1'); await engine.idle(); assert.equal((await engine.state('s1')).items[0].generated, true);
});
test('new turn arriving during a running job is not dropped', async () => {
  let release; const gate = new Promise(r => release = r); let entered;
  const ready = new Promise(r => entered = r); let calls = 0;
  const { engine, ref } = await setup(async () => { if (++calls === 1) { entered(); await gate; } return result; });
  await engine.start('s1', 0); await ready; ref.events.push(...log(2, 4)); await engine.start('s1', 4); release(); await engine.idle(); assert.equal(calls, 2);
});
test('manual refill during automatic generation is honored', async () => {
  let release, entered; const gate = new Promise(r => release = r), ready = new Promise(r => entered = r); let calls = 0;
  const { engine } = await setup(async () => { if (++calls === 1) { entered(); await gate; } return result; }, [...log(), ...log(2, 4)]);
  await engine.start('s1', 4); await ready; await engine.start('s1'); release(); await engine.idle(); assert.equal(calls, 2);
});
test('new automatic turn arriving during initial read is retained', async () => {
  let release, entered; const gate = new Promise(r => release = r), ready = new Promise(r => entered = r);
  const { engine, ref } = await setup(); const read = engine.readTurns; let reads = 0;
  engine.readTurns = async id => { const turns = await read(id); if (++reads === 1) { entered(); await gate; } return turns; };
  await engine.start('s1', 0); await ready; ref.events.push(...log(2, 4)); await engine.start('s1', 4); release(); await engine.idle();
  assert.equal((await engine.state('s1')).items.filter(x => x.generated).length, 2);
});
test('cancel prevents persistence, dispose prevents new requests', async () => {
  let release, entered; const gate = new Promise(r => release = r), ready = new Promise(r => entered = r);
  const { engine, store } = await setup(async () => { entered(); await gate; return result; });
  await engine.start('s1'); await ready; engine.cancel('s1'); release(); await engine.idle(); assert.deepEqual(await store.read('s1'), []);
  engine.dispose(); await assert.rejects(engine.start('s1'));
});
