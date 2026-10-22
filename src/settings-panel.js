// Embedded by the build inside the client factory; deliberately no module imports/exports.
// Rendered as a page of the official settings surface, so it follows the same
// metrics as DSH's own settings pages: 20px page title, cards separated by
// hairlines, 36px controls, label above control, hint below at 12px.
function createSettingsPanel(React, h, UI = {}) {
  const Button = UI.Button ?? function FallbackButton({ variant = 'ghost', size = 'md', className, children, ...rest }) {
    const tone = variant === 'primary' ? ' topic-btn-primary' : variant === 'outline' ? ' topic-btn-outline' : '';
    return h('button', { type: 'button', ...rest, className: `topic-btn${tone}${size === 'sm' ? ' topic-btn-sm' : ''}${className ? ' ' + className : ''}` }, children);
  };
  const BatchPanel = createBatchPanel(React, h, UI);
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
    const configured = state?.configured === true;
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
    const field = (label, id, control, hint) => h('div', { className: 'topic-field' },
      h('label', { className: 'topic-field-label', htmlFor: id }, label),
      control,
      hint && h('p', { className: 'topic-field-hint', id: `${id}-hint` }, hint)
    );
    const status = busy ? (view.pending === 'settings-save' ? '正在保存设置…' : '正在加载配置…')
      : !state ? '配置尚未加载，请重新加载。'
      : !writable ? '当前配置不可写，已禁用保存。'
      : !configured ? '尚未选择模型：选好服务商与模型后保存，主题生成才会开始。'
      : !valid ? '请选择服务商和模型，并填写 80–4096 之间的整数。'
      : dirty ? '有未保存的更改。' : '设置未更改，无需保存。';
    const summary = configured ? `${draft.provider} · ${draft.model}` : '未配置';

    return h('div', { className: 'dsh-turn-topics topic-settings-page' },
      h('header', { className: 'topic-page-head' },
        h('h2', null, '轮次主题'),
        h('p', { className: 'topic-page-desc' }, '为每个已结束的轮次生成主题与结论。仅影响轮次主题请求，不修改聊天默认模型；服务商与模型来自当前 DSH 已配置的列表，插件不保存密钥。')
      ),
      h('section', { className: 'topic-card', 'aria-labelledby': 'topic-model-head' },
        h('div', { className: 'topic-card-head' },
          h('div', null, h('h3', { id: 'topic-model-head' }, '模型'), h('p', { className: 'topic-card-desc' }, '选择用于生成标题与结论的模型；保存后下一次主题请求即生效。')),
          state && h('span', { className: 'topic-badge' + (configured ? '' : ' is-empty') }, summary)
        ),
        view.error && h('div', { className: 'topic-alert topic-alert-error', role: 'alert' }, h('span', null, view.error)),
        view.notice && h('div', { className: 'topic-alert topic-alert-success', role: 'status' },
          h('span', null, view.notice),
          h('button', { type: 'button', className: 'topic-alert-close', 'aria-label': '关闭提示', onClick: () => update({ notice: '' }) }, '×')
        ),
        state && !writable && h('div', { className: 'topic-alert topic-alert-warn', role: 'status' }, '当前 DSH 未提供可读的模型配置。请先在 DSH 模型设置中添加服务商，再回到这里选择。'),
        state && writable && !configured && h('div', { className: 'topic-alert', role: 'status' }, '选好服务商与模型后点「保存设置」，主题生成才会开始。'),
        h('form', { className: 'topic-form', onSubmit: submit, noValidate: true },
          h('div', { className: 'topic-form-grid' },
            field('服务商', 'topic-provider', h('select', {
              id: 'topic-provider', className: 'topic-input topic-select', value: draft.provider, disabled, 'aria-describedby': 'topic-provider-hint',
              onChange: event => {
                const provider = event.target.value;
                change({ provider, model: modelsFor(state, provider)[0]?.id || '', reasoningEffort: '' });
              }
            },
              !draft.provider && h('option', { value: '' }, '请选择服务商'),
              draft.provider && !providers.some(item => item.id === draft.provider) && h('option', { value: draft.provider }, `${draft.provider}（未列出）`),
              ...providers.map(item => h('option', { key: item.id, value: item.id }, item.id))
            ), '来自 DSH 已配置的模型服务商。'),
            field('模型', 'topic-model', h('select', {
              id: 'topic-model', className: 'topic-input topic-select', value: draft.model, disabled, 'aria-describedby': 'topic-model-hint',
              onChange: event => {
                const model = event.target.value;
                const nextEfforts = effortsFor(state, { ...draft, model });
                change({ model, reasoningEffort: nextEfforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : '' });
              }
            },
              !draft.model && h('option', { value: '' }, '请选择模型'),
              draft.model && !models.some(item => item.id === draft.model) && h('option', { value: draft.model }, `${draft.model}（未列出）`),
              ...models.map(item => h('option', { key: item.id, value: item.id }, item.name || item.id))
            ), '每个轮次调用一次该模型。'),
            field('推理强度', 'topic-effort', h('select', {
              id: 'topic-effort', className: 'topic-input topic-select', value: efforts.includes(draft.reasoningEffort) ? draft.reasoningEffort : '',
              disabled: disabled || efforts.length === 0, 'aria-describedby': 'topic-effort-hint', onChange: event => change({ reasoningEffort: event.target.value })
            },
              h('option', { value: '' }, '自动'),
              ...efforts.map(value => h('option', { key: value, value }, value))
            ), efforts.length ? '选项以当前模型支持的推理强度为准。' : '当前模型未声明推理强度，使用「自动」。'),
            field('最大输出 Token', 'topic-max-tokens', h('input', {
              id: 'topic-max-tokens', className: 'topic-input', type: 'number', min: 80, max: 4096, step: 1, required: true, 'aria-describedby': 'topic-max-tokens-hint',
              value: draft.maxTokens, disabled, onChange: event => change({ maxTokens: event.target.value })
            }), '80–4096 的整数，默认 1024。')
          ),
          draft.model && !models.some(item => item.id === draft.model) && h('p', { className: 'topic-alert topic-alert-warn', role: 'status' }, '当前模型不在服务商模型列表中，已保留配置；请确认该模型名受支持。'),
          h('div', { className: 'topic-card-foot' },
            h('p', { className: 'topic-form-status', role: 'status', 'aria-live': 'polite' }, status),
            h('div', { className: 'topic-card-actions' },
              h(Button, { variant: 'outline', size: 'sm', disabled: busy || typeof call !== 'function', onClick: () => { void request('settings-state'); } }, view.pending === 'settings-state' ? '正在加载…' : '重新加载'),
              h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: disabled || !dirty || !valid }, view.pending === 'settings-save' ? '正在保存…' : '保存设置')
            )
          ),
          h('p', { className: 'topic-card-hint' }, '重新加载会丢弃未保存的更改。INVALID_REQUEST 表示模型名或参数不受支持，不直接表示密钥失效。')
        )
      ),
      h(BatchPanel, { call, enabled: state?.batchSupported === true }),
      h('footer', { className: 'topic-page-foot' },
        state?.hostVersion ? `后台 ${state.hostVersion}` : '后台版本未知',
        UI.version ? ` · 前端 ${UI.version}` : ''
      )
    );
  };
}
