import {nextTick} from 'vue'
import {TOUCH_LABELS} from '../../src/utils/standingTouch.js'
const wait=ms=>new Promise(r=>setTimeout(r,ms))
function assert(v,m){if(!v)throw new Error(m)}
// Synthetic input exercises real Vue handlers and SVG transforms. Capture is
// emulated only for synthetic pointer IDs; native mouse input is checked separately.
async function pointerSession(part,run){
 const svg=document.querySelector('.interaction-hit'),zone=svg?.querySelector(`[data-standing-region="${part}"]`)
 assert(zone,'缺少默认区域 '+part)
 const descriptors=new Map(),captured=new Set()
 for(const [name,fn] of Object.entries({setPointerCapture:id=>captured.add(id),hasPointerCapture:id=>captured.has(id),releasePointerCapture:id=>captured.delete(id)})){
  descriptors.set(name,Object.getOwnPropertyDescriptor(svg,name));Object.defineProperty(svg,name,{configurable:true,value:fn})
 }
 function emit(type,extra={}){
  const p=svg.createSVGPoint();p.x=zone.x.baseVal.value+zone.width.baseVal.value/2;p.y=zone.y.baseVal.value+zone.height.baseVal.value/2
  const q=p.matrixTransform(svg.getScreenCTM())
  svg.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1001,pointerType:'touch',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:q.x,clientY:q.y,...extra}))
  return {clientX:q.x,clientY:q.y}
 }
 try{await run(emit)}finally{for(const [name,d] of descriptors){if(d)Object.defineProperty(svg,name,d);else delete svg[name]}}
}
export async function runStandingGestureChecks(report){
 const results=[]
 async function check(name,run){try{await run();results.push(`PASS ${name}`)}catch(e){results.push(`FAIL ${name}: ${e.message}`)}report(results.join('\n'))}
 await check('按下形变、松手回弹、恢复原形且不重建图片',async()=>{
  const image=document.querySelector('.standing-image img')
  await pointerSession('head',async emit=>{
   const fixed=emit('pointerdown');await nextTick();await wait(180)
   const body=document.querySelector('.touch-deform')
   if(matchMedia('(prefers-reduced-motion: reduce)').matches)results.push('减少动态效果：仅验证轻柔缩放回位，无位移和振荡')
   assert(getComputedStyle(body).transform!=='none','按下没有形变')
   emit('pointerup',fixed);await nextTick();await wait(150)
   assert(body.getAnimations().some(a=>a.playState==='running'),'没有回弹动画')
   assert(image===document.querySelector('.standing-image img'),'触摸导致图片重建')
   await wait(1250)
   const settled=getComputedStyle(body).transform
   assert(settled==='none'||new DOMMatrix(settled).isIdentity,'未恢复原形')
  })
 })
 for(const [part,label] of Object.entries(TOUCH_LABELS)){
  await wait(700)
  await check(`${label}：默认范围 → 对应缓存台词`,()=>pointerSession(part,async emit=>{
   emit('pointerdown');await nextTick();emit('pointerup');await nextTick()
   assert(document.querySelector('.interaction-note')?.textContent.includes(label),'没有对应部位台词')
  }))
 }
 await wait(3300)
 for(const kind of ['pointercancel','second-pointer','blur','resize'])await check(`${kind} 取消不结算`,()=>pointerSession('head',async emit=>{
  emit('pointerdown');await nextTick()
  if(kind==='second-pointer')emit('pointerdown',{pointerId:1002,isPrimary:false})
  else if(kind==='pointercancel')emit(kind)
  else window.dispatchEvent(new Event(kind))
  await nextTick();emit('pointerup');await nextTick()
  assert(!document.querySelector('.interaction-note'),'取消后仍产生台词')
  assert(!document.querySelector('.touch-region.touching'),'残留触碰状态')
 }))
 return results.every(s=>!s.startsWith('FAIL'))
}
