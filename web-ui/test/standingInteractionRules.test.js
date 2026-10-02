import test from 'node:test'
import assert from 'node:assert/strict'
import {createStandingInteractionEngine,standingPresentationChanged,compatibleReactionSlot} from '../src/utils/standingInteractionRules.js'
import {createStandingGesture,moveStandingGesture,standingGestureAction} from '../src/utils/standingInteractionGeometry.js'
test('local teasing, recovery, soothing and idle decay use independent deadlines',()=>{
  let time=0;const e=createStandingInteractionEngine({now:()=>time,random:()=>0}),opts={sleeping:false}
  assert.equal(e.act('feather',opts).level,2)
  time=600;assert.equal(e.act('feather',opts),null)
  time=2000;assert.equal(e.act('feather',opts).motion,'dodge')
  time=2600;assert.equal(e.act('poke',opts),null)
  assert.equal(e.act('plush',opts).level,2)
  time=10600;assert.equal(e.snapshot().level,1)
  time=18600;assert.equal(e.snapshot().level,0)
})
test('unknown state blocks reactions; sleeping allows only passive plush',()=>{
  const e=createStandingInteractionEngine()
  assert.equal(e.act('pat'),null)
  assert.equal(e.act('poke',{sleeping:true}),null)
  assert.equal(e.act('plush',{sleeping:true}).passive,true)
})
test('same revision refresh does not interrupt; replies and image versions do',()=>{
  const s={epoch:'a',selectionVersion:1,characterId:1,imageVersion:2,replyVersion:3}
  assert.equal(standingPresentationChanged(s,{...s,revision:9}),false)
  assert.equal(standingPresentationChanged(s,{...s,replyVersion:4}),true)
  assert.equal(standingPresentationChanged(s,{...s,imageVersion:3}),true)
  assert.equal(compatibleReactionSlot({expressionsEnabled:true,compatibleSources:[]},[],s,'pleased'),null)
})
test('head strokes need movement and time; off-region release cancels',()=>{
  const regions={head:{cx:.5,cy:.2,rx:.2,ry:.1},cheek:null}
  const g=createStandingGesture({point:{x:.5,y:.2},screen:{x:50,y:20},time:0,regions})
  assert.equal(moveStandingGesture(g,{point:{x:.5,y:.2},screen:{x:50,y:20},time:300}),null)
  assert.equal(moveStandingGesture(g,{point:{x:.6,y:.2},screen:{x:80,y:20},time:500}),'stroke')
  assert.equal(standingGestureAction(g,{x:.9,y:.9},510),null)
})
