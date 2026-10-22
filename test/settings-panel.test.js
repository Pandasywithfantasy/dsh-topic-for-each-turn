import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../src/batch-panel.js', import.meta.url), 'utf8')) + '\n' + (await readFile(new URL('../src/settings-panel.js', import.meta.url), 'utf8'));
const initial = () => ({ hostVersion: 'test', writable: true, configured: true, config: { provider: 'one', model: 'alpha', reasoningEffort: 'medium', maxTokens: 256 }, providers: [
  { id: 'one', models: [{ id: 'alpha', name: 'Alpha', reasoningEfforts: ['low', 'medium', 'high'] }, { id: 'plain', name: 'Plain' }] },
  { id: 'two', models: [{ id: 'beta', name: 'Beta', reasoningEfforts: ['minimal', 'high'] }] }
] });
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const text = node => node && typeof node === 'object' ? node.children.map(text).join('') : String(node ?? '');
function find(tree, predicate) {
  const result = [];
  const visit = node => { if (!node || typeof node !== 'object') return; if (predicate(node)) result.push(node); node.children.forEach(visit); };
  visit(tree); return result;
}
const select = (tree, index) => find(tree, node => node.tag === 'select')[index];
const number = tree => find(tree, node => node.tag === 'input')[0];
const button = (tree, label) => find(tree, node => node.tag === 'button' && text(node) === label)[0];
const submit = tree => find(tree, node => node.tag === 'form')[0].props.onSubmit({ preventDefault() {} });
async function harness(handler) {
  let cursor = 0, effects = [], slots = [], calls = [], updates = 0;
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) }),
    useRef(value) { const i = cursor++; slots[i] ??= { current: value }; return slots[i]; },
    useState(value) { const i = cursor++; slots[i] ??= { value: typeof value === 'function' ? value() : value }; return [slots[i].value, next => { updates++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, j) => value !== slots[i].deps[j])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } }
  };
  const sandbox = {};
  vm.runInNewContext(source + '\nglobalThis.factory = createSettingsPanel;', sandbox);
  const Component = sandbox.factory(React, React.createElement);
  let call = async (...args) => { calls.push(args); return handler ? handler(...args) : initial(); };
  return {
    calls,
    render() { cursor = 0; const tree = Component({ call }); effects.splice(0).forEach(effect => effect()); return tree; },
    unmount() { slots.forEach(slot => slot.cleanup?.()); },
    replaceCall(next) { call = next; },
    get updates() { return updates; }
  };
}

test('mount loads globally without a session and never offers credential management', async () => {
  const ui = await harness();
  let tree = ui.render();
  assert.equal(ui.calls[0][0], 'settings-state');
  assert.equal(ui.calls[0][1], null);
  assert.equal(JSON.stringify(ui.calls[0][2]), '{}');
  tree = ui.render(); // Flush the state update scheduled by the mount effect.
  assert.match(text(tree), /正在加载配置/);
  await settle(); tree = ui.render();
  assert.equal(tree.props.className, 'dsh-turn-topics topic-settings-page');
  assert.equal(select(tree, 0).props.value, 'one');
  assert.equal(select(tree, 1).props.value, 'alpha');
  assert.equal(select(tree, 2).props.value, 'medium');
  assert.equal(button(tree, '保存设置').props.disabled, true);
  assert.match(text(tree), /设置未更改/);
  assert.match(text(tree), /不修改聊天默认模型/);
  assert.doesNotMatch(text(tree), /API Key|添加Key|启用Key轮换/);
  assert.equal(find(tree, node => node.props?.type === 'password').length, 0, 'no secret input may exist in the settings page');
});

test('a fresh install preselects the first configured model and needs one save', async () => {
  const ui = await harness(() => ({ ...initial(), configured: false, config: { provider: '', model: '', reasoningEffort: '', maxTokens: 1024 } }));
  ui.render(); await settle(); let tree = ui.render();
  assert.equal(select(tree, 0).props.value, 'one');
  assert.equal(select(tree, 1).props.value, 'alpha');
  assert.match(text(tree), /尚未选择模型/);
  assert.equal(button(tree, '保存设置').props.disabled, false, 'first-run save must be reachable even without edits');
  submit(tree); tree = ui.render();
  assert.equal(ui.calls.at(-1)[0], 'settings-save');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1)[2])), { provider: 'one', model: 'alpha', reasoningEffort: '', maxTokens: 1024 });
});

