import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsBridge, liveValue } from '../src/settings-bridge.js';
test('catalog reads adapt from namespace get to redacted entry describe', () => {
  const described = settingsBridge({ describe: options => { assert.equal(options.redactSecrets, true); return [{ ns: 'llm-pi-ai', value: { providers: { base: { models: [{ id: 'm' }] } } } }, { ns: 'topic-for-each-turn', value: {} }]; } });
  assert.equal(described.get('llm-pi-ai').providers.base.models[0].id, 'm');
  assert.equal(described.get('missing'), undefined);
  const legacy = settingsBridge({ get: ns => ({ ns }) });
  assert.equal(legacy.get('llm-pi-ai').ns, 'llm-pi-ai');
  assert.equal(settingsBridge(undefined), undefined);
});
test('writes go only to the addressed namespace and need no installSection', async () => {
  const calls = [];
  const bridge = settingsBridge({ describe: () => [], update: async (...a) => calls.push(['update', ...a]), mutate: async (...a) => calls.push(['mutate', ...a]) });
  await bridge.update('turn-topic-outline', { model: 'x' });
  await bridge.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'topic-key-1'] }]);
  assert.deepEqual(calls.map(c => [c[0], c[1]]), [['update', 'turn-topic-outline'], ['mutate', 'llm-pi-ai']]);
  let value = 'old'; assert.equal(liveValue({ get: () => value }), 'old'); value = 'new'; assert.equal(liveValue({ get: () => value }), 'new');
  assert.equal(liveValue('plain'), 'plain');
});
