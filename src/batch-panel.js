// Embedded next to the settings panel; no session mount or automatic model call.
function createBatchPanel(React, h) {
  return function BatchPanel({ call, enabled }) {
    const lifetime = React.useRef(null);
    if (!lifetime.current || lifetime.current.call !== call || lifetime.current.enabled !== enabled) {
      if (lifetime.current) lifetime.current.alive = false;
      lifetime.current = { call, enabled, alive: true, pending: false, revision: 0 };
    }
    const token = lifetime.current;
    const empty = () => ({ token, state: null, error: '', pollError: '', pending: false, confirmed: false });
    const [stored, setStored] = React.useState(empty);
    const view = stored.token === token ? stored : empty();
    const { state, error, pollError, pending, confirmed } = view;
    const current = () => token.alive && lifetime.current === token;
    const update = patch => { if (current()) setStored(previous => ({ ...(previous.token === token ? previous : empty()), ...patch })); };
    React.useEffect(() => {
      if (!enabled) return;
      token.alive = true;
      let timer;
      const read = async () => {
        const revision = token.revision;
        try {
          if (!token.pending) {
            const value = await call('batch-state', null);
            if (current() && revision === token.revision) update({ state: value, pollError: '' });
          }
        } catch (e) { if (current() && revision === token.revision) update({ pollError: String(e?.message ?? '无法读取全局整理状态') }); }
        finally { if (current()) timer = setTimeout(read, 2000); }
      };
      void read();
      return () => { token.alive = false; clearTimeout(timer); };
    }, [token]);
    const action = async endpoint => {
      if (token.pending || !current() || (endpoint === 'batch-start' && !confirmed)) return;
      token.pending = true; token.revision++; update({ pending: true, error: '' });
      try { const value = await call(endpoint, null); update({ state: value, confirmed: false }); }
      catch (e) { update({ error: String(e?.message ?? '全局整理失败') }); }
      finally { if (current()) { token.pending = false; update({ pending: false }); } }
    };
    if (!enabled) return null;
    const running = state?.running === true;
    return h('section', { style: { display: 'grid', gap: 12 }, 'aria-label': '全局轮次主题整理' },
      h('h3', null, '全局整理'),
      h('p', { className: 'topic-note' }, '整理所有未归档的普通对话和分支，仅补齐尚未生成或已失效的主题；跳过有效主题与人工修改。最多同时整理 3 个会话，每个会话按轮次顺序处理。'),
      !running && h('label', { style: { display: 'flex', alignItems: 'start', gap: 8 } },
        h('input', { type: 'checkbox', checked: confirmed, disabled: pending, onChange: event => update({ confirmed: event.target.checked }) }),
        '我确认将未整理轮次的问答发送至当前主题模型，可能产生费用。'),
      h('button', { type: 'button', className: 'topic-btn topic-btn-primary', disabled: pending || !state || (!running && !confirmed), onClick: () => { void action(running ? 'batch-cancel' : 'batch-start'); } }, pending ? '正在提交…' : running ? '停止全局整理' : '整理全部未归档对话'),
      state && h('div', { role: 'status', 'aria-live': 'polite' },
        state.phase === 'listing' ? '正在读取会话列表…' : state.phase === 'stopping' ? '正在停止，已保存结果会保留。' :
        `会话 ${state.completed}/${state.sessions} · 已生成 ${state.turns} 轮 · 跳过 ${state.skipped} 个会话 · 会话错误 ${state.failed}${state.phase === 'cancelled' ? ' · 已停止' : state.phase === 'finished' ? ' · 已完成' : ''}`),
      state?.running && state.sessions > 0 && h('progress', { max: state.sessions, value: state.completed + state.skipped, 'aria-label': '全局整理进度', style: { width: '100%' } }),
      (error || pollError) && h('div', { role: 'alert', className: 'topic-alert topic-alert-error' }, error || pollError),
      state?.errors?.length > 0 && h('details', null, h('summary', null, '查看错误（最多显示 20 项）'), h('ul', null, state.errors.map((item, index) => h('li', { key: index }, `${item.sessionId ?? '会话列表'}：${item.message}`))))
    );
  };
}
