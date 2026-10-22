import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelSettingsState, saveModelSettings, providerCatalog } from '../src/model-settings.js';
import { SettingsStore, effectiveConfig, validateSettings } from '../src/settings-store.js';
import { failureError } from '../src/llm-error.js';
import { settingsBridge } from '../src/settings-bridge.js';

const catalog = { providers: { base: { models: [{ id: 'demo-model-1', reasoningEfforts: { low: 'low' } }] }, other: { models: [{ id: 'other', reasoningEfforts: {} }] } } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'topic-settings-'));
  const store = new SettingsStore(root);
  const settings = settingsBridge({ describe: () => [{ ns: 'llm-pi-ai', value: catalog }] });
  return { store, settings };
}
test('model settings live in the plugin store and reuse the configured provider catalog', async () => {
  const { store, settings } = await fixture();
  const config = { provider: '', model: '', reasoningEffort: 'low', maxTokens: 480, continuity: true };
  assert.equal(modelSettingsState(settings, config, undefined, 'v').configured, false);
  const saved = await saveModelSettings({ settings, store, payload: { provider: 'base', model: 'demo-model-1', reasoningEffort: 'low', maxTokens: 1024 } });
  assert.deepEqual(saved, { provider: 'base', model: 'demo-model-1', reasoningEffort: 'low', maxTokens: 1024 });
  assert.deepEqual(await store.read(), saved);
  assert.equal(JSON.parse(await readFile(store.path(), 'utf8')).version, 1);
  assert.deepEqual(effectiveConfig(config, await store.read()), { ...config, provider: 'base', model: 'demo-model-1', maxTokens: 1024 });
  assert.deepEqual(effectiveConfig(config, undefined), config);
  const state = modelSettingsState(settings, effectiveConfig(config, saved), saved, 'v');
  assert.equal(state.writable, true); assert.equal(state.stored, true); assert.equal(state.configured, true); assert.equal(state.config.model, 'demo-model-1');
  // No credentials or endpoints may reach the browser.
  assert.doesNotMatch(JSON.stringify(state), /baseURL|apiKey|apiKeyEnv/);
  assert.equal(providerCatalog(settings).length, 2);
});
test('invalid choices are refused, nothing is written, and an unreadable store is reported', async () => {
  const { store, settings } = await fixture();
  const payload = { provider: 'base', model: 'demo-model-1', reasoningEffort: 'low', maxTokens: 1024 };
  for (const patch of [{ model: 'nope' }, { reasoningEffort: 'ultra' }, { maxTokens: 1 }, { maxTokens: 480.5 }]) await assert.rejects(saveModelSettings({ settings, store, payload: { ...payload, ...patch } }));
  assert.equal(await store.read(), undefined);
  assert.throws(() => validateSettings({ version: 2 }), /格式不兼容/);
  const empty = settingsBridge({ describe: () => [] });
  assert.equal(modelSettingsState(empty, payload, undefined, 'v').writable, false);
  await assert.rejects(saveModelSettings({ settings: empty, store, payload: { ...payload, reasoningEffort: '' } }), /未提供可读的模型配置/);
  const error = failureError({ failure: { code: 'INVALID_REQUEST', status: 400, message: 'sensitive detail' } });
  assert.match(error.message, /模型名或请求参数/); assert.doesNotMatch(error.message, /sensitive detail|API Key无效/);
});
