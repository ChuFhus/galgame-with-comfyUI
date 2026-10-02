import test from 'node:test'
import assert from 'node:assert/strict'
import {createStandingInteractionLifetime} from '../src/utils/standingInteractionLifetime.js'
test('A to B to A rejects late reads even when the character ID matches again',()=>{
 let key='A/1';const life=createStandingInteractionLifetime({scope:()=>key})
 const a=life.begin();key='B/2';const b=life.begin();key='A/3';const newA=life.begin()
 assert.equal(life.current(a),false);assert.equal(life.current(b),false);assert.equal(life.current(newA),true)
 life.invalidate();assert.equal(life.current(newA),false)
})
test('queued callbacks cannot undo a newer reaction or run after close/character change',()=>{
 let key='A',calls=0;const tasks=[]
 const life=createStandingInteractionLifetime({scope:()=>key,schedule:cb=>{tasks.push(cb);return tasks.length},unschedule:()=>{}})
 life.after('reaction',100,()=>calls++);life.after('reaction',100,()=>calls+=10)
 tasks[0]();assert.equal(calls,0);tasks[1]();assert.equal(calls,10)
 life.after('reaction',100,()=>calls++);key='B';tasks[2]();assert.equal(calls,10)
 life.clear();assert.equal(life.pending(),0)
 life.after('plush',100,()=>calls++);life.dispose();tasks[3]();assert.equal(calls,10);assert.equal(life.pending(),0)
})
test('100 replacement reactions keep the owned timer count bounded',()=>{
 const life=createStandingInteractionLifetime({scope:()=>1,schedule:()=>0,unschedule:()=>{}})
 for(let i=0;i<100;i++){life.after('reaction',100,()=>{});life.after('plush',5000,()=>{});assert.equal(life.pending(),2)}
 life.clear();assert.equal(life.pending(),0)
})
