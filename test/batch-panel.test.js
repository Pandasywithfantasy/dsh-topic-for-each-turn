import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../src/batch-panel.js',import.meta.url),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
const idle={running:false,phase:'idle',sessions:0,completed:0,skipped:0,turns:0,failed:0,errors:[]};
const text=n=>n&&typeof n==='object'?n.children.map(text).join(''):String(n??'');
function nodes(tree,p){const found=[];function visit(n){if(!n||typeof n!=='object')return;if(p(n))found.push(n);n.children.forEach(visit);}visit(tree);return found;}
async function harness(handler){
  let cursor=0,slots=[],effects=[],timers=[],calls=[];
  const React={createElement:(tag,props,...children)=>({tag,props:props??{},children:children.flat(Infinity)}),useRef:value=>{const i=cursor++;slots[i]??={current:value};return slots[i];},useState:initial=>{const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,v=>slots[i].value=typeof v==='function'?v(slots[i].value):v];},useEffect:(fn,deps)=>{const i=cursor++;if(!slots[i]||deps.some((d,j)=>d!==slots[i].deps[j])){slots[i]?.cleanup?.();slots[i]={deps};effects.push(()=>slots[i].cleanup=fn());}}};
  const box={setTimeout:fn=>{timers.push(fn);return fn;},clearTimeout:fn=>{timers=timers.filter(x=>x!==fn);}};
  vm.runInNewContext(source+'\nglobalThis.factory=createBatchPanel;',box);
  const Component=box.factory(React,React.createElement);let call=async(...args)=>{calls.push(args);return handler(...args);};
  return {calls,render(){cursor=0;const tree=Component({call,enabled:true});effects.splice(0).forEach(f=>f());return tree;},poll(){timers.shift()?.();},replace(next){call=async(...args)=>{calls.push(args);return next(...args);};},unmount(){slots.forEach(s=>s.cleanup?.());}};
}
const checkbox=tree=>nodes(tree,n=>n.tag==='input')[0];
const button=tree=>nodes(tree,n=>n.tag==='button')[0];

test('global action requires cost confirmation, uses null session, polls progress and offers cancellation',async()=>{
  const ui=await harness(endpoint=>endpoint==='batch-start'?{...idle,running:true,phase:'processing',sessions:5}:endpoint==='batch-cancel'?{...idle,running:true,phase:'stopping',sessions:5}:idle);
  ui.render();await flush();let tree=ui.render();assert.equal(ui.calls[0][0],'batch-state');assert.equal(button(tree).props.disabled,true);
  button(tree).props.onClick();await flush();assert.equal(ui.calls.length,1,'disabled start is also guarded in action');
  checkbox(tree).props.onChange({target:{checked:true}});tree=ui.render();assert.equal(button(tree).props.disabled,false);button(tree).props.onClick();button(tree).props.onClick();await flush();tree=ui.render();
  assert.equal(ui.calls.filter(x=>x[0]==='batch-start').length,1);assert.equal(ui.calls.at(-1)[1],null);assert.match(text(button(tree)),/停止全局/);assert.equal(nodes(tree,n=>n.tag==='progress')[0].props.max,5);
  button(tree).props.onClick();await flush();tree=ui.render();assert.equal(ui.calls.at(-1)[0],'batch-cancel');assert.match(text(tree),/正在停止/);ui.unmount();
});

test('late poll cannot overwrite a newer start response and connection switch clears old state',async()=>{
  let count=0;const poll=deferred();const ui=await harness(endpoint=>{if(endpoint==='batch-state')return count++===0?idle:poll.promise;return {...idle,running:true,phase:'processing',sessions:9};});
  ui.render();await flush();let tree=ui.render();checkbox(tree).props.onChange({target:{checked:true}});tree=ui.render();ui.poll();button(tree).props.onClick();await flush();poll.resolve(idle);await flush();tree=ui.render();assert.match(text(button(tree)),/停止/);
  const next=deferred();ui.replace(()=>next.promise);tree=ui.render();assert.equal(button(tree).props.disabled,true);assert.doesNotMatch(text(tree),/会话 0\/9/);next.resolve(idle);await flush();tree=ui.render();assert.equal(checkbox(tree).props.checked,false);ui.unmount();
});

test('unmount ignores late responses; failed action exposes an alert',async()=>{
  const pending=deferred();const ui=await harness(endpoint=>endpoint==='batch-state'?idle:pending.promise);ui.render();await flush();let tree=ui.render();checkbox(tree).props.onChange({target:{checked:true}});tree=ui.render();button(tree).props.onClick();ui.unmount();pending.resolve({...idle,running:true});await flush();
  const bad=await harness(endpoint=>{if(endpoint==='batch-state')return idle;throw new Error('归档服务不可用');});bad.render();await flush();tree=bad.render();checkbox(tree).props.onChange({target:{checked:true}});tree=bad.render();button(tree).props.onClick();await flush();assert.match(text(bad.render()),/归档服务不可用/);bad.poll();await flush();tree=bad.render();assert.match(text(tree),/归档服务不可用/,'successful polling must not erase an action error');assert.equal(nodes(tree,n=>n.props.role==='alert')[0].props.className,'topic-alert topic-alert-error');bad.unmount();
});
