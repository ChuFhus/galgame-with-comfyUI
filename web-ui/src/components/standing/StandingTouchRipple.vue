<template>
  <div class="touch-ripple" aria-hidden="true"><span ref="first" /><span ref="second" /></div>
</template>
<script setup>
import {ref,onMounted,onBeforeUnmount} from 'vue'
const first=ref(null),second=ref(null)
const animations=[]
onMounted(()=>{
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches
  for(const [index,element] of [first.value,second.value].entries()){
    animations.push(element.animate([
      {transform:'scale(.15)',opacity:0,offset:0},
      {transform:'scale(.45)',opacity:index?.4:.7,offset:.16},
      {transform:`scale(${reduced?1.2:1.9})`,opacity:0,offset:1},
    ],{duration:reduced?520:720,delay:index*90,easing:'linear',fill:'both'}))
  }
})
onBeforeUnmount(()=>animations.forEach(animation=>animation.cancel()))
</script>
<style scoped>
.touch-ripple{position:absolute;width:0;height:0;pointer-events:none;z-index:2}
.touch-ripple span{position:absolute;left:-20px;top:-20px;width:40px;height:40px;box-sizing:border-box;border:2px solid var(--accent);border-radius:50%;opacity:0;pointer-events:none;transform-origin:center}
.touch-ripple span+span{border-width:1px}
</style>