test('save uses null session and exact config payload, then returns clean success state', async () => {
  const pending = deferred();
  const ui = await harness(endpoint => endpoint === 'settings-save' ? pending.promise : initial());
  ui.render(); await settle(); let tree = ui.render();
  number(tree).props.onChange({ target: { value: '512' } }); tree = ui.render();
  assert.equal(button(tree, '保存设置').props.disabled, false);
  submit(tree); tree = ui.render();
  assert.equal(ui.calls.at(-1)[0], 'settings-save'); assert.equal(ui.calls.at(-1)[1], null);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1)[2])), { provider: 'one', model: 'alpha', reasoningEffort: 'medium', maxTokens: 512 });
  assert.equal(button(tree, '正在保存…').props.disabled, true);
  assert.equal(number(tree).props.disabled, true);
  assert.equal(button(tree, '重新加载配置').props.disabled, true);
  pending.resolve({ ...initial(), config: { ...initial().config, maxTokens: 512 } }); await settle(); tree = ui.render();
  assert.match(text(tree), /已保存，后续主题请求使用新设置/);
  assert.equal(button(tree, '保存设置').props.disabled, true);
});

test('failed save keeps draft, exposes error, and allows retry', async () => {
  const ui = await harness(endpoint => { if (endpoint === 'settings-save') throw new Error('INVALID_REQUEST'); return initial(); });
  ui.render(); await settle(); let tree = ui.render();
  number(tree).props.onChange({ target: { value: '800' } }); tree = ui.render(); submit(tree); await settle(); tree = ui.render();
  assert.equal(number(tree).props.value, '800'); assert.equal(button(tree, '保存设置').props.disabled, false);
  assert.match(text(tree), /错误：INVALID_REQUEST/); assert.match(text(tree), /不直接表示密钥失效/);
});

test('provider chooses first model, model capabilities define effort and unsupported saves empty string', async () => {
  const ui = await harness(); ui.render(); await settle(); let tree = ui.render();
  select(tree, 0).props.onChange({ target: { value: 'two' } }); tree = ui.render();
  assert.equal(select(tree, 1).props.value, 'beta'); assert.equal(select(tree, 2).props.value, '');
  assert.deepEqual(find(select(tree, 2), node => node.tag === 'option').map(node => node.props.value), ['', 'minimal', 'high']);
  select(tree, 0).props.onChange({ target: { value: 'one' } }); tree = ui.render();
  select(tree, 1).props.onChange({ target: { value: 'plain' } }); tree = ui.render();
  assert.equal(select(tree, 2).props.disabled, true); assert.equal(select(tree, 2).props.value, '');
  submit(tree); await settle(); assert.equal(ui.calls.at(-1)[2].reasoningEffort, '');
});

test('unknown model remains selected with warning, reload discards draft', async () => {
  let state = initial(); state.config.model = 'unlisted';
  const ui = await harness(() => state); ui.render(); await settle(); let tree = ui.render();
  assert.equal(select(tree, 1).props.value, 'unlisted'); assert.match(text(tree), /当前模型未列/);
  assert.equal(select(tree, 2).props.value, '');
  number(tree).props.onChange({ target: { value: '1000' } }); tree = ui.render();
  state = initial(); button(tree, '重新加载配置').props.onClick(); await settle(); tree = ui.render();
  assert.equal(number(tree).props.value, '256'); assert.equal(select(tree, 1).props.value, 'alpha');
});

test('readonly and invalid max tokens prevent save with clear status', async () => {
  const ui = await harness(() => ({ ...initial(), writable: false })); ui.render(); await settle(); let tree = ui.render();
  assert.equal(button(tree, '保存设置').props.disabled, true); assert.match(text(tree), /配置不可写/); submit(tree); assert.equal(ui.calls.length, 1);
  const writable = await harness(); writable.render(); await settle(); tree = writable.render();
  for (const value of ['', '79', '4097', '80.5']) {
    number(tree).props.onChange({ target: { value } }); tree = writable.render();
    assert.equal(button(tree, '保存设置').props.disabled, true); submit(tree);
  }
  assert.equal(writable.calls.length, 1);
});

test('unmount ignores pending result and late old connection cannot overwrite new draft', async () => {
  const pending = deferred(); const ui = await harness(() => pending.promise);
  ui.render(); ui.unmount(); const updates = ui.updates;
  pending.resolve(initial()); await settle(); assert.equal(ui.updates, updates);
  const old = deferred(); const next = await harness(() => old.promise); next.render();
  next.replaceCall(async () => initial()); next.render(); await settle(); let tree = next.render();
  number(tree).props.onChange({ target: { value: '900' } }); tree = next.render();
  old.resolve({ ...initial(), config: { ...initial().config, maxTokens: 80 } }); await settle(); tree = next.render();
  assert.equal(number(tree).props.value, '900');
});
