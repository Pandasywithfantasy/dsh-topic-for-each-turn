import z from '@deepseek-ai/schemastery';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { TopicStore, TopicEngine, extractTurns, parseResult, SYSTEM, sessionId } from './core.js';
import { failureError } from './llm-error.js';
import { modelSettingsState, saveModelSettings } from './model-settings.js';
import { SettingsStore, effectiveConfig } from './settings-store.js';
import { settingsBridge, liveValue } from './settings-bridge.js';
import { BatchOrganizer } from './batch.js';

export const name = 'topic-for-each-turn';
export const HOST_VERSION = '0.1.0-experimental.15';
export const API_VERSION = 2;
// connection.register reads owner.webServer; declare it on the owning plugin context.
export const inject = ['connection', 'webServer', 'sessions', 'sessionQuery', 'llm', 'settings'];
export const Config = z.object({
  // Empty by default: a published plugin must not assume the author's routes.
  // The user picks an already-configured DSH provider and model in the settings page.
  provider: z.string().default(''), model: z.string().default(''),
  reasoningEffort: z.string().default('low'), maxTokens: z.number().min(80).max(4096).default(1024), continuity: z.boolean().default(true),
  maxInputChars: z.number().min(1000).max(40000).default(12000), timeoutMs: z.number().min(1000).max(120000).default(90000)
});
export function apply(ctx, config) {
  // An unconfigured plugin still loads: the settings page must be reachable so
  // the user can choose a model. Generation is what refuses to run until then.
  const defaults = () => Object.fromEntries(Object.entries(config).map(([key, value]) => [key, liveValue(value)]));
  const store = new SettingsStore(dshHomePath('storages', 'turn-topic-outline'));
  let stored, loadError = '';
  const ready = store.read().then(value => { stored = value; }, error => { loadError = error.message; ctx.logger.warn('无法读取轮次主题模型设置：' + error.message); });
  let current = () => effectiveConfig(defaults(), stored);
  const settings = settingsBridge(ctx.get?.('settings') ?? ctx.settings);
  let configurationWrite = null;
  const mutateConfiguration = work => {
    if (configurationWrite) throw new Error('模型设置正在保存，请稍后重试');
    const task = Promise.resolve().then(work);
    configurationWrite = task;
    void task.finally(() => { if (configurationWrite === task) configurationWrite = null; }).catch(() => {});
    return task;
  };
  const engine = new TopicEngine({
    continuity: current().continuity !== false,
    store: new TopicStore(dshHomePath('storages', 'turn-topic-outline')),
    readTurns: async id => extractTurns((await ctx.sessionQuery.readSession(id)).events, current().maxInputChars),
    readSession: id => ctx.sessionQuery.readSession(id),
    concurrency: 3,
    generate: async (turn, id, signal) => {
      const requestConfig = { ...current() };
      if (!requestConfig.provider || !requestConfig.model) throw new Error('尚未配置主题模型：请打开 DSH「设置 → 轮次主题」，选择已配置的服务商与模型并保存');
      const timeout = AbortSignal.timeout(requestConfig.timeoutMs);
      const deadline = AbortSignal.any([signal, timeout]);
      try {
       const assembler = new BlockAssembler();
      try { for await (const chunk of ctx.llm.stream({ provider: requestConfig.provider, model: requestConfig.model,
        ...(requestConfig.reasoningEffort ? { reasoningEffort: requestConfig.reasoningEffort } : {}), maxTokens: requestConfig.maxTokens, system: SYSTEM,
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ ...turn.input, context: turn.context }) }], source: { kind: 'dsh-topic-for-each-turn' } })],
        sessionId: id, purpose: 'turn-topic', signal: deadline })) { deadline.throwIfAborted(); assembler.push(chunk); } }
      catch (e) { if (e.name === 'TimeoutError') throw e; deadline.throwIfAborted(); throw failureError({ failure: e.failure ?? { code: e.code, status: e.status } }); }
      deadline.throwIfAborted();
      if (assembler.finish?.kind === 'error') throw failureError(assembler.finish);
       if (assembler.finish?.kind !== 'stop') throw new Error('总结未正常结束：' + (assembler.finish?.kind ?? 'missing-finish'));
      const blocks = assembler.blocks();
      if (blocks.some(b => b.type === 'tool-call')) throw new Error('总结模型返回了工具调用');
      const raw = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
       const parsed = JSON.parse(raw.trim());
       return { ...parseResult(raw), subjects: parsed.subjects, relation: parsed.relation };
      } catch (e) {
        if (signal.aborted) throw e;
        if (timeout.aborted || e.name === 'TimeoutError') throw new Error(`模型请求超过 ${Math.round(requestConfig.timeoutMs / 1000)} 秒；已保留其他主题，请点击整理主题重试`);
        throw e;
      }
    }
  });
  const batch = new BatchOrganizer({
    engine,
    listSessions: signal => ctx.sessionQuery.listSessions(signal),
    archivedIds: () => {
      const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
      if (!registry || !Array.isArray(registry.archivedSessionIds)) throw new Error('无法读取官方归档状态，已停止全局整理');
      return registry.archivedSessionIds;
    }
  });
  const preparing = new Set();
  ctx.on('session/created', session => {
    const task = ready.then(() => engine.prepare(session.id)).catch(() => ctx.logger.warn('分支主题继承未完成，打开面板时可重试'));
    preparing.add(task); void task.finally(() => preparing.delete(task));
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    const start = session.snapshotEvents().findLast(e => e.type === 'turn/start' && e.data.turn === event.data.turn);
    if (start) void ready.then(async () => { if (configurationWrite) await configurationWrite; return engine.start(session.id, start.seq); }).catch(() => ctx.logger.warn('无法排队生成轮次主题'));
  });
  ctx.connection.register(ctx, '/turn-topic-outline', async (endpoint, payload) => {
    try {
      await ready;
      if (configurationWrite && ['batch-start', 'generate', 'organize', 'enrich'].includes(endpoint)) throw new Error('模型或 Key 设置正在保存，请稍后重试整理');
      if (endpoint === 'batch-state') return { ok: true, value: batch.state() };
      if (endpoint === 'batch-start') return { ok: true, value: batch.start() };
      if (endpoint === 'batch-cancel') return { ok: true, value: batch.cancel() };
      if (endpoint === 'settings-state') return { ok: true, value: { ...modelSettingsState(settings, current(), stored, HOST_VERSION), loadError, batchSupported: true } };
      if (endpoint === 'settings-save') {
        if (batch.state().running || [...engine.jobs.values()].some(job => job.status.running)) throw new Error('请先停止或等待主题任务结束，再修改模型');
        await mutateConfiguration(async () => {
          stored = await saveModelSettings({ settings, store, payload });
          loadError = '';
        });
        return { ok: true, value: { ...modelSettingsState(settings, current(), stored, HOST_VERSION), batchSupported: true } };
      }
      const id = sessionId(payload?.sessionId);
       if (endpoint === 'state') return { ok: true, value: { ...await engine.state(id), hostVersion: HOST_VERSION, apiVersion: API_VERSION, capabilities: ['organize', 'edit-text', 'incremental-organize', 'fork-inheritance', 'batch-organize'] } };
      if (endpoint === 'generate') { await ctx.sessionQuery.readSession(id); return { ok: true, value: await engine.start(id) }; }
      if (endpoint === 'organize') { return { ok: true, value: await engine.start(id) }; }
      if (endpoint === 'enrich') { return { ok: true, value: await engine.start(id, undefined, true) }; }
      if (endpoint === 'edit') { return { ok: true, value: await engine.edit(id, payload.seq, payload.patch ?? {}) }; }
      if (endpoint === 'cancel') return { ok: true, value: engine.cancel(id) };
      throw new Error('不支持此主题操作：请重新加载插件或完整退出并重新打开 DSH');
    } catch (e) { return { ok: false, error: { code: 'turn-topic/failed', message: e.message, details: {} } }; }
  });
  ctx.effect(() => async () => { batch.dispose(); engine.dispose(); await batch.idle(); await engine.idle(); await Promise.all(preparing); await configurationWrite?.catch(() => {}); });
}
