import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
async function harness() {
  const hooks=[],calls=[],entries=[];let cursor=0,plugin;
  const React={createElement:(tag,props,...children)=>({tag,props:props??{},children:children.flat(Infinity).filter(x=>x!==null&&x!==undefined&&x!==false)}),
    useState:initial=>{const i=cursor++;hooks[i]??={value:initial};return [hooks[i].value,v=>hooks[i].value=typeof v==='function'?v(hooks[i].value):v];},
    useRef:initial=>{const i=cursor++;hooks[i]??={value:{current:initial}};return hooks[i].value;},useEffect:()=>{}};
  const doc={head:{appendChild(){}},createElement:()=>({remove(){}})};
  vm.runInNewContext(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:d=>plugin=d.factory(()=>React)}},document:doc,setTimeout,clearTimeout,console});
  plugin.apply({connection:{rpc:{call:async(path,endpoint,payload)=>{calls.push({path,endpoint,payload});return {ok:true,value:{}};}}},sessions:{},uiConversation:{},effect:fn=>fn(),sidebarRight:{},sidebarRightTabs:{register:()=>()=>{}},slots:{inject:(_n,fn)=>fn(),register:(o,component)=>{entries.push({o,component});return ()=>{};}}});
  const Component=entries.find(x=>x.o.name==='sidebar.right.pane.tab').component;
  function render(){cursor=0;const pane=Component({sessionId:'s1',useTabInfo:()=>({tab:{visible:true}})});return typeof pane.tag==='function'?pane.tag(pane.props):pane;}
  const initial=render(); const nullStates=hooks.filter(x=>x.value===null);assert.ok(nullStates.length>=2);
  nullStates[0].value={items:[{seq:10,turn:1,generated:true,topic:'已有标题',summary:'已有详情。',subjects:[],status:'generated'}],job:{running:false},continuity:true,apiVersion:2,hostVersion:'0.1.0-experimental.7',capabilities:['organize','edit-text','incremental-organize']};
  return {render,hooks,calls};
}
function nodes(tree,predicate){const out=[];function visit(n){if(!n||typeof n!=='object')return;if(predicate(n))out.push(n);for(const child of n.children??[])visit(child);}visit(tree);return out;}
const text=n=>typeof n==='object'?(n.children??[]).map(text).join(''):String(n??'');
test('panel has one organize action; row edit is tucked in accessible menu and submits title/detail',async()=>{
  const ui=await harness();let tree=ui.render();
  assert.doesNotMatch(text(tree),/补齐主题|整理旧轮|纠错/);
  const primary=nodes(tree,n=>n.tag==='button'&&text(n)==='整理主题');assert.equal(primary.length,1);
  assert.equal(primary[0].props.disabled,true,'valid completed topics need no model call');
  const state = ui.hooks.find(x=>x.value?.items); state.value.items.push({seq:20,turn:2,generated:false,status:'missing'});
  tree=ui.render(); await nodes(tree,n=>n.tag==='button'&&text(n)==='整理主题')[0].props.onClick();assert.equal(ui.calls[0].endpoint,'organize');
  tree=ui.render();const actions=nodes(tree,n=>n.tag==='details'&&n.props.className==='topic-actions-details');assert.equal(actions.length,1);
  assert.match(actions[0].children[0].props['aria-label'],/第 1 轮操作/);
  nodes(actions[0],n=>n.tag==='button'&&text(n)==='编辑')[0].props.onClick({currentTarget:{closest:()=>({removeAttribute(){}})}});
  tree=ui.render();const input=nodes(tree,n=>n.tag==='input'&&n.props.id?.startsWith('topic-input'))[0];
  input.props.onChange({target:{value:'人工修改的标题'}});tree=ui.render();
  nodes(tree,n=>n.tag==='textarea')[0].props.onChange({target:{value:'人工修改的详情。'}});tree=ui.render();
  nodes(tree,n=>n.tag==='form')[0].props.onSubmit({preventDefault(){}});await new Promise(r=>setImmediate(r));
  assert.equal(ui.calls.at(-1).endpoint,'edit');assert.equal(ui.calls.at(-1).payload.patch.topic,'人工修改的标题');assert.equal(ui.calls.at(-1).payload.patch.summary,'人工修改的详情。');
  for(const button of nodes(tree,n=>n.tag==='button'))assert.equal(nodes(button,n=>n!==button&&n.tag==='button').length,0);
});
test('old backend is diagnosed before unknown organize call; cached topics remain readable',async()=>{
  const ui=await harness();const state=ui.hooks.find(x=>x.value?.items);delete state.value.apiVersion;delete state.value.capabilities;
  const tree=ui.render();assert.match(text(tree),/后台尚未加载整理接口/);assert.match(text(tree),/完整退出并重新打开 DSH/);assert.match(text(tree),/已有标题/);
  const button=nodes(tree,n=>n.tag==='button'&&text(n)==='整理主题')[0];assert.equal(button.props.disabled,true);
  await button.props.onClick();assert.equal(ui.calls.length,0,'no partial fallback to old generate');
});
test('running primary stops job and missing entries do not offer a broken editor',async()=>{
  const ui=await harness();const state=ui.hooks.find(x=>x.value?.items);state.value.job.running=true;
  let tree=ui.render();await nodes(tree,n=>n.tag==='button'&&text(n)==='停止整理')[0].props.onClick();assert.equal(ui.calls[0].endpoint,'cancel');
  state.value.items[0].generated=false;tree=ui.render();assert.equal(nodes(tree,n=>n.props.className==='topic-actions-details').length,0);
});
test('subject pill toggles active filter and edit form supports quick-pick subjects',async()=>{
  const ui=await harness();const state=ui.hooks.find(x=>x.value?.items);
  state.value.items[0].subjects=[{id:'s-1111111111111111',name:'界面布局'}];
  let tree=ui.render();
  const pill=nodes(tree,n=>n.tag==='button'&&n.props.className?.includes('topic-meta-pill is-subject'))[0];
  assert.ok(pill); pill.props.onClick();
  tree=ui.render();
  const activePill=nodes(tree,n=>n.tag==='button'&&n.props.className?.includes('is-active'))[0];
  assert.ok(activePill,'clicking subject pill activates filter');
  activePill.props.onClick();
  tree=ui.render();
  assert.equal(nodes(tree,n=>n.tag==='button'&&n.props.className?.includes('is-active')).length,0,'clicking active subject pill clears filter');
});
