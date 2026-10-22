// Desktop 0.2.0-rc.2 DOM seam. Unknown locale/structure => native preview.
export function previewTarget(button) {
  const root = button.closest('[data-conversation-session]');
  const nav = button.closest('nav[aria-label]');
  if (!root || !nav || !['轮次导航', 'Turn navigation'].includes(nav.getAttribute('aria-label'))) return null;
  const label = button.getAttribute('aria-label') ?? '';
  const match = /^(?:加载并)?跳转到第 ([1-9]\d*) 轮$/.exec(label) ?? /^(?:Load and jump|Jump) to turn ([1-9]\d*)$/.exec(label);
  const turn = Number(match?.[1]);
  const id = button.getAttribute('aria-describedby');
  if (!Number.isSafeInteger(turn) || !id || /\s/.test(id)) return null;
  const tips = [...nav.querySelectorAll('[role="tooltip"]')].filter(x => x.id === id);
  if (tips.length !== 1 || button.closest('[hidden],[aria-hidden="true"]')) return null;
  const sessionId = root.dataset.conversationSession;
  if (!sessionId || !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId)) return null;
  return { root, button, tip: tips[0], sessionId, turn };
}
export function installPreview({ document, Observer, call, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  let enabled = true, closed = false, queued = false, timer;
  const cache = new Map(), pending = new Map(), mounted = new Map();
  function restore(tip) {
    const entry = mounted.get(tip); if (!entry) return;
    entry.overlay.remove(); tip.removeAttribute('data-dsh-topic-preview'); mounted.delete(tip);
  }
  function render(target, state) {
    const { tip, turn, sessionId } = target;
    const matches = state?.items?.filter(x => x.turn === turn) ?? [];
    if (matches.length !== 1) { restore(tip); return; }
    const item = matches[0], generated = item.generated && typeof item.topic === 'string' && typeof item.summary === 'string';
    const signature = JSON.stringify([sessionId, turn, generated, item.topic, item.summary, item.status, item.error, item.subjects, item.relation, item.relationChanged]);
    const prior = mounted.get(tip);
    if (prior?.signature === signature && prior.overlay.parentNode === tip) return;
    restore(tip);
    // Append an owned sibling; leave React-owned text and child nodes untouched.
    const overlay = document.createElement('div'); overlay.setAttribute('data-dsh-topic-overlay', '');
    if (generated) {
      const title = document.createElement('strong'); title.textContent = item.topic;
      const summary = document.createElement('div'); summary.setAttribute('class', 'dsh-topic-tip-summary'); summary.textContent = item.summary;
      if (item.subjects?.length) { const label = document.createElement('div'); label.setAttribute('class', 'dsh-topic-tip-meta'); label.textContent = item.subjects.map(s => s.name).join(' · '); overlay.appendChild(label); }
      overlay.appendChild(title); overlay.appendChild(summary);
      if (item.relation) { const r = document.createElement('div'); r.setAttribute('class', 'dsh-topic-tip-rel'); r.textContent = ({ continue: '接着', return: '回到', branch: '另探自' }[item.relation.kind] ?? '关联') + `第${item.relation.turn}轮`; overlay.appendChild(r); }
      else if (item.relationChanged) { const r = document.createElement('div'); r.setAttribute('class', 'dsh-topic-tip-rel'); r.textContent = '关联依据已变化'; overlay.appendChild(r); }
      tip.setAttribute('data-dsh-topic-preview', 'generated');
    } else {
      overlay.textContent = item.status === 'generating' ? '主题生成中…' : item.status === 'failed' ? '主题生成失败；可在轮次主题面板整理' : '主题未生成；可在轮次主题面板整理';
      tip.setAttribute('data-dsh-topic-preview', 'pending');
    }
    tip.appendChild(overlay); mounted.set(tip, { overlay, signature });
  }
  function queue() {
    if (closed || queued) return; queued = true;
    queueMicrotask(() => { queued = false; if (!closed) scan(); });
  }
  function scan() {
    unschedule(timer);
    const active = new Set(), targets = [];
    if (enabled) for (const root of document.querySelectorAll('[data-conversation-session]')) {
      if (root.closest('[hidden],[aria-hidden="true"]')) continue;
      for (const button of root.querySelectorAll('nav button[aria-describedby][data-index]')) {
        const target = previewTarget(button);
        if (target) { active.add(target.tip); targets.push(target); }
      }
    }
    for (const tip of mounted.keys()) if (!active.has(tip)) restore(tip);
    for (const target of targets) {
      const cached = cache.get(target.sessionId);
      if (cached?.value) render(target, cached.value);
      if ((!cached || now() - cached.time >= 5000) && !pending.has(target.sessionId)) {
        const id = target.sessionId;
        // State only: hovering never calls generate. Revalidate DOM after every await.
        const task = Promise.resolve().then(() => call('state', id)).then(value => {
          if (closed) return;
          cache.delete(id); cache.set(id, { value, time: now() });
          while (cache.size > 16) cache.delete(cache.keys().next().value);
        }).catch(() => { if (!closed) { cache.set(id, { time: now() }); for (const [tip, entry] of mounted) if (JSON.parse(entry.signature)[0] === id) restore(tip); } })
          .finally(() => { pending.delete(id); queue(); });
        pending.set(id, task);
      }
    }
    if (targets.length) timer = schedule(queue, 5000);
  }
  const observer = new Observer(queue);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-describedby', 'aria-label', 'hidden', 'aria-hidden', 'data-conversation-session'] });
  queue();
  return {
    setEnabled(value) { enabled = !!value; queue(); },
    get enabled() { return enabled; },
    dispose() { closed = true; observer.disconnect(); unschedule(timer); for (const tip of mounted.keys()) restore(tip); cache.clear(); }
  };
}
