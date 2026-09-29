<template>
  <linshe-modal :model-value="modelValue" title="HiresFix 细化设置" wide @update:model-value="close">
    <div class="hires-main-body">

          <div class="hires-section hires-params-section">
            <div class="hires-section-title">HiresFix 工作流</div>
            <linshe-tabs v-model="workflowMode" :options="workflowModeOptions" size="md" aria-label="HiresFix 工作流版本" />
            <p class="hires-hint">基础版保留原有官方节点流程，沿用现有生图模型，无需额外安装节点或放大模型。进阶版使用超分模型和分块细化，两套流程都支持全局 LoRA。</p>
            <Transition name="hires-mode" mode="out-in">
            <div v-if="advanced" key="advanced">
            <ol class="hires-setup">
              <li><a href="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth" target="_blank" rel="noopener noreferrer">下载 RealESRGAN_x4plus_anime_6B.pth（官方）</a>。</li>
              <li>放入 <code>ComfyUI/models/upscale_models/</code>，目录不存在时创建；使用共享模型目录的用户，放入 ComfyUI 已配置的 <code>upscale_models</code> 目录。保留文件名。</li>
              <li>在 ComfyUI Manager 中搜索并安装 <a href="https://github.com/ssitu/ComfyUI_UltimateSDUpscale" target="_blank" rel="noopener noreferrer">Ultimate SD Upscale</a> 节点包，然后重启 ComfyUI。</li>
              <li>确认下方模型文件名后保存。未完成配置时请先使用基础版；切换不会自动下载或安装。</li>
            </ol>
            <div class="form-group">
              <label class="fl" for="hires-upscale-model">放大模型<span class="fl-sub">填写 ComfyUI 的 upscale_models 文件名；留空使用普通插值</span></label>
              <linshe-input id="hires-upscale-model" v-model="upscaleModel" placeholder="RealESRGAN_x4plus_anime_6B.pth" />
              <p class="hires-hint">Anime6B 适合动漫线条；其他画风可换放大模型。需安装所填模型及 Ultimate SD Upscale 节点。原图长边 1600 时，设 3200 即两倍放大。</p>
            </div>
            </div>
            <p v-else key="basic" class="hires-hint">基础版使用下方步数、CFG 和重绘幅度；进阶采样及超分设置会保留，切回进阶版可继续使用。</p>
            </Transition>
            <linshe-tabs v-if="advanced" v-model="samplingMode" :options="samplingModeOptions" size="sm" aria-label="采样参数来源" />
            <div aria-live="polite">
            <Transition name="hires-mode" mode="out-in">
              <div :key="samplingPanelMode" class="hires-sampling-panel">
                <template v-if="followSource">
                  <div class="hires-section-title">采样参数自动跟随原图</div>
                  <p class="hires-hint">步数、CFG、采样器和调度器在细化时从对应的源工作流读取；不同原图可能使用不同参数。下方的重绘幅度和最长边仍由你设置。</p>
                  <p class="hires-hint">备用参数：{{ steps }} 步 · CFG {{ cfg }}。仅在源采样参数缺失或无法唯一确定时使用，不代表原图的实际参数。</p>
                  <linshe-button variant="link" size="sm" :aria-expanded="showSamplingFallback" @click="showSamplingFallback = !showSamplingFallback">{{ showSamplingFallback ? '收起备用参数' : '调整备用参数' }}</linshe-button>
                </template>
                <template v-else>
                  <div class="hires-section-title">{{ advanced ? '使用自定义采样参数' : '采样参数' }}</div>
                  <p class="hires-hint">下方步数和 CFG 将直接用于细化；采样器和调度器沿用细化工作流。</p>
                </template>
                <Transition name="hires-mode">
                <div v-if="!followSource || showSamplingFallback" class="hires-params">
                  <div class="form-group">
                    <label class="fl" for="hires-steps">{{ followSource ? '备用步数' : '步数' }}</label>
                    <linshe-input id="hires-steps" v-model.number="steps" type="number" min="1" max="100" step="1" />
                  </div>
                  <div class="form-group">
                    <label class="fl" for="hires-cfg">{{ followSource ? '备用 CFG' : 'CFG' }}</label>
                    <linshe-input id="hires-cfg" v-model.number="cfg" type="number" min="0" max="20" step="0.1" />
                  </div>
                </div>
                </Transition>
              </div>
            </Transition>
            </div>
            <div class="hires-params">
              <div class="form-group">
                <label class="fl">重绘幅度<span class="fl-sub">越低越接近原图；进阶分块细化可从 0.2 开始</span></label>
                <linshe-input v-model.number="denoise" type="number" min="0" max="1" step="0.01" class="fi" />
              </div>
              <div class="form-group">
                <label class="fl">最长边<span class="fl-sub">（像素，默认2000）</span></label>
                <linshe-input v-model.number="maxSize" type="number" min="256" max="8192" step="100" class="fi" />
              </div>
              <div class="form-group">
                <label class="fl" for="hires-global-scale">全局 LoRA 权重倍率<span class="fl-sub">1 沿用，0 不加载；只影响细化，不改生图设置</span></label>
                <linshe-input id="hires-global-scale" v-model.number="globalLoraScale" type="number" min="0" max="2" step="0.05" />
              </div>
              <div v-show="advanced" class="form-group">
                <label class="fl" for="hires-source-blend">原图保留比例<span class="fl-sub">建议 0；混回原图会减弱锐度，改形时可能重影</span></label>
                <linshe-input id="hires-source-blend" v-model.number="sourceBlend" type="number" min="0" max="1" step="0.05" />
              </div>
            </div>
          </div>

          <div class="hires-section hires-artist-section">
            <div class="hires-section-title">画师串</div>
            <linshe-tabs
              v-model="artistMode"
              :options="artistModeOptions"
              size="sm"
              class="artist-segmented"
            />
            <div class="artist-mode-hint">{{ artistModeHint }}</div>
            <Transition name="artist-block">
            <div v-if="artistMode === 'specified'" class="artist-specified-block">
              <linshe-input v-model="artist" class="fi artist-input" placeholder="输入画师串" />
              <p class="artist-input-hint">用于 HiresFix 的画师风格，可覆盖原图画师串</p>
            </div>
            </Transition>
          </div>

          <div class="hires-section hires-lora-section">
            <div class="hires-section-title">LoRA</div>

            <div class="lora-body-card">
            <TransitionGroup name="lora-card" tag="div" class="lora-list">
              <div v-for="(item, idx) in items" :key="idx" class="lora-item-card" :class="{ 'lora-disabled': !item.enabled }">
                <linshe-button variant="icon" size="sm" class="lora-remove-btn" @click="removeLoraGroup(idx)" title="删除 LoRA">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                </linshe-button>
                <div class="lora-item-row">
                  <div class="form-group lora-path-group">
                    <label class="fl lora-inline-label">文件路径</label>
                    <div class="lora-autocomplete-wrap">
                      <linshe-input
                        v-model="item.path"
                        class="fi"
                        autocomplete="off"
                        placeholder="在ComfyUI-aki-v3(或其他名称)\ComfyUI\models\loras下搜索..."
                        @focus="onLoraInputFocus(idx)"
                        @input="onLoraInput(idx)"
                        @keydown="onLoraKeydown($event, idx)"
                        @blur="onLoraInputBlur"
                      />
                      <ul v-if="activeLoraFileIdx === idx && loraSuggestions.length > 0" class="lora-dropdown">
                        <li
                          v-for="(file, di) in loraSuggestions"
                          :key="file.path"
                          :class="['lora-dropdown-item', { active: di === loraDropdownIdx }]"
                          @mousedown.prevent="selectLoraFile(idx, file)"
                        >
                          <span>{{ loraDisplayName(file) }}</span>
                        </li>
                      </ul>
                      <div v-else-if="activeLoraFileIdx === idx && lorasFiles.length === 0 && !loraFetching" class="lora-dropdown" style="padding:16px;text-align:center;font-size:13px;color:var(--text-secondary)">
                        请先在启动器中配置 ComfyUI 路径
                      </div>
                      <div v-else-if="activeLoraFileIdx === idx && loraFetching" class="lora-dropdown" style="padding:16px;text-align:center;font-size:13px;color:var(--text-secondary)">
                        加载中...
                      </div>
                    </div>
                  </div>
                  <div class="form-group lora-weight-group">
                    <label class="fl lora-inline-label">权重</label>
                    <linshe-input
                      v-model.number="item.weight"
                      type="number"
                      step="0.05"
                      min="0"
                      max="5"
                      class="fi lora-weight-input"
                      autocomplete="off"
                    />
                  </div>
                </div>
                <div class="lora-trigger-row">
                  <label class="fl lora-inline-label">触发词</label>
                  <linshe-input v-model="item.triggerWord" class="fi" autocomplete="off" placeholder="可选，用于增强 lora 效果的提示词" />
                  <linshe-switch v-model="item.enabled" size="sm" on-text="已启用" off-text="已禁用" />
                </div>
              </div>
            </TransitionGroup>

            <div v-if="items.length === 0" class="lora-empty-hint">
              可选：添加细化专用 LoRA。同路径配置优先于全局倍率和角色权重。
            </div>

            <div class="lora-add-btn" role="button" tabindex="0" @click="addLoraGroup" @keydown.enter.prevent="addLoraGroup" @keydown.space.prevent="addLoraGroup">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              添加 LoRA
            </div>
            </div>
            </div>
    </div>

    <template #footer>
