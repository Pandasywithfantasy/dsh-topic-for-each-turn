import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchOrganizer } from '../src/batch.js';
import { TopicEngine } from '../src/core.js';
const turn = n => ({ turn:n, seq:n*10, fingerprint:'f'+n, input:{question:'问',answer:'答'} });
const result = { topic:'主题测试',summary:'已核验。' };
const deferred = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; };
function memory() { const data=new Map(); return { data,read:async id=>structuredClone(data.get(id)??[]),save:async(id,items)=>data.set(id,structuredClone(items)) }; }
const tick = () => new Promise(r=>setImmediate(r));

test('three sessions start concurrently, fourth waits; turns in each session stay serial', async()=>{
  const store=memory(), gates=Array.from({length:8},deferred), calls=[]; let active=0,max=0;
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1),turn(2)],generate:async(t,id)=>{
    const index=calls.length; calls.push([id,t.turn]); active++;max=Math.max(max,active);await gates[index].promise;active--;return result;
  }});
  for(const id of ['a','b','c','d']) await engine.start(id);
  await tick();assert.deepEqual(calls,[['a',1],['b',1],['c',1]]);assert.equal(max,3);
  await engine.start('a',20);assert.equal(calls.length,3,'duplicate session stays in one worker');
  gates[0].resolve();await tick();assert.deepEqual(calls[3],['a',2]);assert.equal(max,3);
  gates.forEach(g=>g.resolve());await engine.idle();assert.equal(max,3);
  for(const id of ['a','b','c','d'])assert.equal((await store.read(id)).length,2);
});

test('queued cancellation never calls model; failed session does not block other sessions',async()=>{
  const store=memory(),gate=deferred();let calls=[];
  const engine=new TopicEngine({store,concurrency:1,readTurns:async()=>[turn(1)],generate:async(t,id)=>{calls.push(id);await gate.promise;if(id==='a')throw new Error('failure');return result;}});
  for(const id of ['a','b','c'])await engine.start(id);
  await tick();engine.cancel('b');gate.resolve();await engine.idle();assert.deepEqual(calls,['a','c']);assert.equal((await store.read('b')).length,0);
});

test('global run filters archived and subagents, deduplicates, skips valid cache and is idempotent',async()=>{
  const store=memory(),calls=[];store.data.set('done',[{...turn(1),...result,updatedAt:1}]);
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1)],generate:async(t,id)=>{calls.push(id);return result;}});
  const batch=new BatchOrganizer({engine,archivedIds:async()=>['archived'],listSessions:async()=>[
    ...['one','two','done','archived','one'].map(id=>({header:{id}})),{header:{id:'agent',origin:'subagent'}}]});
  batch.start();batch.start();await batch.idle();assert.deepEqual(calls.sort(),['one','two']);assert.equal(batch.state().sessions,3);assert.equal(batch.state().completed,3);assert.equal(batch.state().turns,2);
  batch.start();await batch.idle();assert.equal(calls.length,2);assert.equal(batch.state().turns,0);
});

test('missing archive state fails closed and individual read failure is isolated',async()=>{
  const store=memory(),calls=[];
  const engine=new TopicEngine({store,readTurns:async id=>{if(id==='bad')throw new Error('unreadable');return [turn(1)];},generate:async(t,id)=>{calls.push(id);return result;}});
  const batch=new BatchOrganizer({engine,listSessions:async()=>['bad','ok'].map(id=>({header:{id}})),archivedIds:()=>{throw new Error('archive unavailable');}});
  batch.start();await batch.idle();assert.equal(calls.length,0);assert.match(batch.state().errors[0].message,/archive/);
  batch.archivedIds=()=>[];batch.start();await batch.idle();assert.deepEqual(calls,['ok']);assert.equal(batch.state().failed,1);assert.equal(batch.state().completed,2);
});

test('batch cancellation preserves saved turns and does not cancel a pre-existing manual job',async()=>{
  const store=memory(),gate=deferred(),started=deferred();
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1)],generate:async()=>{started.resolve();await gate.promise;return result;}});
  await engine.start('manual');await started.promise;
  const batch=new BatchOrganizer({engine,archivedIds:()=>[],listSessions:async()=>[{header:{id:'manual'}}]});
  batch.start();await tick();batch.cancel();assert.equal(engine.jobs.get('manual').controller.signal.aborted,false);
  await batch.idle();assert.equal(batch.state().phase,'cancelled');
  gate.resolve();await engine.idle();assert.equal((await store.read('manual')).length,1);
});

test('global run waits for a scoped automatic job then fills older missing rounds',async()=>{
  const store=memory(),gate=deferred(),entered=deferred(),calls=[];
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1),turn(2)],generate:async t=>{calls.push(t.turn);if(t.turn===2){entered.resolve();await gate.promise;}return result;}});
  await engine.start('a',20);await entered.promise;
  const batch=new BatchOrganizer({engine,archivedIds:()=>[],listSessions:async()=>[{header:{id:'a'}}]});batch.start();await tick();gate.resolve();await batch.idle();assert.deepEqual(calls,[2,1]);assert.equal((await store.read('a')).length,2);
});

test('batch rechecks archive state between turns and stops owned calls without removing saved results',async()=>{
  const store=memory();let archived=[],calls=0;
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1),turn(2)],generate:async()=>{calls++;archived=['a'];return result;}});
  const batch=new BatchOrganizer({engine,archivedIds:()=>archived,listSessions:async()=>[{header:{id:'a'}}]});
  batch.start();await batch.idle();assert.equal(calls,1);assert.equal((await store.read('a')).length,1);assert.equal(batch.state().skipped,1);
});

test('cancelling a global job aborts only batch-owned workers and discards pending model results',async()=>{
  const store=memory(),gate=deferred();let entered=deferred();
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1)],generate:async()=>{entered.resolve();await gate.promise;return result;}});
  const batch=new BatchOrganizer({engine,archivedIds:()=>[],listSessions:async()=>[{header:{id:'a'}}]});
  batch.start();await entered.promise;batch.cancel();gate.resolve();await batch.idle();await engine.idle();assert.equal((await store.read('a')).length,0);assert.equal(batch.state().phase,'cancelled');
});

test('manual edits remain protected when original content later changes',async()=>{
  const store=memory();let calls=0;store.data.set('a',[{...turn(1),...result,updatedAt:1,edited:true}]);
  const engine=new TopicEngine({store,readTurns:async()=>[{...turn(1),fingerprint:'changed'}],generate:async()=>{calls++;return result;}});
  await engine.start('a');await engine.idle();assert.equal(calls,0);assert.equal((await store.read('a'))[0].fingerprint,'f1');assert.equal((await engine.state('a')).items[0].edited,true);
});

test('incremental organize skips existing text even when legacy enrichment is missing',async()=>{
  const store=memory(),calls=[];store.data.set('a',[{...turn(1),...result,updatedAt:1}]);
  const engine=new TopicEngine({store,readTurns:async()=>[turn(1),turn(2)],generate:async t=>{calls.push(t.turn);return result;}});
  await engine.start('a');await engine.idle();await engine.start('a');await engine.idle();assert.deepEqual(calls,[2]);
  engine.readTurns=async()=>[{...turn(1),fingerprint:'changed'},turn(2)];await engine.start('a');await engine.idle();assert.deepEqual(calls,[2,1]);
});
