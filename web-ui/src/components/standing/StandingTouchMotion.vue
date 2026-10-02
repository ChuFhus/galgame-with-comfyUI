<template><div ref="body" class="touch-deform"><slot /></div></template>
<script setup>
import {ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {touchMotionTransform} from '../../utils/standingTouchMotion.js'
const props=defineProps({reaction:Object,contact:Object,bounds:Object})
const body=ref(null)
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)')
let animation=null
function stop(){animation?.cancel();animation=null}
function play(value,held=false){
  if(!body.value)return
  const current=getComputedStyle(body.value).transform
  stop()
  const neutral=touchMotionTransform('head',null,null,0)
  // Keep direct, user-triggered tactile feedback in reduced-motion mode, but
  // remove displacement/rotation/oscillation and limit deformation to 1.6%.
  const transform=amount=>reduced.matches?`scale(${1+.012*amount},${1-.016*amount})`:touchMotionTransform(value.part,value.point,props.bounds,amount)
  const frames=!value?[{transform:current},{transform:neutral}]:held?
    [{transform:current},{transform:transform(.55)}]:reduced.matches?[
      {transform:current,offset:0},{transform:transform(1),offset:.25},{transform:neutral,offset:1},
    ]:[
      {transform:current,offset:0},
      {transform:transform(1),offset:.14},
      {transform:transform(-.34),offset:.4},
      {transform:transform(.14),offset:.65},
      {transform:transform(-.045),offset:.83},
      {transform:neutral,offset:1},
    ]
  const easing=getComputedStyle(body.value).getPropertyValue('--ease-out').trim()||'cubic-bezier(.22,.61,.36,1)'
  animation=body.value.animate(frames,{duration:!value?180:held?120:reduced.matches?480:820,easing,fill:'forwards'})
  const own=animation
  if(!held)own.onfinish=()=>{if(animation===own)stop()}
}
watch(()=>[props.reaction,props.contact],([reaction,contact],[oldReaction,oldContact])=>{
  if(contact){if(!oldContact||contact.part!==oldContact.part)play(contact,true)}
  else if(reaction&&reaction!==oldReaction)play(reaction)
  else if(oldContact||!reaction)play(null)
},{flush:'post'})
watch(()=>props.bounds,stop)
onMounted(()=>reduced.addEventListener('change',stop))
onBeforeUnmount(()=>{stop();reduced.removeEventListener('change',stop)})
</script>
<style scoped>
.touch-deform{position:relative;width:100%;height:100%;transform-origin:50% 100%}
</style>