<span class="lora-civitai-label">请使用与当前底模兼容的 LoRA</span>
      <div style="flex:1"></div>
      <linshe-button variant="primary" @click="save" :disabled="loraLoading">
        {{ loraLoading ? '保存中…' : '保存' }}
      </linshe-button>
    </template>
  </linshe-modal>
</template>

<script setup>
import { ref, computed, watch, inject } from 'vue'
import * as api from '../api/index.js'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  initialUpscaleModel: { type: String, default: 'RealESRGAN_x4plus_anime_6B.pth' },
  initialWorkflowMode: { type: String, default: 'basic' },
  initialSamplingMode: { type: String, default: 'source' },
  initialGlobalLoraScale: { type: Number, default: 1 },
  initialSourceBlend: { type: Number, default: 0 },
  initialLoras: { type: Array, default: () => [] },
  initialSteps: { type: Number, default: 35 },
  initialCfg: { type: Number, default: 5 },
  initialDenoise: { type: Number, default: 0.2 },
  initialMaxSize: { type: Number, default: 2000 },
  initialArtistMode: { type: String, default: 'empty' },
  initialArtist: { type: String, default: '' },
})

const emit = defineEmits(['update:modelValue', 'saved'])

const toastFn = inject('toast')

const upscaleModel = ref('RealESRGAN_x4plus_anime_6B.pth')
const workflowMode = ref('basic')
const workflowModeOptions = [{ value: 'basic', label: '基础版（默认）' }, { value: 'advanced', label: '进阶版' }]
const advanced = computed(() => workflowMode.value === 'advanced')
const samplingMode = ref('source')
const followSource = computed(() => advanced.value && samplingMode.value === 'source')
const samplingPanelMode = computed(() => !advanced.value ? 'basic' : samplingMode.value)
const showSamplingFallback = ref(false)
watch(samplingPanelMode, () => { showSamplingFallback.value = false })
const globalLoraScale = ref(1)
const sourceBlend = ref(0)
const samplingModeOptions = [{ value: 'source', label: '跟随原图' }, { value: 'custom', label: '自定义' }]
const items = ref([])
const steps = ref(35)
const cfg = ref(5)
const denoise = ref(0.2)
const maxSize = ref(2000)
const artistMode = ref('empty')
const artistModeOptions = [
  { value: 'inherit', label: '沿用原图' },
  { value: 'empty', label: '留空' },
  { value: 'specified', label: '指定' },
]
const artist = ref('')
const artistModeHint = computed(() => {
  if (artistMode.value === 'empty') return 'HiresFix 时不使用画师串'
  if (artistMode.value === 'specified') return '使用下方自定义的画师串，可覆盖原图画师串'
  return '继续使用原图中的画师串'
})
const lorasFiles = ref([])
const activeLoraFileIdx = ref(null)
const loraDropdownIdx = ref(-1)
const loraSuggestions = ref([])
const loraFetching = ref(false)
const loraLoading = ref(false)

