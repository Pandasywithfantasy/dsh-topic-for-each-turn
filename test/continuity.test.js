import test from 'node:test';
import assert from 'node:assert/strict';
import { contextFor, normalizeContinuity, visibleRelation, subject } from '../src/continuity.js';
import { TopicEngine } from '../src/core.js';
const turn = n => ({ seq: n * 10, turn: n, fingerprint: 'f'+n, input: { question: '问题'+n, answer: '结果' } });
const result = { topic: '核验事项连续关联方案', summary: '提出候选，尚未实施。' };
const item = n => ({ ...result, ...turn(n), updatedAt: n, subjects: [subject('缓存方案', 10)] });
test('context is bounded, excludes future/stale and retrieves explicit old reference', () => {
  const turns = Array.from({length:40},(_,i)=>turn(i+1));
  const items = turns.map(t=>item(t.turn)); items[3].fingerprint='stale';
  const current = { ...turn(39), input: { question: '回到第1轮', answer: '继续比较' } };
  const c = contextFor(current, turns, items);
  assert.ok(c.history.length <= 12); assert.ok(c.history.some(i=>i.turn===1));
  assert.ok(c.history.every(i=>i.turn<39 && i.turn!==4)); assert.equal(c.previousTurn,38);
  assert.deepEqual(contextFor(current, turns, items, false), {enabled:false,history:[],subjects:[]});
});
test('host owns subject IDs and accepts only whitelisted backward relation', () => {
  const current=turn(2), c=contextFor(current,[turn(1),current],[item(1)]);
  const old=c.subjects[0];
  const output=normalizeContinuity({subjects:[{id:old.id},{name:'定价'}],relation:{seq:10,kind:'return'}},c,current);
  assert.equal(output.subjects[0].id,old.id); assert.match(output.subjects[1].id,/^s-/); assert.equal(output.relation.turn,1);
  for(const r of [{seq:999,kind:'return'},{seq:10,kind:'causes'}]) assert.equal(normalizeContinuity({relation:r},c,current).relation,null);
  assert.equal(normalizeContinuity({subjects:[{name:'定价'}],relation:{seq:10,kind:'return'}},contextFor(current,[],[],false),current).subjects.length,0);
});
test('changed relation basis is suppressed rather than silently retargeted', () => {
  const i={...item(2),relation:{seq:10,turn:1,kind:'return',fingerprint:'f1',revision:1}};
  assert.equal(visibleRelation(i,[turn(1),turn(2)],[item(1)]).relation.turn,1);
  assert.equal(visibleRelation(i,[turn(1),turn(2)],[{...item(1),updatedAt:9}]).relationChanged,true);
});
test('legacy remains readable; explicit enrich is ordered and does not cascade; edits lock', async () => {
  let items=[item(1)], calls=[]; const turns=[turn(1),turn(2)];
  const engine=new TopicEngine({store:{read:async()=>structuredClone(items),save:async(_id,x)=>{items=structuredClone(x);}},readTurns:async()=>turns,
    generate:async t=>{calls.push(t.turn);return {...result,subjects:[{name:'缓存方案'}],relation:t.context.history[0]?{seq:t.context.history[0].seq,kind:'continue'}:null};}});
  assert.equal((await engine.state('s')).items[0].generated,true);
  await engine.start('s',20);await engine.idle();assert.deepEqual(calls,[2]);
  await engine.start('s',undefined,true);await engine.idle();assert.deepEqual(calls,[2,1]);
  await engine.edit('s',20,{subjects:[{name:'收费方案'}],relation:null});
  await engine.start('s',undefined,true);await engine.idle();assert.deepEqual(calls,[2,1]);
  const state=await engine.state('s');assert.equal(state.items[1].edited,true);assert.equal(state.items[1].relation,null);
});
test('organize repeats all generated rounds in order while preserving manual title and detail', async () => {
  let items=[item(1),item(2)], calls=[];
  const engine=new TopicEngine({store:{read:async()=>structuredClone(items),save:async(_id,x)=>items=structuredClone(x)},readTurns:async()=>[turn(1),turn(2)],
    generate:async t=>{calls.push(t.turn);return {...result,summary:'本轮重新整理。'};}});
  await engine.start('s',undefined,true,true); await engine.idle(); assert.deepEqual(calls,[1,2]);
  const completed=(await engine.state('s')).job;assert.equal(completed.finished,true);assert.equal(completed.phase,'finished');assert.equal(completed.done,2);
  await engine.start('s',undefined,true,true); await engine.idle(); assert.deepEqual(calls,[1,2,1,2]);
  const subjectsBefore=structuredClone(items.find(x=>x.seq===20).subjects);
  await engine.edit('s',20,{topic:'用户修改后的主题名称',summary:'用户明确记录，尚未验证。'});
  await engine.start('s',undefined,true,true);await engine.idle();assert.deepEqual(calls,[1,2,1,2,1]);
  const edited=items.find(x=>x.seq===20);assert.equal(edited.topic,'用户修改后的主题名称');assert.equal(edited.summary,'用户明确记录，尚未验证。');assert.deepEqual(edited.subjects,subjectsBefore);
  await assert.rejects(engine.edit('s',20,{topic:'',summary:'有效描述'}),/长度或文本/);
  assert.equal(items.find(x=>x.seq===20).topic,edited.topic);
});
test('failed rerun retains existing text and exposes per-row failure',async()=>{
  let items=[item(1)];const engine=new TopicEngine({store:{read:async()=>structuredClone(items),save:async(_id,x)=>items=structuredClone(x)},readTurns:async()=>[turn(1)],generate:async()=>{throw new Error('rerun failed');}});
  await engine.start('s',undefined,true,true);await engine.idle();const row=(await engine.state('s')).items[0];
  assert.equal(row.generated,true);assert.equal(row.topic,result.topic);assert.equal(row.error,'rerun failed');
});
test('failed enrichment preserves successful legacy text and late source edits are rejected',async()=>{
  let items=[item(1)], turns=[turn(1)];
  const engine=new TopicEngine({store:{read:async()=>structuredClone(items),save:async(_id,x)=>items=structuredClone(x)},readTurns:async()=>turns,
    generate:async()=>{throw new Error('timeout');}});
  await engine.start('s',undefined,true);await engine.idle();assert.equal(items[0].topic,result.topic);
  engine.generate=async()=>{turns=[{...turn(1),fingerprint:'changed'}];return result;};
  await engine.start('s',undefined,true);await engine.idle();assert.equal(items[0].fingerprint,'f1');
});
