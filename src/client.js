window.__ModuleLoader__.load({
  id: 'dsh-topic-for-each-turn',
  factory: require => {
    const React = require('react'), h = React.createElement;
    const ID = 'dsh-topic-for-each-turn/topics', KIND = 'turn-topics';
    const CLIENT_VERSION = '0.1.0-experimental.15';
    const UPGRADE_MESSAGE = '主题插件前端与后台版本不一致，后台尚未加载整理接口。请完整退出并重新打开 DSH，随后刷新此页面；仅刷新页面不能更新后台。已有主题会保留。';
    /* PREVIEW_ADAPTER */
    /* SETTINGS_PANEL */
    const TopicSettings = createSettingsPanel(React, h);
    function apply(ctx) {
      const call = async (endpoint, sessionId, payload = {}) => {
        let result;
        try { result = await ctx.connection.rpc.call('/turn-topic-outline', endpoint, { ...payload, sessionId }); }
        catch (error) {
          if (/HTTP (404|405)\b/.test(String(error?.message))) throw new Error('主题插件后台接口未注册或加载失败（HTTP 404/405）。请确认已安装修复版并重新加载后台；仅刷新页面无效。这不是模型或凭证配置错误。');
          throw error;
        }
        if (!result.ok) {
          const message = result.error?.message ?? '主题请求失败';
          if (/未知主题接口|不支持此主题操作/.test(message)) throw new Error(UPGRADE_MESSAGE);
          throw new Error(message);
        }
        return result.value;
      };
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'turn-topic-outline', label: () => '轮次主题', order: 75
      }, () => h(TopicSettings, { call })));
      let previewAdapter;
      let previewEnabled = true;
      try { previewEnabled = window.localStorage?.getItem('dsh-turn-topic-preview') !== 'off'; } catch {}
      ctx.effect(() => {
        if (typeof MutationObserver === 'undefined' || !document.body) return;
        previewAdapter = installPreview({ document, Observer: MutationObserver, call });
        previewAdapter.setEnabled(previewEnabled);
        return () => previewAdapter.dispose();
      });
      const activeJumps = new Map();
      async function jump(sessionId, item) {
        const token = {}; activeJumps.set(sessionId, token);
        const binding = ctx.sessions.binding(sessionId);
        if (!binding) { activeJumps.delete(sessionId); throw new Error('会话未加载'); }
        const until = Date.now() + 15000;
        try {
          while (Date.now() < until) {
            if (activeJumps.get(sessionId) !== token) return;
            await binding.session.loadThrough(item.seq);
            if (activeJumps.get(sessionId) !== token) return;
            const snapshot = ctx.uiConversation.binding(binding).target('chat').getSnapshot();
            const nav = snapshot?.navigation.items().find(x => x.turn === item.turn);
            if (nav) {
              const root = [...document.querySelectorAll('[data-conversation-session]')].find(x => x.dataset.conversationSession === sessionId && !x.closest('[hidden],[aria-hidden="true"]'));
              const anchor = root && [...root.querySelectorAll('[data-chat-anchor-key]')].find(x => x.dataset.chatAnchorKey === nav.anchorKey && !x.closest('[hidden],[aria-hidden="true"]'));
              if (anchor) { anchor.scrollIntoView({ block: 'start', behavior: 'auto' }); return; }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error('未找到轮次锚点；请切换到聊天视图后重试');
        } finally { if (activeJumps.get(sessionId) === token) activeJumps.delete(sessionId); }
      }
      function Topics({ sessionId, useTabInfo }) {
        const info = useTabInfo();
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState('');
        const [dismissedJobError, setDismissedJobError] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const sessionRef = React.useRef(sessionId);
        sessionRef.current = sessionId;
        const panelRef = React.useRef(null);
        const [busy, setBusy] = React.useState(false);
        const [page, setPage] = React.useState(0);
        const [refresh, setRefresh] = React.useState(0);
        const [filter, setFilter] = React.useState('');
        const [editingSeq, setEditingSeq] = React.useState(null);
        const [draft, setDraft] = React.useState({ topic: '', summary: '', names: '', target: '', kind: 'continue' });
        const [themePreview, setThemePreview] = React.useState(previewEnabled);

        const returnFocusRef = React.useRef(null);
        const titleInputRef = React.useRef(null);
        const prevEditingRef = React.useRef(null);

        const relationText = r => ({ continue: '接着', return: '回到', branch: '另探自' }[r.kind] + `第${r.turn}轮`);
        const visible = info.tab.visible;

        React.useEffect(() => {
          if (!visible) return;
          let stopped = false, timer, delay = 10000;
          const update = async () => {
            try {
              const value = await call('state', sessionId);
              delay = value.job.running ? 1500 : 10000;
              if (!stopped) { setState(value); }
            } catch (e) {
              if (!stopped) setError(e.message);
            } finally {
              if (!stopped) timer = setTimeout(update, delay);
            }
          };
          void update();
          return () => { stopped = true; clearTimeout(timer); activeJumps.delete(sessionId); };
        }, [sessionId, visible, refresh]);

        React.useEffect(() => {
          setState(null); setError(''); setNotice(''); setDismissedJobError(''); setBusy(false); setPage(0); setFilter(''); setEditingSeq(null); returnFocusRef.current = null;
        }, [sessionId]);

        React.useEffect(() => {
          if (editingSeq !== null) {
            titleInputRef.current?.focus();
          } else if (prevEditingRef.current !== null && returnFocusRef.current !== null) {
            try { panelRef.current?.querySelector(`[data-topic-action="${returnFocusRef.current}"]`)?.focus(); } catch {}
            returnFocusRef.current = null;
          }
          prevEditingRef.current = editingSeq;
        }, [editingSeq]);

        React.useEffect(() => {
          const handleDocClick = e => {
            if (!e.target.closest('.topic-actions-details')) {
              panelRef.current?.querySelectorAll('.topic-actions-details[open]').forEach(d => d.removeAttribute('open'));
            }
            if (!e.target.closest('.topic-settings-details')) {
              panelRef.current?.querySelectorAll('.topic-settings-details[open]').forEach(d => d.removeAttribute('open'));
            }
          };
          document.addEventListener('click', handleDocClick);
          return () => document.removeEventListener('click', handleDocClick);
        }, []);

        const run = async (endpoint, payload = {}) => {
          const requestedSession = sessionId;
          if ((endpoint === 'organize' || endpoint === 'edit') && !compatible) { setError(UPGRADE_MESSAGE); return; }
          setBusy(true); setError(''); setNotice(''); setDismissedJobError('');
          try {
            const result = await call(endpoint, sessionId, payload);
            if (sessionRef.current !== requestedSession) return;
            if (endpoint === 'organize' || endpoint === 'cancel') setState(value => value ? { ...value, job: { ...value.job, ...result } } : value);
            if (endpoint === 'edit') setNotice('修改已保存；重新整理时会保留此轮。');
            if (endpoint === 'cancel') setNotice('正在停止整理，已保存的主题会保留。');
            setRefresh(x => x + 1);
            setEditingSeq(null);
          } catch (e) {
            if (sessionRef.current === requestedSession) setError(e.message);
          } finally {
            if (sessionRef.current === requestedSession) setBusy(false);
          }
        };

        const cancelEdit = () => {
          setEditingSeq(null);
          setError('');
        };

        const handleFormKeyDown = e => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
          }
        };

        const items = state?.items ?? [];
        const subjects = [...new Map(items.flatMap(i => i.subjects ?? []).map(s => [s.id, s])).values()];
        const filtered = filter ? items.filter(i => i.subjects?.some(s => s.id === filter)) : items;
        const pages = Math.max(1, Math.ceil(filtered.length / 80)), current = Math.min(page, pages - 1);
        const running = Boolean(state?.job?.running);
        const compatible = Boolean(state?.apiVersion >= 2 && state?.capabilities?.includes('organize') && state?.capabilities?.includes('edit-text') && state?.capabilities?.includes('incremental-organize'));
        const eligibleCount = items.filter(i => !i.edited && !i.generated).length;

        const handleEditSubmit = (e, item) => {
          e.preventDefault();
          const trimmedTopic = (draft.topic ?? '').trim();
          const trimmedSummary = (draft.summary ?? '').trim();
          if (!trimmedTopic) { setError('标题不能为空'); return; }
          if ([...trimmedTopic].length > 40) { setError('标题不能超过 40 个字符'); return; }
          if (!trimmedSummary) { setError('详情不能为空'); return; }
          if ([...trimmedSummary].length > 120) { setError('详情不能超过 120 个字符'); return; }
          const names = (draft.names ?? '').split(/[、,，]/).map(x => x.trim()).filter(Boolean);
          if (names.length > 2) { setError('事项最多两项'); return; }
          for (const name of names) {
            if ([...name].length > 16) { setError(`事项名称「${name}」超过 16 个字符`); return; }
          }
          const patch = {
            topic: trimmedTopic,
            summary: trimmedSummary,
            subjects: names.map(name => subjects.find(s => s.name === name) ?? { name }),
            relation: draft.target === '' ? null : { seq: Number(draft.target), kind: draft.kind }
          };
          void run('edit', { seq: item.seq, patch });
        };

        const progressDone = state?.job?.done ?? 0;
        const progressTotal = state?.job?.total ?? 0;
        const progressPct = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0;
        const topicLen = [...(draft.topic || '')].length;
        const summaryLen = [...(draft.summary || '')].length;
        const draftSubjectList = (draft.names ?? '').split(/[、,，]/).map(x => x.trim()).filter(Boolean);

        const toggleDraftSubject = name => {
          const exists = draftSubjectList.includes(name);
          const next = exists ? draftSubjectList.filter(x => x !== name) : [...draftSubjectList, name].slice(0, 2);
          setDraft({ ...draft, names: next.join('、') });
        };

        return h('section', { className: 'dsh-turn-topics', ref: panelRef, 'aria-label': '轮次主题' },
          h('div', { className: 'topic-top-bar' },
            h('header', { className: 'topic-header' },
              h('div', { className: 'topic-header-title' },
                h('strong', null, '轮次主题'),
                items.length > 0 && h('span', { className: 'topic-count-badge' }, String(items.length))
              ),
              h('div', { className: 'topic-header-actions' },
                h('details', { className: 'topic-settings-details' },
                  h('summary', { className: 'topic-settings-summary', 'aria-label': '设置与说明', title: '设置与说明' }, '设置'),
                  h('div', { className: 'topic-settings-panel' },
                    h('div', { className: 'topic-settings-group' },
                      h('label', { className: 'topic-checkbox-label' },
                        h('input', {
                          type: 'checkbox',
                          checked: themePreview,
                          onChange: e => {
                            const next = e.target.checked;
                            previewEnabled = next;
                            setThemePreview(next);
                            previewAdapter?.setEnabled(next);
                            try { window.localStorage?.setItem('dsh-turn-topic-preview', next ? 'on' : 'off'); } catch {}
                          }
                        }),
                        h('span', null, ' 原生刻度浮层显示主题')
                      ),
                      h('p', { className: 'topic-note' }, '在聊天视图的时间轴刻度上悬浮，可快速预览对应轮次的主题和结论。')
                    ),
                    h('div', { className: 'topic-settings-group' },
                      h('strong', { className: 'topic-settings-title' }, '主题整理与保护'),
                      h('p', { className: 'topic-note' }, '点击「整理主题」只补齐未生成或内容已变化的轮次。已有有效主题自动跳过，人工修改始终保留；同一会话依轮次整理，最多 3 个会话同时进行。'),
                      h('p', { className: 'topic-note' }, '每轮一次模型调用，会产生费用；总结与历史上下文将发送至配置的模型。'),
                      h('p', { className: 'topic-note' }, '模型请前往DSH「设置 → 轮次主题」选择已配置的服务商与模型。'),
                      h('p', { className: 'topic-note topic-version-note' }, `前端 ${CLIENT_VERSION} · 后台 ${state?.hostVersion ?? '旧版（未报告版本）'}`)
                    )
                  )
                ),
                h('button', {
                  type: 'button',
                  className: 'topic-btn ' + (running ? 'topic-btn-danger' : 'topic-btn-primary'),
                  disabled: busy || !state || (!running && (!compatible || !eligibleCount || editingSeq !== null)),
                  title: !compatible ? '请重新打开DSH加载新版后台' : editingSeq !== null ? '请先保存或取消编辑' : !eligibleCount ? '所有轮次均已整理或受人工保护，无需重复调用模型' : '仅补齐缺失或失效的主题；每轮一次模型调用',
                  onClick: () => run(running ? 'cancel' : 'organize')
                }, running ? '停止整理' : '整理主题')
              )
            ),

            subjects.length > 0 && h('div', { className: 'topic-filter-bar' },
              h('label', { className: 'topic-filter-label' },
                h('span', { className: 'topic-filter-prefix' }, '事项'),
                h('select', {
                  className: 'topic-select',
                  value: filter,
                  onChange: e => { setFilter(e.target.value); setPage(0); }
                },
                  h('option', { value: '' }, '全部事项 (' + items.length + ')'),
                  subjects.map(s => {
                    const cnt = items.filter(i => i.subjects?.some(sub => sub.id === s.id)).length;
                    return h('option', { key: s.id, value: s.id }, `${s.name} (${cnt})`);
                  })
                )
              ),
              filter !== '' && h('button', {
                type: 'button',
                className: 'topic-btn topic-btn-sm',
                onClick: () => { setFilter(''); setPage(0); }
              }, '清除筛选')
            )
          ),

          h('div', { className: 'topic-scroll-area' },
            state && !compatible && h('div', { className: 'topic-alert topic-alert-warn', role: 'alert' }, UPGRADE_MESSAGE),
            notice && h('div', { className: 'topic-banner topic-banner-info', role: 'status' },
              h('span', null, notice),
              h('button', { type: 'button', className: 'topic-alert-close', onClick: () => setNotice(''), 'aria-label': '关闭提示', title: '关闭提示' }, '×')
            ),
            state && compatible && !running && items.length > 0 && !eligibleCount && h('p', { className: 'topic-banner' }, '所有轮次均已整理或受人工保护，无需重复整理。'),
            state?.job?.finished && !running && !state.job.error && !notice && h('p', { className: 'topic-banner topic-banner-info', role: 'status' }, state.job.total === 0 ? '无需整理：没有可处理的轮次。' : `整理完成 · ${state.job.done - state.job.failed} 轮成功${state.job.failed ? ` · ${state.job.failed} 轮失败，原内容已保留` : ''}`),
            running && h('div', { className: 'topic-progress-box', role: 'status' },
              h('div', { className: 'topic-progress-bar' },
                h('div', { className: 'topic-progress-fill', style: { width: `${progressPct}%` } })
              ),
              h('div', { className: 'topic-progress-text' },
                `已整理 ${progressDone}/${progressTotal}${state.job.currentTurn ? ` · 正在处理第 ${state.job.currentTurn} 轮` : ' · 排队中'}${state.job.failed ? ` · 失败 ${state.job.failed}` : ''}`
              )
            ),

            (error || (state?.job?.error && state.job.error !== dismissedJobError)) && h('div', { className: 'topic-alert topic-alert-error', role: 'alert' },
              h('span', null, error || state.job.error),
              h('button', { type: 'button', className: 'topic-alert-close', onClick: () => { setError(''); setDismissedJobError(state?.job?.error ?? ''); }, 'aria-label': '关闭提示', title: '关闭提示' }, '×')
            ),

            !state && !error && h('div', { className: 'topic-status-box', role: 'status' }, '正在读取主题…'),
            state && !items.length && h('div', { className: 'topic-status-box' }, '当前会话尚无已结束的用户轮次。'),
            state && items.length > 0 && filtered.length === 0 && h('div', { className: 'topic-status-box' }, '未找到符合当前事项筛选的轮次。'),

            h('ol', { className: 'topic-list', start: current * 80 + 1 },
              filtered.slice(current * 80, (current + 1) * 80).map(item => {
                const isEditing = editingSeq === item.seq;
                const itemCls = 'topic-item' +
                  (isEditing ? ' is-editing' : '') +
                  (item.status === 'generating' ? ' is-generating' : '') +
                  (item.status === 'failed' && !item.generated ? ' is-failed' : '') +
                  (!item.generated && item.status !== 'generating' ? ' is-pending' : '');
                return h('li', { key: item.seq, className: itemCls },
                  h('div', { className: 'topic-item-header' },
                    h('button', {
                      type: 'button',
                      className: 'topic-nav-btn',
                      title: '跳转到第 ' + item.turn + ' 轮对话',
                      onClick: () => { setError(''); void jump(sessionId, item).catch(e => setError(e.message)); }
                    },
                      h('span', { className: 'topic-turn-badge' }, '#' + item.turn),
                      h('span', { className: 'topic-title' },
                        item.generated ? item.topic : item.status === 'generating' ? '正在生成主题…' : item.status === 'failed' ? '主题生成失败' : '待生成主题'
                      ),
                      item.edited && h('span', { className: 'topic-edited-tag', title: '已人工修改，整理主题时受保护' }, '已修改')
                    ),
                    !isEditing && item.generated && h('details', { className: 'topic-actions-details' },
                      h('summary', {
                        className: 'topic-actions-summary',
                        'aria-label': `第 ${item.turn} 轮操作`,
                        'data-topic-action': item.seq,
                        onKeyDown: e => { if (e.key === 'Escape') { e.currentTarget.closest('details')?.removeAttribute('open'); e.currentTarget.focus(); } },
                        title: `第 ${item.turn} 轮操作`
                      }, '⋯'),
                      h('div', { className: 'topic-actions-dropdown' },
                        h('button', {
                          type: 'button',
                          className: 'topic-action-item',
                          disabled: busy || running || !compatible,
                          onClick: e => {
                            returnFocusRef.current = item.seq;
                            e.currentTarget.closest('details')?.removeAttribute('open');
                            const initialTopic = item.topic === '待生成主题' || item.topic === '主题生成失败' ? '' : item.topic;
                            setEditingSeq(item.seq);
                            setDraft({
                              topic: initialTopic || '',
                              summary: item.summary || '',
                              names: (item.subjects ?? []).map(s => s.name).join('、'),
                              target: item.relation?.seq != null ? String(item.relation.seq) : '',
                              kind: item.relation?.kind ?? 'continue'
                            });
                          }
                        }, '编辑')
                      )
                    )
                  ),

                  !isEditing && h('div', { className: 'topic-item-body' },
                    !item.generated && item.preview && h('p', { className: 'topic-preview' },
                      h('span', { className: 'topic-preview-prefix' }, '提问：'),
                      item.preview
                    ),
                    item.error && h('p', { className: 'topic-item-error', role: 'alert' }, item.error),
                    item.summary && h('p', { className: 'topic-summary' }, item.summary),
                    ((item.subjects && item.subjects.length > 0) || item.relation || item.relationChanged) && h('div', { className: 'topic-meta-row' },
                      (item.subjects ?? []).map(s => {
                        const active = filter === s.id;
                        return h('button', {
                          key: s.id,
                          type: 'button',
                          className: 'topic-meta-pill is-subject' + (active ? ' is-active' : ''),
                          title: active ? '当前正在筛选此事项，点击取消筛选' : '按事项筛选：' + s.name,
                          onClick: () => { setFilter(active ? '' : s.id); setPage(0); }
                        }, s.name);
                      }),
                      item.relation && h('button', {
                        type: 'button',
                        className: 'topic-meta-pill is-relation',
                        title: '跳转到第 ' + item.relation.turn + ' 轮',
                        onClick: () => { setError(''); void jump(sessionId, item.relation).catch(e => setError(e.message)); }
                      }, relationText(item.relation)),
                      item.relationChanged && h('span', { className: 'topic-meta-note' }, '关联依据已变化')
                    )
                  ),

                  isEditing && h('form', {
                    className: 'topic-edit-form',
                    onSubmit: e => handleEditSubmit(e, item),
                    onKeyDown: handleFormKeyDown
                  },
                    h('div', { className: 'topic-form-field' },
                      h('div', { className: 'topic-form-label-row' },
                        h('label', { htmlFor: `topic-input-${item.seq}`, className: 'topic-form-label' }, '主题标题'),
                        h('span', { className: 'topic-form-count' + (topicLen >= 35 ? ' is-near-limit' : '') }, `${topicLen}/40 · 建议 8–15 字`)
                      ),
                      h('input', {
                        id: `topic-input-${item.seq}`,
                        ref: titleInputRef,
                        className: 'topic-input',
                        type: 'text',
                        value: draft.topic,
                        maxLength: 40,
                        autoFocus: true,
                        placeholder: '输入本轮主题（建议 8–15 字）',
                        onChange: e => setDraft({ ...draft, topic: e.target.value })
                      })
                    ),
                    h('div', { className: 'topic-form-field' },
                      h('div', { className: 'topic-form-label-row' },
                        h('label', { htmlFor: `summary-input-${item.seq}`, className: 'topic-form-label' }, '结论详情'),
                        h('span', { className: 'topic-form-count' + (summaryLen >= 105 ? ' is-near-limit' : '') }, `${summaryLen}/120 · 建议 60 字内`)
                      ),
                      h('textarea', {
                        id: `summary-input-${item.seq}`,
                        className: 'topic-textarea',
                        rows: 3,
                        value: draft.summary,
                        maxLength: 120,
                        placeholder: '输入本轮结论与进展（不超过 120 字）',
                        onChange: e => setDraft({ ...draft, summary: e.target.value })
                      })
                    ),
                    h('details', { className: 'topic-advanced-details' },
                      h('summary', { className: 'topic-advanced-summary' }, '高级选项（事项与关联脉络）'),
                      h('div', { className: 'topic-advanced-content' },
                        h('div', { className: 'topic-form-field' },
                          h('label', { className: 'topic-form-label' }, '事项（最多两项，顿号分隔）'),
                          h('input', {
                            className: 'topic-input',
                            type: 'text',
                            value: draft.names,
                            maxLength: 40,
                            placeholder: '例如：架构设计、测试用例',
                            onChange: e => setDraft({ ...draft, names: e.target.value })
                          }),
                          subjects.length > 0 && h('div', { className: 'topic-subject-picks' },
                            subjects.map(s => {
                              const picked = draftSubjectList.includes(s.name);
                              return h('button', {
                                key: s.id,
                                type: 'button',
                                className: 'topic-meta-pill is-subject' + (picked ? ' is-active' : ''),
                                title: picked ? '点击移除事项' : '点击选用已有事项',
                                onClick: () => toggleDraftSubject(s.name)
                              }, s.name);
                            })
                          )
                        ),
                        h('div', { className: 'topic-form-row' },
                          h('div', { className: 'topic-form-field' },
                            h('label', { className: 'topic-form-label' }, '关联轮次'),
                            h('select', {
                              className: 'topic-select',
                              value: draft.target,
                              onChange: e => setDraft({ ...draft, target: e.target.value })
                            },
                              h('option', { value: '' }, '不关联'),
                              items.filter(x => x.generated && x.seq < item.seq && x.turn < item.turn).map(x =>
                                h('option', { key: x.seq, value: String(x.seq) }, `第${x.turn}轮 · ${x.topic}`)
                              )
                            )
                          ),
                          h('div', { className: 'topic-form-field' },
                            h('label', { className: 'topic-form-label' }, '关系类型'),
                            h('select', {
                              className: 'topic-select',
                              value: draft.kind,
                              disabled: draft.target === '',
                              onChange: e => setDraft({ ...draft, kind: e.target.value })
                            },
                              h('option', { value: 'continue' }, '接着'),
                              h('option', { value: 'return' }, '回到'),
                              h('option', { value: 'branch' }, '另探')
                            )
                          )
                        )
                      )
                    ),
                    h('p', { className: 'topic-protect-note' }, '保存后此轮将标记为「已修改」并受保护，重新整理时不会覆盖。按 Esc 取消。'),
                    h('div', { className: 'topic-form-actions' },
                      h('button', {
                        type: 'button',
                        className: 'topic-btn',
                        onClick: cancelEdit
                      }, '取消'),
                      h('button', {
                        type: 'submit',
                        className: 'topic-btn topic-btn-primary',
                        disabled: busy || running
                      }, '保存修改')
                    )
                  )
                );
              })
            ),

            pages > 1 && h('nav', { className: 'topic-pagination', 'aria-label': '主题分页' },
              h('button', {
                type: 'button',
                className: 'topic-btn topic-btn-sm',
                disabled: current === 0,
                onClick: () => setPage(current - 1)
              }, '上一页'),
              h('span', { className: 'topic-page-info' }, `${current + 1} / ${pages}`),
              h('button', {
                type: 'button',
                className: 'topic-btn topic-btn-sm',
                disabled: current >= pages - 1,
                onClick: () => setPage(current + 1)
              }, '下一页')
            )
          )
        );
      }

      function Entry({ sessionId }) { return h('button', { type: 'button', className: 'dsh-topic-entry-btn', title: '打开轮次主题', onClick: () => ctx.sidebarRight.openTabIn(sessionId, KIND) }, '轮次主题'); }
      const tabTitle = () => '轮次主题';
      // 0.2.1 起 `id` 同时是正文/标题插槽的 key，`priority: 'extension'` 让本面板与产品自带查看器同档，
      // `guide` 让右栏引导页也能直接打开本面板。旧运行时可能拒绝未知字段，则退回三字段声明：
      // 注册失败只会让页签种类缺失，页面头部的入口按钮与本插件其余部分必须照常可用。
      const fullDefinition = {
        id: ID,
        kind: KIND,
        priority: 'extension',
        title: tabTitle,
        guide: [{ id: ID, title: tabTitle, order: 80, description: () => '按轮次整理的主题与结论' }]
      };
      const minimalDefinition = { id: ID, kind: KIND, title: tabTitle };
      const registerTabType = () => {
        try { return ctx.sidebarRightTabs.register(fullDefinition); }
        catch (error) {
          ctx.logger?.warn?.('轮次主题页签使用兼容声明注册：' + (error?.message ?? error));
          return ctx.sidebarRightTabs.register(minimalDefinition);
        }
      };
      ctx.effect(registerTabType);
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: ID }, Entry));
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Topics));
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: ID }, () => h('span', null, tabTitle())));

      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = `[role=tooltip][data-dsh-topic-preview=generated]>:not([data-dsh-topic-overlay]){display:none!important}
[role=tooltip][data-dsh-topic-preview]{height:auto!important;max-height:min(240px,60vh);overflow:hidden;--turn-preview-height:240px}
[data-dsh-topic-overlay]{white-space:normal;overflow-wrap:anywhere;font-size:13px;line-height:1.5}
[data-dsh-topic-overlay] .dsh-topic-tip-meta{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,GrayText);margin-bottom:3px}
[data-dsh-topic-overlay] strong{display:block;font-size:13.5px;font-weight:600;line-height:1.38;color:var(--dsw-alias-label-primary,CanvasText);margin-bottom:4px}
[data-dsh-topic-overlay] .dsh-topic-tip-summary{font-size:12.5px;line-height:1.48;color:var(--dsw-alias-label-secondary,GrayText)}
[data-dsh-topic-overlay] .dsh-topic-tip-rel{margin-top:6px;padding-top:5px;border-top:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.18));font-size:11px;color:var(--dsw-alias-label-tertiary,GrayText)}
[data-dsh-topic-preview=pending] [data-dsh-topic-overlay]{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,GrayText)}
.dsh-topic-entry-btn{font:inherit;font-size:12.5px;font-weight:500;line-height:1.3;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.28));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,CanvasText);cursor:pointer;transition:background 0.15s ease,border-color 0.15s ease}
.dsh-topic-entry-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1));border-color:var(--dsw-alias-border-l1,rgba(128,128,128,0.45))}
.dsh-topic-entry-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:2px}
.dsh-turn-topics{box-sizing:border-box;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,CanvasText);font:14px/1.5 var(--dsw-font-family,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);height:100%;overflow:hidden}
.dsh-turn-topics .topic-top-bar{flex-shrink:0;padding:12px 14px 10px;background:var(--dsw-alias-bg-layer-1,Canvas);border-bottom:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.16));z-index:10}
.dsh-turn-topics .topic-scroll-area{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 14px 18px}
.dsh-turn-topics .topic-header{position:relative;flex-wrap:wrap;display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-turn-topics .topic-header-title{font-size:14.5px;font-weight:600;letter-spacing:-0.01em;color:var(--dsw-alias-label-primary,CanvasText);display:flex;align-items:center;gap:6px}
.dsh-turn-topics .topic-count-badge{font-size:11.5px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.1));padding:1px 6px;border-radius:10px}
.dsh-turn-topics .topic-header-actions{display:flex;align-items:center;gap:6px}
.dsh-turn-topics button,.dsh-turn-topics summary{min-height:30px;box-sizing:border-box}
.dsh-turn-topics button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:2px}
.dsh-turn-topics .topic-btn{min-height:32px;font:inherit;font-size:12.5px;font-weight:500;line-height:1.3;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.3));border-radius:6px;padding:4px 11px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;user-select:none;transition:background 0.15s ease,border-color 0.15s ease,opacity 0.15s ease}
.dsh-turn-topics .topic-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.1))}
.dsh-turn-topics .topic-btn:disabled{opacity:0.45;cursor:not-allowed}
.dsh-turn-topics .topic-btn-primary{background:var(--dsw-alias-state-business-primary,#0969da);color:#fff;border-color:transparent;font-weight:500}
.dsh-turn-topics .topic-btn-primary:hover{opacity:0.92;background:var(--dsw-alias-state-business-primary,#0969da)}
.dsh-turn-topics .topic-btn-danger{background:var(--dsw-alias-state-error-primary,#cf222e);color:#fff;border-color:transparent;font-weight:500}
.dsh-turn-topics .topic-btn-danger:hover{opacity:0.92;background:var(--dsw-alias-state-error-primary,#cf222e)}
.dsh-turn-topics .topic-btn-sm{min-height:26px;font-size:11.5px;padding:2px 8px;border-radius:5px}
.dsh-turn-topics .topic-settings-details{position:static}
.dsh-turn-topics .topic-settings-summary{min-height:32px;list-style:none;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);padding:4px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.24));cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:4px;transition:all 0.15s ease}
.dsh-turn-topics .topic-settings-summary::-webkit-details-marker{display:none}
.dsh-turn-topics .topic-settings-summary:hover,.dsh-turn-topics .topic-settings-summary:focus-visible,.dsh-turn-topics .topic-settings-details[open] .topic-settings-summary{color:var(--dsw-alias-label-primary,CanvasText);border-color:var(--dsw-alias-border-l2,GrayText);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.08))}
.dsh-turn-topics .topic-settings-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:2px}
.dsh-turn-topics .topic-settings-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:30;box-sizing:border-box;width:280px;max-width:100%;padding:12px;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.32));border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.2);display:grid;gap:12px}
.dsh-turn-topics.topic-settings-page{height:auto;overflow:visible;box-sizing:border-box;font-family:inherit;max-width:100%}
.dsh-turn-topics.topic-settings-page h2{font-size:20px;margin:0}
.dsh-turn-topics.topic-settings-page h3{font-size:16px;margin:0}
.dsh-turn-topics.topic-settings-page .topic-input{width:100%;box-sizing:border-box;min-height:36px}
.dsh-turn-topics .topic-key-details{margin-top:12px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l3,GrayText)}
.dsh-turn-topics .topic-key-details>summary{cursor:pointer;font-size:14px}
.dsh-turn-topics .topic-key-details button:not(.topic-btn-primary){background:transparent}
.dsh-turn-topics .topic-settings-group{display:grid;gap:4px}
.dsh-turn-topics .topic-settings-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-checkbox-label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;cursor:pointer;color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-note{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,GrayText);margin:0}
.dsh-turn-topics .topic-version-note{padding-top:4px;border-top:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.16));font-variant-numeric:tabular-nums}
.dsh-turn-topics .topic-filter-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.14))}
.dsh-turn-topics .topic-filter-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);min-width:0;flex:1}
.dsh-turn-topics .topic-filter-prefix{flex-shrink:0;font-weight:500}
.dsh-turn-topics .topic-select{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.06));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.28));border-radius:6px;padding:4px 8px;min-width:0;width:100%;max-width:100%;box-sizing:border-box;text-overflow:ellipsis}
.dsh-turn-topics .topic-select:disabled{opacity:0.5;cursor:not-allowed}
.dsh-turn-topics .topic-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:1px}
.dsh-turn-topics .topic-progress-box{margin:0 0 10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.06));border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.18))}
.dsh-turn-topics .topic-progress-bar{height:4px;background:var(--dsw-alias-bg-layer-3,rgba(128,128,128,0.2));border-radius:2px;overflow:hidden;margin-bottom:6px}
.dsh-turn-topics .topic-progress-fill{height:100%;background:var(--dsw-alias-state-business-primary,#0969da);transition:width 0.25s ease}
.dsh-turn-topics .topic-progress-text{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dsh-turn-topics .topic-banner{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:6px;margin:0 0 10px;font-size:12px;line-height:1.4;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.07));border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.2));color:var(--dsw-alias-label-secondary,#555)}
.dsh-turn-topics .topic-banner-info{background:rgba(9,105,218,0.07);border-color:rgba(9,105,218,0.24);color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-alert{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:6px;margin:0 0 10px;font-size:12px;line-height:1.45}
.dsh-turn-topics .topic-alert-warn{background:rgba(210,153,34,0.1);border:1px solid rgba(210,153,34,0.4);color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-alert-error{background:rgba(207,34,46,0.1);border:1px solid var(--dsw-alias-state-error-primary,FireBrick);color:var(--dsw-alias-state-error-primary,FireBrick)}
.dsh-turn-topics .topic-alert-close{min-height:22px;border:none;background:none;color:inherit;font-size:15px;line-height:1;padding:0 4px;cursor:pointer;opacity:0.7;border-radius:4px}
.dsh-turn-topics .topic-alert-close:hover{opacity:1;background:rgba(128,128,128,0.12)}
.dsh-turn-topics .topic-status-box{text-align:center;padding:32px 16px;color:var(--dsw-alias-label-tertiary,GrayText);font-size:13px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.04));border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,0.2));border-radius:8px;margin:4px 0}
.dsh-turn-topics .topic-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.dsh-turn-topics .topic-item{background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.2));border-radius:8px;padding:10px 11px;box-sizing:border-box;transition:border-color 0.15s ease,background 0.15s ease,box-shadow 0.15s ease}
.dsh-turn-topics .topic-item:hover{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,0.38))}
.dsh-turn-topics .topic-item.is-generating{border-color:var(--dsw-alias-state-business-primary,#0969da);background:rgba(9,105,218,0.03)}
.dsh-turn-topics .topic-item.is-editing{border-color:var(--dsw-alias-state-business-primary,#0969da);box-shadow:0 2px 10px rgba(0,0,0,0.08)}
.dsh-turn-topics .topic-item.is-pending{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.03));border-style:dashed}
.dsh-turn-topics .topic-item.is-failed{border-color:rgba(207,34,46,0.4)}
.dsh-turn-topics .topic-item-header{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.dsh-turn-topics .topic-nav-btn{flex:1;min-width:0;min-height:24px;display:flex;align-items:center;gap:8px;text-align:left;background:transparent;border:none;padding:0;cursor:pointer;color:inherit;font:inherit;border-radius:4px}
.dsh-turn-topics .topic-nav-btn:hover .topic-title{color:var(--dsw-alias-state-business-primary,Highlight)}
.dsh-turn-topics .topic-nav-btn:hover .topic-turn-badge{background:rgba(9,105,218,0.12);color:var(--dsw-alias-state-business-primary,#0969da)}
.dsh-turn-topics .topic-turn-badge{font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.1));border-radius:4px;padding:1px 5px;flex-shrink:0;min-width:28px;text-align:center;line-height:1.4;transition:background 0.15s ease,color 0.15s ease}
.dsh-turn-topics .topic-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText);line-height:1.38;overflow-wrap:anywhere;word-break:break-word;transition:color 0.15s ease}
.dsh-turn-topics .topic-item.is-pending .topic-title{font-weight:500;color:var(--dsw-alias-label-secondary,#666)}
.dsh-turn-topics .topic-edited-tag{font-size:10.5px;font-weight:500;color:var(--dsw-alias-state-business-primary,#0969da);background:rgba(9,105,218,0.08);border:1px solid rgba(9,105,218,0.22);border-radius:4px;padding:0 5px;line-height:1.45;flex-shrink:0}
.dsh-turn-topics .topic-actions-details{position:relative;flex-shrink:0}
.dsh-turn-topics .topic-actions-summary{min-width:26px;min-height:24px;height:24px;list-style:none;font-size:14px;line-height:1;padding:0 5px;border-radius:5px;color:var(--dsw-alias-label-tertiary,GrayText);border:1px solid transparent;cursor:pointer;user-select:none;display:inline-flex;align-items:center;justify-content:center;background:transparent;transition:all 0.15s ease}
.dsh-turn-topics .topic-actions-summary::-webkit-details-marker{display:none}
.dsh-turn-topics .topic-item:hover .topic-actions-summary,.dsh-turn-topics .topic-actions-details[open] .topic-actions-summary{color:var(--dsw-alias-label-secondary,#666);border-color:var(--dsw-alias-border-l3,rgba(128,128,128,0.22))}
.dsh-turn-topics .topic-actions-summary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.12));color:var(--dsw-alias-label-primary,CanvasText);border-color:var(--dsw-alias-border-l2,GrayText)}
.dsh-turn-topics .topic-actions-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:2px;color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-actions-dropdown{position:absolute;right:0;top:calc(100% + 4px);z-index:25;min-width:88px;padding:4px;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.3));border-radius:6px;box-shadow:0 6px 16px rgba(0,0,0,0.16)}
.dsh-turn-topics .topic-action-item{min-height:28px;display:block;width:100%;text-align:left;font:inherit;font-size:12.5px;padding:4px 9px;border:none;background:transparent;border-radius:4px;cursor:pointer;color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-action-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.12))}
.dsh-turn-topics .topic-item-body{margin-top:4px;padding-left:36px}
.dsh-turn-topics .topic-summary{margin:2px 0 0;font-size:13.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#555);overflow-wrap:anywhere;word-break:break-word}
.dsh-turn-topics .topic-preview{margin:2px 0 0;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,GrayText);overflow-wrap:anywhere}
.dsh-turn-topics .topic-preview-prefix{font-weight:500;color:var(--dsw-alias-label-secondary,#666)}
.dsh-turn-topics .topic-item-error{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary,FireBrick)}
.dsh-turn-topics .topic-meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:7px}
.dsh-turn-topics .topic-meta-pill{min-height:22px;font:inherit;font-size:11.5px;line-height:1.3;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.24));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.06));color:var(--dsw-alias-label-secondary,#555);cursor:pointer;transition:all 0.15s ease}
.dsh-turn-topics .topic-meta-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.14));border-color:var(--dsw-alias-border-l2,GrayText);color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-meta-pill.is-subject.is-active{background:rgba(9,105,218,0.12);border-color:rgba(9,105,218,0.42);color:var(--dsw-alias-state-business-primary,#0969da);font-weight:500}
.dsh-turn-topics .topic-meta-pill.is-relation{border-style:dashed;background:transparent}
.dsh-turn-topics .topic-meta-pill.is-relation::before{content:"↪ ";opacity:0.7}
.dsh-turn-topics .topic-meta-pill:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:1px}
.dsh-turn-topics .topic-meta-note{font-size:11px;color:var(--dsw-alias-label-tertiary,GrayText)}
.dsh-turn-topics .topic-edit-form{display:grid;gap:10px;margin-top:8px;padding:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,0.04));border-radius:6px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.2))}
.dsh-turn-topics .topic-form-field{display:grid;gap:4px;min-width:0}
.dsh-turn-topics .topic-form-label-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:4px;font-size:12px}
.dsh-turn-topics .topic-form-label{font-weight:500;color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-form-count{font-size:11px;color:var(--dsw-alias-label-tertiary,GrayText);font-variant-numeric:tabular-nums}
.dsh-turn-topics .topic-form-count.is-near-limit{color:#d29922;font-weight:500}
.dsh-turn-topics .topic-input,.dsh-turn-topics .topic-textarea{font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-layer-1,Canvas);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.35));border-radius:6px;padding:6px 8px;box-sizing:border-box;width:100%}
.dsh-turn-topics .topic-textarea{resize:vertical;min-height:60px;line-height:1.48}
.dsh-turn-topics .topic-input:focus,.dsh-turn-topics .topic-textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:-1px}
.dsh-turn-topics .topic-advanced-details{border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.22));background:var(--dsw-alias-bg-layer-1,Canvas);border-radius:6px;padding:6px 8px}
.dsh-turn-topics .topic-advanced-summary{min-height:24px;list-style:none;cursor:pointer;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);user-select:none;display:flex;align-items:center}
.dsh-turn-topics .topic-advanced-summary::-webkit-details-marker{display:none}
.dsh-turn-topics .topic-advanced-summary:hover{color:var(--dsw-alias-label-primary,CanvasText)}
.dsh-turn-topics .topic-advanced-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,Highlight);outline-offset:2px}
.dsh-turn-topics .topic-advanced-content{display:grid;gap:8px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,0.2))}
.dsh-turn-topics .topic-subject-picks{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.dsh-turn-topics .topic-form-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsh-turn-topics .topic-protect-note{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,GrayText);margin:0}
.dsh-turn-topics .topic-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dsh-turn-topics .topic-pagination{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.18));font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dsh-turn-topics .topic-page-info{font-variant-numeric:tabular-nums}`;
        document.head.appendChild(style);
        return () => { activeJumps.clear(); style.remove(); };
      });
    }
    return { inject: ['connection', 'slots', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'uiConversation'], apply };
  }
});
