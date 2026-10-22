import test from 'node:test';
import assert from 'node:assert/strict';
import { TopicEngine, extractTurns, TopicStore } from '../src/core.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const log=(turn,seq)=>[
  {type:'turn/start',seq,data:{turn}},
  {type:'user/message',seq:seq+1,data:{source:{kind:'user'},content:[{type:'text',text:'问题'+turn}]}},
  {type:'assistant/message',seq:seq+2,data:{message:{content:[{type:'text',text:'已完成核验'+turn}]}}},
  {type:'turn/end',seq:seq+3,data:{turn,reason:{kind:'completed'}}}
];
async function setup(){
  const store=new TopicStore(await mkdtemp(join(tmpdir(),'topic-fork-'))),records=new Map(),calls=[];
  records.set('parent',{session:{id:'parent'},inheritedEventCount:0,events:[...log(1,0),...log(2,4),...log(3,8)]});
  records.set('child',{session:{id:'child',parentSession:'parent',isSeeded:true},inheritedEventCount:8,events:[...log(1,0),...log(2,4),{type:'session/end-seed',seq:8,data:{inherited:true}}]});
  const readSession=async id=>{const record=records.get(id);if(!record)throw Object.assign(new Error('missing'),{code:'SESSION_QUERY_SESSION_NOT_FOUND'});return structuredClone(record);};
  const engine=new TopicEngine({store,readSession,readTurns:async id=>extractTurns((await readSession(id)).events),generate:async(t,id)=>{calls.push([id,t.turn]);return {topic:'测试轮次'+t.turn,summary:'已核验。'};}});
  await engine.start('parent');await engine.idle();return {engine,store,records,calls};
}

test('inherits only completed prefix with fingerprints, preserves edits and backwards relation; no model call',async()=>{
  const {engine,store,calls}=await setup();let originals=await store.read('parent');
  originals[0].edited=true;originals[1].relation={seq:0,turn:1,kind:'continue',fingerprint:originals[0].fingerprint,revision:originals[0].updatedAt};
  await store.save('parent',originals);const state=await engine.state('child');
  const copied=await store.read('child');assert.equal(copied.length,2);assert.equal(copied[0].edited,true);assert.equal(copied[1].relation.seq,0);assert.equal(state.items[1].relation.turn,1);assert.equal(calls.length,3);
  await engine.start('child');await engine.idle();assert.equal(calls.length,3);
  originals[0].topic='后续父会话修改';await store.save('parent',originals);await engine.prepare('child');assert.notEqual((await store.read('child'))[0].topic,originals[0].topic);
});

test('mid-turn fork synthetic closers cannot inherit completed parent summary',async()=>{
  const {engine,store,records}=await setup();const child=records.get('child');child.inheritedEventCount=6;
  child.events=[...log(1,0),...log(2,4).slice(0,2),{type:'session/end-seed',seq:6,data:{inherited:true}},{type:'turn/end',seq:7,data:{turn:2,reason:{kind:'forked'}}}];
  await engine.prepare('child');assert.deepEqual((await store.read('child')).map(x=>x.turn),[1]);
});

test('stale parent fingerprint and unrelated subagent do not inherit; child data never overwritten',async()=>{
  const {engine,store,records}=await setup();const originals=await store.read('parent');originals[0].fingerprint='stale';
  await store.save('parent',originals);await engine.prepare('child');assert.deepEqual((await store.read('child')).map(x=>x.turn),[2]);
  const own={...originals[1],topic:'分支独立主题',edited:true};await store.save('child',[own]);await engine.prepare('child');assert.equal((await store.read('child'))[0].topic,own.topic);
  records.set('agent',{...records.get('child'),session:{id:'agent',isSeeded:true,parentSession:'parent',origin:'subagent'}});await engine.prepare('agent');assert.deepEqual(await store.read('agent'),[]);
});

test('nested forks inherit safely and concurrent prepare is idempotent; absent parent is harmless',async()=>{
  const {engine,store,records}=await setup();records.set('grandchild',{...records.get('child'),session:{id:'grandchild',isSeeded:true,parentSession:'child'}});
  await Promise.all([engine.prepare('grandchild'),engine.prepare('grandchild'),engine.prepare('child')]);assert.equal((await store.read('grandchild')).length,2);
  records.delete('parent');await engine.prepare('child');assert.equal((await store.read('child')).length,2);
});

test('relation outside copied valid history is removed rather than pointing at a nonexistent summary',async()=>{
  const {engine,store}=await setup();const items=await store.read('parent');items[0].fingerprint='stale';items[1].relation={seq:0,turn:1,kind:'return',fingerprint:'stale',revision:items[0].updatedAt};
  await store.save('parent',items);await engine.prepare('child');assert.equal((await store.read('child'))[0].relation,null);
});