watch(() => props.modelValue, (v) => {
  if (v) {
    const raw = props.initialLoras.length > 0 ? JSON.parse(JSON.stringify(props.initialLoras)) : []
    for (const item of raw) {
      if (item.enabled === undefined) item.enabled = true
    }
    samplingMode.value = props.initialSamplingMode === 'custom' ? 'custom' : 'source'
    globalLoraScale.value = props.initialGlobalLoraScale
    sourceBlend.value = props.initialSourceBlend
    upscaleModel.value = props.initialUpscaleModel
    workflowMode.value = props.initialWorkflowMode === 'advanced' ? 'advanced' : 'basic'
    showSamplingFallback.value = false
    items.value = raw
    steps.value = Number.isFinite(props.initialSteps) ? props.initialSteps : 35
    cfg.value = Number.isFinite(props.initialCfg) ? props.initialCfg : 5
    denoise.value = Number.isFinite(props.initialDenoise) ? props.initialDenoise : 0.2
    maxSize.value = Number.isFinite(props.initialMaxSize) ? props.initialMaxSize : 2000
    artistMode.value = ['inherit', 'empty', 'specified'].includes(props.initialArtistMode) ? props.initialArtistMode : 'empty'
    artist.value = props.initialArtist || ''
    fetchLorasFiles()
  }
})

function close() {
  emit('update:modelValue', false)
}

