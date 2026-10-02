<template>
  <svg ref="surface" class="interaction-hit" :viewBox="`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel" @lostpointercapture="cancel">
    <rect v-for="(zone,index) in zones" :key="index" :data-standing-region="zone.part" :x="bounds.x+zone.x*bounds.width" :y="bounds.y+zone.y*bounds.height" :width="zone.w*bounds.width" :height="zone.h*bounds.height" class="touch-region" :class="{ touching:contact===zone.part }" role="button" :tabindex="disabled?-1:0" :aria-disabled="disabled" :aria-label="`轻触${labels[zone.part]}`" @keydown.enter.prevent="keyboard(zone)" @keydown.space.prevent="keyboard(zone)" />
  </svg>
</template>
<script setup>
import {ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {pointerInStanding} from '../../utils/standingInteractionGeometry.js'
import {TOUCH_ZONES as zones,TOUCH_LABELS as labels,touchPartAt} from '../../utils/standingTouch.js'
const props=defineProps({bounds:{type:Object,required:true},disabled:Boolean,generation:Number})
const emit=defineEmits(['action','contact'])
const surface=ref(null),contact=ref(null)
let pointer=null,started=0,startPart=null,startScreen=null,startPoint=null
function cancel(){const id=pointer;pointer=null;contact.value=null;startPart=null;emit('contact',null);if(id!==null&&surface.value?.hasPointerCapture(id))surface.value.releasePointerCapture(id)}
function down(e){
  if(props.disabled||e.button!==0||!e.isPrimary){cancel();return}
  const point=pointerInStanding(surface.value,e,props.bounds),part=touchPartAt(point,props.bounds)
  if(!part)return
  pointer=e.pointerId;started=performance.now();startPart=part;contact.value=part
  startScreen={x:e.clientX,y:e.clientY};startPoint=point
  emit('contact',{part,point})
  surface.value.setPointerCapture(pointer);e.preventDefault()
}
function move(e){if(e.pointerId===pointer)contact.value=touchPartAt(pointerInStanding(surface.value,e,props.bounds),props.bounds)}
function up(e){
  if(e.pointerId!==pointer)return
  const stationary=startScreen&&Math.hypot(e.clientX-startScreen.x,e.clientY-startScreen.y)<12
  const point=stationary?startPoint:pointerInStanding(surface.value,e,props.bounds),part=stationary?startPart:touchPartAt(point,props.bounds)
  // A deforming head can move away from a resting fingertip. Preserve the
  // original hit for a stationary press; dragging still checks the release zone.
  const valid=!props.disabled&&part===startPart&&performance.now()-started<4000
  cancel();if(valid)emit('action',part,point)
}
function keyboard(zone){if(!props.disabled)emit('action',zone.part,{x:(props.bounds.x+(zone.x+zone.w/2)*props.bounds.width)/props.bounds.imageWidth,y:(props.bounds.y+(zone.y+zone.h/2)*props.bounds.height)/props.bounds.imageHeight})}
function otherPointer(e){if(pointer!==null&&e.pointerId!==pointer)cancel()}
watch(()=>[props.disabled,props.bounds,props.generation],cancel)
onMounted(()=>{window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);document.addEventListener('pointerdown',otherPointer,true)})
onBeforeUnmount(()=>{cancel();window.removeEventListener('blur',cancel);window.removeEventListener('resize',cancel);document.removeEventListener('pointerdown',otherPointer,true)})
</script>
<style scoped>
.interaction-hit{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;touch-action:none;user-select:none}
.touch-region{fill:transparent;pointer-events:all;cursor:pointer;stroke:transparent;vector-effect:non-scaling-stroke}
.touch-region:focus-visible{stroke:var(--accent);stroke-width:2;outline:none}
.touch-region[aria-disabled=true]{cursor:default}
</style>
