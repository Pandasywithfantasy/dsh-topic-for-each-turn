import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewTarget, installPreview } from '../src/preview.js';
class Element {
  constructor(tag = 'div') { this.tag = tag; this.attrs = {}; this.children = []; this.dataset = {}; this.textContent = ''; }
  get id() { return this.attrs.id; }
  setAttribute(k,v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(x) { x.parentNode = this; this.children.push(x); return x; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } }
  closest(s) { if (s.includes('hidden')) return null; return s === '[data-conversation-session]' ? this.root : s === 'nav[aria-label]' ? this.nav : null; }
  querySelectorAll(s) { if (s === '[role="tooltip"]') return this.children.filter(x => x.attrs.role === 'tooltip'); return this.buttons ?? []; }
}
function fixture(label = '跳转到第 8 轮') {
  const root = new Element(), nav = new Element('nav'), tip = new Element(), button = new Element('button');
  root.dataset.conversationSession = 's1'; nav.setAttribute('aria-label', '轮次导航');
  tip.setAttribute('role', 'tooltip'); tip.setAttribute('id', ':r1:');
  const original = new Element(); original.textContent = '原生提问'; tip.appendChild(original); nav.appendChild(tip);
  button.root = root; button.nav = nav; button.setAttribute('aria-label', label); button.setAttribute('aria-describedby', ':r1:'); root.buttons = [button];
  const document = { body: root, createElement: tag => new Element(tag), querySelectorAll: () => [root] };
  let notify, disconnected = false;
  class Observer { constructor(fn) { notify = fn; } observe() {} disconnect() { disconnected = true; } }
  return { root, nav, tip, button, original, document, Observer, notify: () => notify(), disconnected: () => disconnected };
}
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
test('rail mapping uses accessible turn identity, not virtual index or cache position', () => {
  const f = fixture(); assert.equal(previewTarget(f.button).turn, 8);
  f.nav.setAttribute('aria-label', 'Turn navigation'); f.button.setAttribute('aria-label', 'Load and jump to turn 123');
  assert.equal(previewTarget(f.button).turn, 123);
  f.button.setAttribute('aria-label', '其他按钮 123'); assert.equal(previewTarget(f.button), null);
  f.button.setAttribute('aria-label', 'Jump to turn 123'); f.nav.setAttribute('aria-label', 'Other navigation'); assert.equal(previewTarget(f.button), null);
});
test('generated overlay preserves native nodes, id and navigation; disable restores', async () => {
  const f = fixture(); let calls=0;
  const adapter = installPreview({ ...f, schedule:()=>0, unschedule:()=>{}, call:async endpoint=>{ assert.equal(endpoint,'state'); calls++; return {items:[{turn:8,generated:true,topic:'接口错误修复验证',summary:'已完成修复。'}]}; } });
  await flush(); assert.equal(calls,1); assert.equal(f.tip.children[0],f.original);
  assert.equal(f.tip.getAttribute('data-dsh-topic-preview'),'generated'); assert.equal(f.tip.id,':r1:');
  assert.equal(f.tip.children[1].children[0].textContent,'接口错误修复验证');
  f.notify(); await flush(); assert.equal(f.tip.children.length,2); assert.equal(calls,1);
  adapter.setEnabled(false); await flush(); assert.deepEqual(f.tip.children,[f.original]);
  adapter.dispose(); assert.equal(f.disconnected(),true);
});
test('late response revalidates active tooltip and cannot show stale turn', async () => {
  const f=fixture(); let resolve;
  const adapter=installPreview({...f,schedule:()=>0,unschedule:()=>{},call:()=>new Promise(r=>resolve=r)});
  await flush(); f.button.setAttribute('aria-label','跳转到第 9 轮');
  resolve({items:[{turn:8,generated:true,topic:'不能串到下一轮',summary:'旧轮次结果。'}]});
  await flush(); assert.equal(f.tip.children.length,1); adapter.dispose();
});
test('missing/failed leaves native preview visible; transport error restores native', async () => {
  const f=fixture(); let clock=0, fail=false;
  const adapter=installPreview({...f,now:()=>clock,schedule:()=>0,unschedule:()=>{},call:async()=>{if(fail)throw Error('offline');return {items:[{turn:8,status:'failed',generated:false}]};}});
  await flush(); assert.equal(f.tip.getAttribute('data-dsh-topic-preview'),'pending'); assert.match(f.tip.children[1].textContent,/失败/);
  clock=6000; fail=true; f.notify(); await flush(); assert.equal(f.tip.children.length,1); adapter.dispose();
});
test('duplicate turn identities fail closed, dispose prevents late DOM mutation', async () => {
  const f=fixture(); const adapter=installPreview({...f,schedule:()=>0,unschedule:()=>{},call:async()=>({items:[{turn:8},{turn:8}]})});
  await flush(); assert.equal(f.tip.children.length,1);adapter.dispose();
  const g=fixture(); let resolve; const other=installPreview({...g,schedule:()=>0,unschedule:()=>{},call:()=>new Promise(r=>resolve=r)});
  await flush(); other.dispose(); resolve({items:[{turn:8,generated:true,topic:'停止后不可渲染',summary:'停止。'}]});await flush();assert.equal(g.tip.children.length,1);
});
