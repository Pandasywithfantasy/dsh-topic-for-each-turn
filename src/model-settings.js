import { validateSettings } from './settings-store.js';
// The provider catalog is read from the official llm-pi-ai entry. The plugin
// never stores credentials: it reuses whichever provider route the user already
// configured in DSH, and persists only its own model choice in its own file
// because the Config entry is owned by a profile `insert:` patch row.
export const PROVIDERS_NS = 'llm-pi-ai';
export function providerCatalog(settings) {
  const providers = settings?.get?.(PROVIDERS_NS)?.providers ?? {};
  return Object.entries(providers)
    .map(([id, profile]) => ({ id, models: (profile?.models ?? []).map(m => ({ id: m.id, name: m.name ?? m.id, reasoningEfforts: Object.keys(m.reasoningEfforts ?? {}) })) }));
}
export function modelSettingsState(settings, config, stored, version) {
  const providers = providerCatalog(settings);
  return {
    hostVersion: version, stored: Boolean(stored), writable: providers.length > 0,
    configured: Boolean(config.provider && config.model),
    config: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, maxTokens: config.maxTokens }, providers
  };
}
export async function saveModelSettings({ settings, store, payload }) {
  const providers = providerCatalog(settings);
  if (!providers.length) throw new Error('当前DSH未提供可读的模型配置，无法校验服务商与模型');
  const { provider, model, reasoningEffort, maxTokens } = payload ?? {};
  const entry = providers.find(p => p.id === provider)?.models.find(m => m.id === model);
  if (!entry) throw new Error('请选择DSH已配置的服务商和模型；新模型请先在DSH模型设置中添加');
  if (typeof reasoningEffort !== 'string' || reasoningEffort !== '' && !entry.reasoningEfforts.includes(reasoningEffort)) throw new Error('此模型不支持所选推理强度，请选择自动');
  if (!Number.isInteger(maxTokens) || maxTokens < 80 || maxTokens > 4096) throw new Error('输出上限必须为80至4096之间的整数');
  const next = validateSettings({ version: 1, provider, model, reasoningEffort, maxTokens });
  await store.save(next);
  return next;
}
