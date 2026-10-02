<template>
  <linshe-modal :model-value="open" wide :transition-ms="300" :title="`${name || '角色'} · 立绘反馈台词`" @close="$emit('close')">
    <div class="lines-summary">
      <p class="lines-hint" role="status">{{ statusText }}</p>
      <p v-if="error" class="lines-error" role="alert">失败原因：{{ error }}</p>
      <p v-if="dirty" class="lines-hint">有未保存的修改</p>
    </div>
    <div class="lines-toolbar">
      <linshe-button :loading="working==='generate' || generating" :disabled="loading || !!working || generating || dirty" @click="mutate('generate')">{{ state.lines ? '重新生成全部台词' : '生成全部台词' }}</linshe-button>
      <linshe-button variant="ghost" :disabled="!!working" @click="refresh(true)">重新读取</linshe-button>
    </div>
    <p class="lines-description">每处 3 句，每句 4–32 字。生成台词不会重画立绘。</p>
    <div v-if="loading" class="lines-hint">正在读取台词…</div>
    <div v-else class="lines-grid">
      <fieldset v-for="(label,part) in labels" :key="part" class="lines-part">
        <legend>{{ label }}</legend>
        <linshe-input v-for="(_,index) in draft[part]" :key="index" v-model="draft[part][index]" :aria-label="`${label}台词 ${index+1}`" :placeholder="`${label} · 第 ${index+1} 句`" :maxlength="32" :disabled="generating || !!working" />
      </fieldset>
    </div>
    <template #footer>
      <linshe-button variant="primary" :loading="working==='save'" :disabled="loading || !!working || generating || !dirty || !valid" @click="mutate('save')">保存台词</linshe-button>
    </template>
  </linshe-modal>
</template>
<script setup>
import {ref,computed,watch,onBeforeUnmount} from 'vue'
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import {TOUCH_LABELS as labels} from '../../utils/standingTouch.js'
import {getStandingTouchLines,saveStandingTouchLines,generateStandingTouchLines} from '../../api/index.js'
import {onEvent} from '../../stores/unifiedStream.js'
const props=defineProps({open:Boolean,characterId:Number,name:String})
const emit=defineEmits(['close','saved'])
const blank=()=>Object.fromEntries(Object.keys(labels).map(k=>[k,['','','']]))
const draft=ref(blank()),baseline=ref(JSON.stringify(draft.value)),state=ref({status:'empty',version:null,lines:null}),loading=ref(false),working=ref(''),error=ref('')
const dirty=computed(()=>JSON.stringify(draft.value)!==baseline.value)
const generating=computed(()=>state.value.status==='generating')
const valid=computed(()=>Object.values(draft.value).every(list=>list.length===3&&new Set(list.map(s=>s.trim())).size===3&&list.every(s=>[...s.trim()].length>=4&&[...s.trim()].length<=32&&!/[\r\n]/.test(s))))
const statusText=computed(()=>({empty:'尚未生成专属台词，可以单独生成或手动填写。',generating:'台词正在生成，完成后会自动显示。',ready:'当前台词 · 10 个部位，共 30 句',failed:state.value.lines?'上次生成失败，已有台词仍保留。':'上次生成失败，可重新生成或手动填写。'})[state.value.status])
let serial=0,timer
function accept(value,replace=false){
  // Keep the edit version while dirty, so concurrent changes cause a conflict.
  if(replace||!dirty.value){state.value=value;draft.value=JSON.parse(JSON.stringify(value.lines||blank()));baseline.value=JSON.stringify(draft.value)}
  else state.value={...value,version:state.value.version}
}
async function refresh(replace=false){
  if(!props.open||!props.characterId||working.value)return
  const ticket=++serial,id=props.characterId
  try{const value=await getStandingTouchLines(id);if(ticket!==serial||!props.open||id!==props.characterId)return;accept(value,replace);error.value=value.error||''}
  catch(e){if(ticket===serial)error.value=e.message}
  finally{if(ticket===serial)loading.value=false}
}
async function mutate(kind){
  if(working.value||generating.value)return
  const id=props.characterId,ticket=++serial;working.value=kind;error.value=''
  try{
    const value=kind==='save'?await saveStandingTouchLines(id,{expectedVersion:state.value.version,lines:JSON.parse(JSON.stringify(draft.value))}):await generateStandingTouchLines(id,state.value.version)
    if(ticket!==serial||!props.open||id!==props.characterId)return
    accept(value,true);emit('saved')
  }catch(e){if(ticket===serial)error.value=e.message}
  finally{if(ticket===serial)working.value=''}
}
watch(()=>[props.open,props.characterId],()=>{
  serial++;clearInterval(timer);working.value='';error.value=''
  if(!props.open)return
  draft.value=blank();baseline.value=JSON.stringify(draft.value);state.value={status:'empty',version:null,lines:null};loading.value=true
  refresh(true);timer=setInterval(()=>refresh(),2500)
},{immediate:true})
const off=onEvent('expression_standings_updated',e=>{if(String(e.characterId)===String(props.characterId))refresh()})
onBeforeUnmount(()=>{serial++;clearInterval(timer);off()})
</script>
<style scoped>
.lines-hint{font-size:var(--fs-sm);color:var(--text-secondary);margin:0;line-height:1.6}
.lines-summary{display:grid;gap:6px;min-width:0}
.lines-error{margin:0;font-size:var(--fs-sm);line-height:1.6;color:var(--fun-pink);overflow-wrap:anywhere}
.lines-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:16px 0 10px}
.lines-description{margin:0 0 20px;font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.6;overflow-wrap:anywhere}
.lines-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.lines-part{min-width:0;margin:0;padding:12px;display:grid;gap:8px;border:1px solid var(--border);border-radius:var(--radius-md)}
.lines-part legend{padding:0 6px;font-weight:600;font-size:var(--fs-sm);color:var(--text-primary)}
@media(max-width:600px){.lines-grid{grid-template-columns:1fr}}
</style>
