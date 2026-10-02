import test from 'node:test'
import assert from 'node:assert/strict'
import {pointerInStanding,createStandingGesture,moveStandingGesture,standingGestureAction,hitStandingRegion} from '../src/utils/standingInteractionGeometry.js'
const regions={head:{cx:.5,cy:.2,rx:.2,ry:.1},cheek:{cx:.5,cy:.38,rx:.1,ry:.07}}
const point={x:.5,y:.2}
test('feather needs accumulated motion and 400ms contact, with no tap fallback',()=>{
 const g=createStandingGesture({tool:'feather',point,screen:{x:0,y:0},time:0,regions})
 assert.equal(standingGestureAction(g,point,100),null)
 assert.equal(moveStandingGesture(g,{point,screen:{x:0,y:0},time:500}),null)
 assert.equal(moveStandingGesture(g,{point,screen:{x:9,y:0},time:520}),'feather')
 assert.equal(standingGestureAction(g,{x:0,y:0},530),null)
})
test('leaving head for the cheek for over 150ms resets a head stroke',()=>{
 const g=createStandingGesture({point,screen:{x:0,y:0},time:0,regions})
 moveStandingGesture(g,{point,screen:{x:30,y:0},time:300})
 moveStandingGesture(g,{point:{x:.5,y:.38},screen:{x:30,y:20},time:310})
 assert.equal(moveStandingGesture(g,{point,screen:{x:0,y:0},time:700}),null)
})
test('plush can start away from character, but must finish on a confirmed region',()=>{
 const g=createStandingGesture({tool:'plush',point:{x:1.5,y:1.5},screen:{x:900,y:900},time:0,regions})
 assert.equal(standingGestureAction(g,{x:0,y:0},500),null)
 assert.equal(standingGestureAction(g,point,500),'plush')
 assert.equal(hitStandingRegion({x:.5,y:.2},{head:regions.head,cheek:regions.head}),'cheek')
})
test('source coordinate conversion handles the supplied inverse transform and fails closed',()=>{
 const svg={getScreenCTM:()=>({inverse:()=>({scale:.5,offset:100})}),createSVGPoint:()=>({matrixTransform(m){return {x:this.x*m.scale+m.offset,y:this.y*m.scale}}})}
 assert.deepEqual(pointerInStanding(svg,{clientX:200,clientY:160},{imageWidth:400,imageHeight:800}),{x:.5,y:.1})
 assert.equal(pointerInStanding({getScreenCTM:()=>null},{clientX:1,clientY:1},{}),null)
 assert.equal(pointerInStanding({getScreenCTM:()=>{throw Error('detached')}},{},{}),null)
})