function addLoraGroup() {
  items.value.push({ path: '', weight: 1, triggerWord: '', enabled: true })
}

function removeLoraGroup(idx) {
  items.value.splice(idx, 1)
}

async function fetchLorasFiles() {
  loraFetching.value = true
  try {
    const data = await api.fetchLorasFiles()
    lorasFiles.value = data.files || []
  } catch { lorasFiles.value = [] }
  loraFetching.value = false
}

function loraDisplayName(file) {
  return file.source ? `[${file.source}] ${file.name}` : file.name
}

function filterLoras(query) {
  if (!query) return lorasFiles.value
  const q = query.toLowerCase().replace(/\\/g, '/')
  return lorasFiles.value.filter(f => {
    const display = loraDisplayName(f).toLowerCase()
    return display.includes(q) || f.name.toLowerCase().includes(q)
  })
}

function onLoraInputFocus(idx) {
  activeLoraFileIdx.value = idx
  loraDropdownIdx.value = -1
  loraSuggestions.value = filterLoras(items.value[idx]?.path || '')
}

function onLoraInput(idx) {
  activeLoraFileIdx.value = idx
  loraDropdownIdx.value = -1
  loraSuggestions.value = filterLoras(items.value[idx]?.path || '')
}

function onLoraInputBlur() {
  setTimeout(() => { activeLoraFileIdx.value = null }, 150)
}

function selectLoraFile(idx, file) {
  items.value[idx].path = file.name
  activeLoraFileIdx.value = null
}

function onLoraKeydown(e, idx) {
  if (activeLoraFileIdx.value !== idx) return
  const list = loraSuggestions.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    loraDropdownIdx.value = Math.min(loraDropdownIdx.value + 1, list.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    loraDropdownIdx.value = Math.max(loraDropdownIdx.value - 1, -1)
  } else if (e.key === 'Enter' && loraDropdownIdx.value >= 0) {
    e.preventDefault()
    selectLoraFile(idx, list[loraDropdownIdx.value])
  } else if (e.key === 'Escape') {
    activeLoraFileIdx.value = null
  }
}

async function save() {
  const bounded = (value, fallback, max) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : fallback))
  const extraSettings = { workflowMode: workflowMode.value, samplingMode: samplingMode.value, globalLoraScale: bounded(globalLoraScale.value, 1, 2), sourceBlend: bounded(sourceBlend.value, 0, 1), upscaleModel: upscaleModel.value.trim() }
  const validLoras = items.value.filter(l => l.path && l.path.trim())
  const savedSteps = Math.max(1, Math.min(100, parseInt(steps.value, 10) || 35))
  const savedCfg = bounded(cfg.value, 5, 20)
  const savedDenoise = bounded(denoise.value, 0.2, 1)
  const savedMaxSize = Math.max(256, Math.min(8192, parseInt(maxSize.value, 10) || 2000))
  const savedArtistMode = ['inherit', 'empty', 'specified'].includes(artistMode.value) ? artistMode.value : 'empty'
  const savedArtist = (artist.value || '').trim()
  loraLoading.value = true
  try {
    await api.updateHiresSettings({ ...extraSettings, loras: validLoras, steps: savedSteps, cfg: savedCfg, denoise: savedDenoise, maxSize: savedMaxSize, artistMode: savedArtistMode, artist: savedArtist })
    emit('saved', { ...extraSettings, loras: validLoras, steps: savedSteps, cfg: savedCfg, denoise: savedDenoise, maxSize: savedMaxSize, artistMode: savedArtistMode, artist: savedArtist })
    emit('update:modelValue', false)
    if (toastFn) toastFn('HiresFix 设置已保存', 'success')
  } catch (e) {
    console.error('saveHiresSettings failed:', e)
    if (toastFn) toastFn(e.message || '保存失败', 'error')
  } finally {
    loraLoading.value = false
  }
}
</script>

<style scoped>
.hires-sampling-panel { margin: 12px 0 16px; }
.hires-setup { padding-left: 20px; font-size: 12px; line-height: 1.8; color: var(--text-secondary); }
.hires-setup a { color: var(--accent); text-decoration: underline; overflow-wrap: anywhere; }
.hires-setup code { overflow-wrap: anywhere; }
.hires-mode-enter-active, .hires-mode-leave-active { transition: opacity 0.3s ease; }
.hires-mode-enter-from, .hires-mode-leave-to { opacity: 0; }

/* ═══ 弹窗骨架交给 LinsheModal，本组件只保留内容样式 ═══ */

