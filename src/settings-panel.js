// Embedded by the build inside the client factory; deliberately no module imports/exports.
function createSettingsPanel(React, h) {
  const BatchPanel = createBatchPanel(React, h);
  const empty = scope => ({ scope, state: null, draft: null, saved: null, pending: '', error: '', notice: '' });
  const modelsFor = (state, provider) => (state.providers || []).find(item => item.id === provider)?.models || [];
  const effortsFor = (state, draft) => {
    const model = modelsFor(state, draft.provider).find(item => item.id === draft.model);
    return Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.filter(value => typeof value === 'string' && value) : [];
  };
  // A fresh install has no model chosen yet. Offer the first provider/model the
  // user already configured in DSH so one save is enough to start working.
  const configFor = state => {
    const config = state.config || {};
    const draft = { provider: config.provider || '', model: config.model || '', reasoningEffort: config.reasoningEffort || '', maxTokens: String(config.maxTokens ?? 1024) };
    if (!draft.provider) {
      const providers = state.providers || [], first = providers[0];
      if (first) { draft.provider = first.id; draft.model = first.models?.[0]?.id ?? ''; draft.reasoningEffort = ''; }
    }
    if (!effortsFor(state, draft).includes(draft.reasoningEffort)) draft.reasoningEffort = '';
    return draft;
  };
  const equal = (left, right) => left && right && ['provider', 'model', 'reasoningEffort', 'maxTokens'].every(key => left[key] === right[key]);

  return function TopicSettings({ call }) {
    const scopeRef = React.useRef(null);
    if (!scopeRef.current || scopeRef.current.call !== call) {
      if (scopeRef.current) scopeRef.current.alive = false;
      scopeRef.current = { call, alive: true, version: 0, edits: 0, pending: false };
    }
    const scope = scopeRef.current;
    const [stored, setStored] = React.useState(() => empty(scope));
    const view = stored.scope === scope ? stored : empty(scope);
    const current = () => scopeRef.current === scope && scope.alive;
    const update = patch => {
      if (current()) setStored(previous => ({ ...(previous.scope === scope ? previous : empty(scope)), ...patch }));
    };
    const request = async (endpoint, payload = {}) => {
      if (!current() || typeof call !== 'function' || scope.pending) return;
      scope.pending = true;
      const version = ++scope.version, edits = scope.edits;
      update({ pending: endpoint, error: '', notice: '' });
      try {
        const state = await call(endpoint, null, payload);
        if (!current() || scope.version !== version) return;
        const saved = configFor(state);
        // Do not let an older read/save replace input entered after that request began.
        update({ state, saved, ...(scope.edits === edits ? { draft: saved } : {}), notice: endpoint === 'settings-save' ? '已保存，后续主题请求使用新设置' : '' });
      } catch (error) {
        if (current() && scope.version === version) update({ error: String(error?.message || '设置请求失败，请重试。') });
      } finally {
        if (current() && scope.version === version) { scope.pending = false; update({ pending: '' }); }
      }
    };
    React.useEffect(() => {
      scope.alive = true;
      void request('settings-state');
      return () => { scope.alive = false; scope.version += 1; scope.pending = false; };
    }, [scope]);

    const state = view.state;
    const draft = view.draft || { provider: '', model: '', reasoningEffort: '', maxTokens: '' };
    const providers = state?.providers || [];
    const models = state ? modelsFor(state, draft.provider) : [];
    const efforts = state ? effortsFor(state, draft) : [];
    const busy = Boolean(view.pending);
    const writable = state?.writable === true;
    const dirty = Boolean(state?.configured !== true || (view.draft && !equal(view.draft, view.saved)));
    const valid = Boolean(draft.provider && draft.model && Number.isInteger(Number(draft.maxTokens)) && Number(draft.maxTokens) >= 80 && Number(draft.maxTokens) <= 4096);
    const disabled = !writable || busy;
    const change = patch => {
      if (!current() || !writable || scope.pending) return;
      scope.edits += 1;
      update({ draft: { ...draft, ...patch }, notice: '', error: '' });
    };
    const submit = event => {
      event.preventDefault();
      if (!writable || busy || !dirty || !valid) return;
      void request('settings-save', { provider: draft.provider, model: draft.model, reasoningEffort: efforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : '', maxTokens: Number(draft.maxTokens) });
    };
    const field = (label, control, note) => h('label', { className: 'topic-form-field' }, h('span', { className: 'topic-form-label' }, label), control, note && h('span', { className: 'topic-note' }, note));
    const status = busy ? (view.pending === 'settings-save' ? '正在保存设置…' : '正在加载配置…')
      : !state ? '配置尚未加载，请重新加载。'
      : !writable ? '当前配置不可写，已禁用保存。'
      : state.configured !== true ? '尚未选择模型：选好服务商与模型后保存，主题生成才会开始。'
      : !valid ? '请选择服务商和模型，并填写 80–4096 之间的整数。'
      : dirty ? '有未保存的更改。' : '设置未更改，无需保存。';

    return h('div', { className: 'dsh-turn-topics topic-settings-page', style: { display: 'grid', gap: 16, maxWidth: 640, padding: 16 } },
      h('h2', null, '轮次主题'),
      h('p', { className: 'topic-note' }, '全局设置，无需打开会话；仅影响轮次主题请求，不修改聊天默认模型。'),
      h('p', { className: 'topic-note' }, '服务商与模型来自当前 DSH 已配置的模型列表，直接复用其凭证，无需在此填写密钥。'),
      h('p', { className: 'topic-note' }, '保存后写入插件自己的设置文件，覆盖 profile 补丁中的默认值；聊天默认模型与 profile 补丁本身不会被修改。'),
      h('section', { style: { display: 'grid', gap: 12 }, 'aria-busy': busy },
        h('h3', null, '模型设置'),
        state?.hostVersion && h('p', { className: 'topic-note' }, `后台版本：${state.hostVersion}`),
        view.error && h('div', { className: 'topic-alert topic-alert-error', role: 'alert' }, `错误：${view.error}`),
        view.notice && h('div', { className: 'topic-alert', role: 'status' }, h('span', null, `✓ ${view.notice}`), h('button', { type: 'button', className: 'topic-alert-close', 'aria-label': '关闭提示', onClick: () => update({ notice: '' }) }, '×')),
        state && !writable && h('div', { className: 'topic-alert topic-alert-warn', role: 'status' }, '⚠ 当前配置不可写，仍可重新加载。'),
        h('form', { onSubmit: submit, style: { display: 'grid', gap: 12 } },
          field('服务商', h('select', { className: 'topic-input', value: draft.provider, disabled, onChange: event => {
            const provider = event.target.value;
            const model = modelsFor(state, provider)[0]?.id || '';
            change({ provider, model, reasoningEffort: '' });
          } },
            !draft.provider && h('option', { value: '' }, '请选择服务商'),
            draft.provider && !providers.some(item => item.id === draft.provider) && h('option', { value: draft.provider }, `${draft.provider}（当前未列出）`),
            ...providers.map(item => h('option', { key: item.id, value: item.id }, item.id))
          )),
          field('模型', h('select', { className: 'topic-input', value: draft.model, disabled, onChange: event => {
            const model = event.target.value;
            const nextEfforts = effortsFor(state, { ...draft, model });
            change({ model, reasoningEffort: nextEfforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : '' });
          } },
            !draft.model && h('option', { value: '' }, '请选择模型'),
            draft.model && !models.some(item => item.id === draft.model) && h('option', { value: draft.model }, `${draft.model}（当前未列出）`),
            ...models.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id))
          )),
          draft.model && !models.some(item => item.id === draft.model) && h('div', { className: 'topic-alert topic-alert-warn', role: 'status' }, '⚠ 当前模型未列在服务商模型列表中，已保留配置；请确认该模型名受支持。'),
          field('推理强度', h('select', { className: 'topic-input', value: efforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : '', disabled: disabled || efforts.length === 0, onChange: event => change({ reasoningEffort: event.target.value }) },
            h('option', { value: '' }, '自动'),
            ...efforts.map(value => h('option', { key: value, value }, value))
          ), efforts.length ? '选项以当前模型支持的推理强度为准。' : '当前模型未声明推理强度支持，使用自动并保存空值。'),
          field('最大输出 Token 数', h('input', { className: 'topic-input', type: 'number', min: 80, max: 4096, step: 1, required: true, value: draft.maxTokens, disabled, onChange: event => change({ maxTokens: event.target.value }) }), '80–4096，必须为整数。'),
          h('p', { className: 'topic-note', role: 'status', 'aria-live': 'polite' }, status),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            h('button', { type: 'submit', className: 'topic-btn topic-btn-primary', disabled: disabled || !dirty || !valid }, view.pending === 'settings-save' ? '正在保存…' : '保存设置'),
            h('button', { type: 'button', className: 'topic-btn', disabled: busy || typeof call !== 'function', onClick: () => { void request('settings-state'); } }, view.pending === 'settings-state' ? '正在加载…' : '重新加载配置')
          ),
          h('p', { className: 'topic-note' }, '重新加载配置会丢弃未保存的更改。'),
          h('p', { className: 'topic-note' }, 'INVALID_REQUEST 表示模型名或参数不受支持，不直接表示密钥失效。')
        )
      ),
      h(BatchPanel, { call, enabled: state?.batchSupported === true })
    );
  };
}
