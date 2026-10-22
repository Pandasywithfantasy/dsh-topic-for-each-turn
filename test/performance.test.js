import test from 'node:test';
import assert from 'node:assert/strict';
import { TopicEngine, extractTurns } from '../src/core.js';

// A long session log is expensive to read (22 MB / 8k events measured on a real
// desktop session), so these tests pin the paths that must not re-read it.
const event = (type, seq, data) => ({ type, seq, data });
function log(turn = 1, offset = 0) {
  return [
    event('turn/start', offset, { turn }),
    event('user/message', offset + 1, { source: { kind: 'user' }, content: [{ type: 'text', text: '问题' + turn }] }),
    event('assistant/message', offset + 2, { message: { content: [{ type: 'text', text: '回答' + turn }] } }),
    event('turn/end', offset + 3, { turn, reason: { kind: 'completed' } })
  ];
}
const result = { topic: '核验加载性能', summary: '已核验。' };

function fixture({ events = [...log(1, 0), ...log(2, 4)], token = 'token-1' } = {}) {
  const items = [];
  const store = { read: async () => structuredClone(items), save: async (_id, next) => { items.splice(0, items.length, ...structuredClone(next)); } };
  let reads = 0;
  let sessionToken = async () => token;
  const engine = new TopicEngine({
    store,
    readSession: async id => { reads++; return { session: { id }, inheritedEventCount: 0, events: structuredClone(events) }; },
    readTurns: async () => { reads++; return extractTurns(events); },
    extractTurns: list => extractTurns(list),
    sessionToken: id => sessionToken(id),
    generate: async () => result
  });
  return { engine, store, items, events, get reads() { return reads; }, set token(fn) { sessionToken = fn; } };
}

test('state reads the session once, then answers an unchanged revision without reading', async () => {
  const f = fixture();
  const full = await f.engine.state('s1');
  assert.equal(f.reads, 1, 'prepare and turn extraction share one snapshot');
  assert.equal(full.items.length, 2);
  assert.ok(full.revision);
  const same = await f.engine.state('s1', full.revision);
  assert.deepEqual(same, { unchanged: true, revision: full.revision });
  assert.equal(f.reads, 1, 'an idle poll must not touch the log');
  // A stale revision with the same token still answers from the cached turns.
  const cached = await f.engine.state('s1', 'stale-revision');
  assert.equal(cached.items.length, 2); assert.equal(f.reads, 1, 'refreshing after an edit reuses cached turns');
  // A new turn changes the token, so the next read is real.
  f.events.push(...log(3, 8));
  f.token = async () => 'token-2';
  const changed = await f.engine.state('s1', cached.revision);
  assert.equal(changed.items.length, 3); assert.equal(f.reads, 2);
});

test('a running job reports progress without re-sending items', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture();
  f.engine.generate = async () => { await gate; return result; };
  const baseline = await f.engine.state('s1');
  const running = f.engine.start('s1');
  await new Promise(resolve => setImmediate(resolve));
  const progress = await f.engine.state('s1', baseline.revision);
  assert.equal(progress.jobOnly, true);
  assert.notEqual(progress.revision, baseline.revision);
  assert.equal(progress.items, undefined);
  assert.equal(f.reads, 2, 'one read for the baseline state, one for the job start');
  release(); await running; await f.engine.idle();
});

test('generation verifies the source through the token instead of re-reading the log', async () => {
  const f = fixture({ events: log(1, 0) });
  await f.engine.start('s1'); await f.engine.idle();
  assert.equal(f.reads, 1, 'only the initial read; no per-turn re-read');
  assert.equal(f.items.length, 1);
});

test('a changed token still discards a stale generation result', async () => {
  const f = fixture({ events: log(1, 0) });
  let version = 'v1';
  f.token = async () => version;
  f.engine.generate = async () => { version = 'v2'; return result; };
  f.engine.readTurns = async () => extractTurns([{ ...log(1, 0)[1], data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改写后的问题' }] } }]);
  await f.engine.start('s1'); await f.engine.idle();
  assert.equal(f.items.length, 0, 'content changed during generation, so the result is dropped');
});