.hires-hint { margin: 0 0 16px; font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
.hires-section { margin-bottom: 16px; }
.hires-section:last-child { margin-bottom: 0; }
.hires-section-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px; }
.hires-params-section {
  background: var(--bg-sunken);
  border: 1px solid var(--tint-subtle);
  border-radius: 10px;
  padding: 12px 14px 14px;
}
.hires-params { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.hires-params .form-group { margin-bottom: 0; }
.hires-params .fi { margin-bottom: 0; }
.hires-artist-section { padding: 0 2px; }
.artist-mode-hint { margin-top: 7px; font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
.artist-specified-block { margin-top: 10px; overflow: hidden; }
.artist-input { margin: 0; }
.artist-block-enter-active, .artist-block-leave-active {
  transition: opacity 0.3s ease, max-height 0.3s ease, margin 0.3s ease;
}
.artist-block-enter-from, .artist-block-leave-to {
  opacity: 0; max-height: 0; margin-top: 0;
}
.artist-block-enter-to, .artist-block-leave-from {
  opacity: 1; max-height: 120px; margin-top: 10px;
}
.artist-input-hint { margin: 6px 0 0; font-size: 11px; color: var(--text-secondary); line-height: 1.5; }

.lora-body-card { background: var(--bg-sunken); border: 1px solid var(--tint-subtle); border-radius: 10px; padding: 12px; }
.lora-list { display: flex; flex-direction: column; gap: 8px; }
.lora-item-card { position: relative; background: var(--bg-primary); border: 1px solid var(--glass-border); border-radius: 12px; padding: 9px 10px 9px 12px; }
.lora-disabled { opacity: 0.45; }
.lora-remove-btn {
  position: absolute; top: 6px; right: 6px; z-index: 1;
}
.lora-item-row { display: flex; gap: 8px; align-items: flex-end; padding-right: 24px; }
.lora-item-row .form-group, .lora-trigger-row .form-group { margin-bottom: 0; }
.lora-path-group { flex: 2; min-width: 0; }
.lora-autocomplete-wrap { position: relative; }
.lora-dropdown {
  position: absolute; left: 0; right: 0; top: calc(100% + 4px);
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  z-index: 10001;
  list-style: none;
  padding: 4px;
  margin: 0;
  box-shadow: 0 8px 32px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.06);
}
.lora-dropdown-item {
  display: flex; align-items: center;
  padding: 9px 10px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-bright);
  border-radius: 6px;
  transition: background 180ms ease, color 180ms ease;
}
.lora-dropdown-item:hover {
  background: rgba(var(--accent-rgb),0.08);
  color: var(--accent);
}
.lora-dropdown-item.active {
  background: rgba(var(--accent-rgb),0.06);
  color: var(--accent);
  font-weight: 600;
}
.lora-weight-group { flex: 0 0 64px; }
.lora-inline-label { font-size: 11px; margin-bottom: 3px; }
.lora-weight-input { text-align: center; padding: 9px 4px; }
.lora-trigger-row { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.lora-trigger-row .lora-inline-label { margin: 0; flex: 0 0 auto; }
.lora-trigger-row .fi { width: auto; flex: 1; min-width: 0; }
.form-group { margin-bottom: 16px; }
.form-group .fl { display: block; margin-bottom: 6px; }
.fl { font-size: 13px; font-weight: 600; color: var(--text-bright); display: block; }
.fl-sub { display: block; margin-top: 2px; font-size: 11px; font-weight: 400; color: var(--text-secondary); line-height: 1.45; }
.lora-card-enter-active, .lora-card-leave-active { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; }
.lora-card-enter-from, .lora-card-leave-to { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; margin-bottom: 0; border-width: 0; }
.lora-card-enter-to, .lora-card-leave-from { opacity: 1; max-height: 120px; }
.lora-empty-hint { text-align: center; font-size: 13px; color: var(--text-secondary); padding: 14px 0 8px; margin-bottom: 0; }
.lora-add-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 8px 0; border: 1.5px dashed var(--glass-border); border-radius: 10px; background: transparent; color: var(--accent); font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s; margin: 4px 0 0; user-select: none; }
.lora-add-btn:hover { border-color: var(--accent); background: rgba(var(--accent-rgb), 0.05); }

.lora-civitai-label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; margin: 0 2px; }
.lora-civitai-link { font-size: 12px; color: var(--accent); text-decoration: none; white-space: nowrap; opacity: 0.85; transition: opacity 0.15s; }
.lora-civitai-link:hover { opacity: 1; text-decoration: underline; }

/* 弹窗动画已迁移至全局 animations.css */

@media (max-width: 767px) {
  .modal-wide .fi { font-size: 16px; }
  .hires-params { grid-template-columns: 1fr; }
}
</style>
