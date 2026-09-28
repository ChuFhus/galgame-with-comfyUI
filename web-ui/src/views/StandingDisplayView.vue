<template>
  <main ref="stage" class="standing-display" :class="{ paused: hidden }" aria-label="角色立绘展示">
    <Transition name="standing-character" mode="out-in">
      <div v-if="shown.characterId" :key="shown.characterId" class="standing-actor">
        <div v-if="!shown.imageUrl" class="standing-empty" role="status">
          <p>当前角色未生成{{ shown.missingCount || 1 }}套立绘</p>
          <p>请去角色卡的立绘管理内创建</p>
        </div>
        <Transition name="standing-reason">
          <div v-if="bubble && shown.imageUrl" :key="bubble.id" class="standing-reason" :style="{ bottom: `${geometry.height + 30}px` }" role="status">
            <svg class="thought-cloud" viewBox="0 0 320 140" preserveAspectRatio="none" aria-hidden="true"><path d="M40 112 C8 115 3 77 22 64 C6 40 32 15 59 24 C65 2 101 1 119 16 C140 0 169 5 179 16 C204 0 240 7 249 25 C280 15 306 39 294 61 C324 80 309 112 282 111 C271 137 234 135 215 122 C190 141 161 137 148 125 C120 143 91 134 82 121 C65 132 44 130 40 112 Z" /></svg>
            <span class="thought-text">{{ bubble.text }}</span>
            <i class="thought-dot thought-dot-large" aria-hidden="true" /><i class="thought-dot thought-dot-small" aria-hidden="true" />
          </div>
        </Transition>
        <div :key="feedback" class="standing-feedback" :class="{ react: feedback > 0 }">
          <div class="standing-sway"><div class="standing-breath">
            <Transition name="standing-expression">
              <div v-if="shown.imageUrl" :key="shown.imageUrl" class="standing-image" :style="{ width: `${geometry.width}px`, height: `${geometry.height}px` }">
                <img :src="shown.imageUrl" alt="" :style="geometry.image" draggable="false">
              </div>
            </Transition>
          </div></div>
        </div>
      </div>
    </Transition>
  </main>
  <Toast ref="displayToast" />
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Toast from '../components/Toast.vue'
import { getStandingDisplayState } from '../api/index.js'
import { standingGeometry } from '../utils/standingGeometry.js'
import { onEvent, startUnifiedStream, stopUnifiedStream } from '../stores/unifiedStream.js'
const stage = ref(null), shown = ref({}), bubble = ref(null), hidden = ref(document.hidden), feedback = ref(0)
const size = ref({ width: window.innerWidth, height: window.innerHeight })
let latest = null, loadVersion = 0, observer
const originalTitle = document.title
const displayToast = ref(null)
const geometry = computed(() => standingGeometry(shown.value.bounds, size.value.width, size.value.height))
function updateBubble(reason) {
  bubble.value = reason?.text?.trim() ? reason : null
}
async function apply(data) {
  if (latest?.epoch === data.epoch && latest.revision >= data.revision) return
  latest = data
  const ticket = ++loadVersion
  if (data.imageUrl && data.imageUrl !== shown.value.imageUrl) {
    try { await new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = reject; img.src = data.imageUrl }) }
    catch { data = { ...data, imageUrl: null } }
  }
  if (ticket !== loadVersion) return
  const previous = shown.value
  shown.value = data
  if (previous.characterId === data.characterId && previous.replyVersion !== undefined && data.replyVersion > previous.replyVersion) feedback.value++
  updateBubble(data.reason)
}
async function sync() { try { await apply(await getStandingDisplayState()) } catch { /* Retain last frame while disconnected. */ } }
function visibility() { hidden.value = document.hidden; if (!hidden.value) sync() }
const offs = [onEvent('standing_display_state', apply), onEvent('connected', sync)]
onMounted(() => {
  if (new URLSearchParams(window.location.hash.split('?')[1]).get('desktop') === '1') {
    document.title = '用手机查看效果更佳~'
    displayToast.value?.show('用手机查看效果更佳~', 'info', 3000)
  }
  document.documentElement.classList.add('standing-display-only')
  observer = new ResizeObserver(entries => { const r = entries[0].contentRect; size.value = { width: r.width, height: r.height } })
  observer.observe(stage.value)
  document.addEventListener('visibilitychange', visibility)
  startUnifiedStream(); sync()
})
onBeforeUnmount(() => {
  document.title = originalTitle
  loadVersion++; observer?.disconnect(); offs.forEach(fn => fn()); stopUnifiedStream()
  document.removeEventListener('visibilitychange', visibility)
  document.documentElement.classList.remove('standing-display-only')
})
</script>

<style>
.standing-display-only .bg-geo,.standing-display-only .bg-pattern { display:none; }
</style>
<style scoped>
.standing-display { position:fixed; inset:0; background:var(--bg-primary); overflow:hidden; color:var(--text-primary); }
.standing-actor { position:absolute; inset:0; }
.standing-empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:24px; text-align:center; color:var(--text-secondary); font-size:var(--fs-sm); line-height:1.7; }
.standing-empty p { margin:0; }
.standing-empty p:first-child { color:var(--text-primary); font-size:var(--fs-base); font-weight:600; }
.standing-feedback { position:absolute; bottom:max(16px,env(safe-area-inset-bottom)); left:50%; width:0; }
.standing-sway,.standing-breath { position:relative; transform-origin:center bottom; }
.standing-image { position:absolute; bottom:0; left:0; transform:translateX(-50%); overflow:hidden; }
.standing-image img { position:absolute; max-width:none; object-fit:fill; }
.standing-breath { animation:standing-breathe 4.5s ease-in-out infinite; }
.standing-sway { animation:standing-sway 7s ease-in-out infinite; }
.standing-feedback.react { animation:standing-react .4s ease-in-out; }
.standing-reason { position:absolute; left:50%; transform:translateX(-50%); width:max-content; max-width:calc(100% - 40px); padding:23px 34px; font-size:var(--fs-base); overflow-wrap:anywhere; }
.thought-cloud { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.thought-cloud path { fill:var(--modal-bg); stroke:var(--cel-outline); stroke-width:2.5; vector-effect:non-scaling-stroke; stroke-linejoin:round; }
.thought-text { position:relative; display:block; max-height:56px; overflow:auto; text-align:center; }
.thought-dot { position:absolute; background:var(--modal-bg); border:2px solid var(--cel-outline); border-radius:50%; }
.thought-dot-large { width:17px; height:13px; bottom:-13px; left:60%; transform:rotate(-15deg); }
.thought-dot-small { width:8px; height:7px; bottom:-26px; left:56%; }
.standing-character-enter-active,.standing-character-leave-active { transition:transform .3s var(--ease-out),opacity .3s ease; }
.standing-character-enter-from { transform:translateX(100%); opacity:0; }
.standing-character-leave-to { transform:translateX(-100%); opacity:0; }
.standing-expression-enter-active,.standing-expression-leave-active,.standing-reason-enter-active,.standing-reason-leave-active { transition:opacity .3s ease; }
.standing-expression-enter-from,.standing-expression-leave-to,.standing-reason-enter-from,.standing-reason-leave-to { opacity:0; }
.paused * { animation-play-state:paused !important; }
@keyframes standing-breathe { 0%,100% { transform:scaleY(1); } 50% { transform:scaleY(1.005); } }
@keyframes standing-sway { 0%,100% { transform:rotate(-.3deg); } 50% { transform:rotate(.3deg); } }
@keyframes standing-react { 0%,100% { transform:rotate(0); } 50% { transform:rotate(.6deg); } }
</style>
