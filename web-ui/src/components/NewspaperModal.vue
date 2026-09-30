<template>
  <linshe-modal
    v-model="visible"
    full
    title="邻舍日报"
    panel-class="np-panel"
    body-class="np-body"
    @close="emit('close')"
  >
    <template #header-extra>
      <span v-if="editions.length" class="np-edition-nav">
        <linshe-button
          variant="icon"
          size="sm"
          title="上一期（更早）"
          :disabled="!canNavOlder || navLoading"
          @click="navEdition(1)"
        >‹</linshe-button>
        <span class="np-header-meta">{{ headerMeta || '今天的报纸还没印好' }}</span>
        <linshe-button
          variant="icon"
          size="sm"
          title="下一期（更新）"
          :disabled="!newerTarget || navLoading"
          @click="navEdition(-1)"
        >›</linshe-button>
      </span>
      <span v-else-if="paper" class="np-header-meta">第{{ paper.edition }}期 · {{ formatDate(paper.publish_date) }}</span>
    </template>

    <!-- 加载骨架 -->
    <div v-if="loading" class="np-skeletons">
      <div class="skeleton np-sk-line"></div>
      <div class="skeleton np-sk-block"></div>
      <div class="skeleton np-sk-block"></div>
    </div>

    <!-- 还没印好 -->
    <div v-else-if="!paper" class="empty np-empty">
      <div class="np-empty-icon">📰</div>
      <p class="np-empty-title">今天的报纸还没印好</p>
      <p class="np-empty-hint">每天零点由镇口公告站准时印发</p>
      <linshe-button size="sm" :loading="urging" @click="urgePrint">催一下印刷机</linshe-button>
    </div>

    <!-- 报纸版面：一整版铺满窗口，内容压在一页内 -->
    <article v-else class="np-paper" :class="{ 'is-past-view': !isToday }">
      <!-- 报头 -->
      <header class="np-masthead">
        <div class="np-mast-row">
          <span class="np-mast-side">镇口公告站 · 编印</span>
          <h1 class="np-mast-name">{{ paper.name || '邻舍日报' }}</h1>
          <span class="np-mast-side np-mast-side-right">第 {{ paper.edition }} 期</span>
        </div>
        <div class="np-dateline">
          <span>{{ formatDate(paper.publish_date) }}</span>
          <span class="np-dateline-dot">◆</span>
          <span>{{ NEWSPAPER_TAGLINE }}</span>
          <span class="np-dateline-end">头版 · 共 {{ totalCount }} 条</span>
        </div>
        <!-- 期号切换条：目标期信息直接写在按钮上，一眼可点 -->
        <nav v-if="editions.length" class="np-edition-switch" aria-label="切换期号">
          <linshe-button
            variant="chip"
            size="sm"
            title="查看更早的一期"
            :disabled="!olderTarget || navLoading"
            @click="navEdition(1)"
          >‹ 上一期<span v-if="olderTarget && !olderTarget.today" class="np-ed-switch-target"> · {{ editionShortLabel(olderTarget) }}</span></linshe-button>
          <span class="np-edition-current">{{ currentLabel }}</span>
          <linshe-button
            variant="chip"
            size="sm"
            title="查看更新的一期"
            :disabled="!newerTarget || navLoading"
            @click="navEdition(-1)"
          >下一期<span v-if="newerTarget" class="np-ed-switch-target"> · {{ newerTarget.today ? '今天' : editionShortLabel(newerTarget) }}</span> ›</linshe-button>
        </nav>
      </header>

      <!-- 版面：三栏（左 = 异闻+前半新闻 / 中 = 人物特稿 / 右 = 后半新闻） -->
      <div class="np-sheet" :class="{ 'np-sheet--nolead': !paper.character_event }">
        <div class="np-col">
          <section
            v-if="paper.world_state"
            class="np-world np-clickable"
            role="button"
            tabindex="0"
            @click="openDetail({ kind: 'world' })"
            @keydown.enter="openDetail({ kind: 'world' })"
          >
            <div class="np-world-head">
              <span class="np-world-stamp">今日异闻</span>
              <h3 class="np-world-name">{{ paper.world_state.name }}</h3>
              <span v-if="worldDismissed" class="np-world-dismissed-stamp">影响已消除</span>
            </div>
            <figure v-if="paper.world_state.image" class="np-figure np-figure-wrap">
              <img :src="paper.world_state.image" :alt="paper.world_state.name" loading="lazy" />
            </figure>
            <p v-if="paper.world_state.description" class="np-text np-clamp-2">{{ paper.world_state.description }}</p>
            <p v-if="paper.world_state.news" class="np-text np-text-secondary np-clamp-3">{{ paper.world_state.news }}</p>
          </section>
          <div class="np-col-list">
            <section
              v-for="(item, i) in leftItems"
              :key="`l-${i}`"
              class="np-article np-clickable"
              role="button"
              tabindex="0"
              @click="openDetail({ kind: 'item', index: i })"
              @keydown.enter="openDetail({ kind: 'item', index: i })"
            >
              <span class="np-cat">{{ item.category }}</span>
              <h4 class="np-article-title np-clamp-2">{{ item.title }}</h4>
              <figure v-if="item.image" class="np-figure np-figure-wrap">
                <img :src="item.image" :alt="item.title" loading="lazy" />
              </figure>
              <div v-else class="np-img-placeholder np-figure-wrap">{{ isToday ? '配图印刷中…' : '本期配图缺失' }}</div>
              <p :class="['np-text', 'np-text-sm', item.image ? 'np-clamp-6' : 'np-clamp-4']">{{ item.content }}</p>
            </section>
          </div>
        </div>

        <!-- 中栏：人物特稿（头条） -->
        <div v-if="paper.character_event" class="np-col">
          <article
            class="np-lead np-clickable"
            role="button"
            tabindex="0"
            @click="openDetail({ kind: 'lead' })"
            @keydown.enter="openDetail({ kind: 'lead' })"
          >
            <div class="np-lead-head">
              <span class="np-cat np-cat-lead">人物特稿</span>
              <span v-if="leadAuthorName" class="np-lead-author">
                <img v-if="leadAuthorAvatar" :src="leadAuthorAvatar" alt="" class="np-lead-avatar" />
                {{ leadAuthorName }}
              </span>
            </div>
            <h2 class="np-lead-title np-clamp-2">{{ paper.character_event.title }}</h2>
            <figure v-if="paper.character_event.image" class="np-figure np-lead-figure">
              <img :src="paper.character_event.image" :alt="paper.character_event.title" loading="lazy" />
            </figure>
            <div v-else class="np-img-placeholder np-lead-figure">{{ isToday ? '配图印刷中…' : '本期配图缺失' }}</div>
            <p class="np-text np-lead-text np-clamp-5">{{ paper.character_event.content }}</p>
          </article>
        </div>

        <div class="np-col">
          <div class="np-col-list">
            <section
              v-for="(item, i) in rightItems"
              :key="`r-${i}`"
              class="np-article np-clickable"
              role="button"
              tabindex="0"
              @click="openDetail({ kind: 'item', index: i + leftItems.length })"
              @keydown.enter="openDetail({ kind: 'item', index: i + leftItems.length })"
            >
              <span class="np-cat">{{ item.category }}</span>
              <h4 class="np-article-title np-clamp-2">{{ item.title }}</h4>
              <figure v-if="item.image" class="np-figure np-figure-wrap">
                <img :src="item.image" :alt="item.title" loading="lazy" />
              </figure>
              <div v-else class="np-img-placeholder np-figure-wrap">{{ isToday ? '配图印刷中…' : '本期配图缺失' }}</div>
              <p :class="['np-text', 'np-text-sm', item.image ? 'np-clamp-6' : 'np-clamp-4']">{{ item.content }}</p>
            </section>
          </div>
        </div>
      </div>

      <!-- 报尾 -->
      <footer class="np-colophon">
        <span>《{{ paper.name }}》 · {{ totalCount }} 条今日预告</span>
        <span class="np-colophon-hint">点击任意新闻，读全文、看大图</span>
        <span class="np-colophon-motto">今日事，早知道</span>
      </footer>

      <!-- 新闻详情：盖在版面上的「摊开的一页」 -->
      <Transition name="np-detail-fade">
        <div v-if="detailArticle" class="np-detail" @click.self="closeDetail">
          <div class="np-detail-scroll">
            <div class="np-detail-bar">
              <span class="np-cat" :class="{ 'np-cat-lead': detailArticle.kind === 'lead' }">{{ detailArticle.cat }}</span>
              <span
                class="np-back"
                role="button"
                tabindex="0"
                @click="closeDetail"
                @keydown.enter="closeDetail"
              >‹ 返回头版</span>
              <!-- 世界异闻专有：开关今天的影响（消除后异闻文本保留在版面上，但不再影响任何角色）；历史期只读 -->
              <linshe-button
                v-if="isToday && detailArticle.kind === 'world' && paper.world_state"
                class="np-dismiss-btn"
                size="sm"
                :variant="worldDismissed ? 'secondary' : 'danger'"
                :disabled="dismissing"
                :loading="dismissing"
                @click.stop="dismissWorld"
              >{{ worldDismissed ? '恢复今日影响' : '消除今日影响' }}</linshe-button>
            </div>
            <h2 class="np-detail-title">{{ detailArticle.title }}</h2>
            <div v-if="detailArticle.author" class="np-detail-byline">
              <img v-if="detailArticle.avatar" :src="detailArticle.avatar" alt="" class="np-lead-avatar" />
              特约记者 · {{ detailArticle.author }}
            </div>
            <figure v-if="detailArticle.image" class="np-detail-figure" @click="zoomSrc = detailArticle.image">
              <img :src="detailArticle.image" :alt="detailArticle.title" />
              <figcaption class="np-detail-caption">▲ 本报插画 · 点击放大</figcaption>
            </figure>
            <div v-else class="np-img-placeholder np-detail-nofimg">{{ isToday ? '配图印刷中…' : '本期配图缺失' }}</div>
            <p class="np-detail-text">{{ detailArticle.content }}</p>
          </div>
        </div>
      </Transition>

      <!-- 图片放大：Teleport 到 body 全局层级（高于日报弹窗本体，低于 Toast） -->
      <Teleport to="body">
        <div style="--vel-z-index: 11000">
          <ImageLightbox
            :visible="!!zoomSrc"
            :imgs="zoomSrc ? [zoomSrc] : []"
            @hide="zoomSrc = ''"
          />
        </div>
      </Teleport>
    </article>
  </linshe-modal>
</template>

<script setup>
// 《邻舍日报》——小镇预告报纸阅读窗。
// 纸面视觉属于设计系统的「质感岛」例外家族（同信箱/世界观编辑器）：固定暖纸底 + 墨色文字，
// 不随暗夜主题切换；窗体外壳仍由 LinsheModal 统一提供。
// 版面口径：整版铺满窗口（桌面三栏，特稿居中当头条），正文行数压裁保证一页装下；
// 点击任意新闻块弹出详情页（全文 + 大图），详情里点图可再放大。
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import * as api from '../api/index.js'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import ImageLightbox from './ImageLightbox.vue'

const NEWSPAPER_TAGLINE = '今日事 · 早知道'
const POLL_INTERVAL_MS = 20000

const props = defineProps({
  modelValue: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'close', 'read'])

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const todayPaper = ref(null)
const pastPaper = ref(null)
const viewDate = ref('')          // '' = 看今天；否则为历史日期（YYYY-MM-DD）
const editions = ref([])          // 历史期简目，最新在前
const navLoading = ref(false)
const loading = ref(false)
const urging = ref(false)
const dismissing = ref(false)
const detail = ref(null)   // { kind: 'lead' | 'world' } | { kind: 'item', index }
const zoomSrc = ref('')
let pollTimer = null

// 模板统一用 paper：看今天时是今天报，回看时是历史期
const paper = computed(() => (viewDate.value ? pastPaper.value : todayPaper.value))
const isToday = computed(() => !viewDate.value)

// 期号导航：今天的报纸不占导航位（视作 -1 位）；列表最新在前
const viewIndex = computed(() =>
  viewDate.value ? editions.value.findIndex(e => e.publish_date === viewDate.value) : -1)

/** 相邻目标期：dir=1 更旧 / dir=-1 更新；返回 { today: true } 表示目标是今天，null 表示没有 */
function adjacentEdition(dir) {
  if (!editions.value.length) return null
  const idx = (isToday.value ? -1 : viewIndex.value) + dir
  if (idx < -1) return null           // 今天再往新没有下一期
  if (idx === -1) return { today: true } // 从历史期往新走，越过最新一期即回到今天
  if (idx >= editions.value.length) return null
  // 从今天往旧走时跳过列表里的"今天"位（今天的报纸不占导航拍）
  let i = idx
  while (dir > 0 && todayPaper.value && editions.value[i]?.publish_date === todayPaper.value.publish_date) {
    i++
    if (i >= editions.value.length) return null
  }
  const e = editions.value[i]
  if (!e) return null
  return todayPaper.value && e.publish_date === todayPaper.value.publish_date ? { today: true } : e
}

const olderTarget = computed(() => adjacentEdition(1))
const newerTarget = computed(() => adjacentEdition(-1))
const canNavOlder = computed(() => !!olderTarget.value)

function editionShortLabel(e) {
  if (!e) return ''
  const d = new Date(`${e.publish_date}T00:00:00`)
  const dateStr = Number.isNaN(d.getTime()) ? e.publish_date : `${d.getMonth() + 1}月${d.getDate()}日`
  return `第${e.edition}期 · ${dateStr}`
}
const currentLabel = computed(() => {
  const p = paper.value
  if (!p) return ''
  return `第${p.edition}期 · ${isToday.value ? '今天' : formatDate(p.publish_date)}`
})
const headerMeta = computed(() => {
  const p = paper.value
  return p ? `第${p.edition}期 · ${formatDate(p.publish_date)}` : ''
})

/** 期号导航：dir=1 更旧，dir=-1 更新（越过最新一期即回到今天） */
async function navEdition(dir) {
  if (navLoading.value) return
  const target = dir > 0 ? olderTarget.value : newerTarget.value
  if (!target) return
  // 目标是今天 → 切回今天视图（沿用活角色链接与轮询）
  if (target.today) {
    viewDate.value = ''
    pastPaper.value = null
    closeDetail()
    return
  }
  navLoading.value = true
  try {
    const data = await api.getNewspaperByDate(target.publish_date)
    pastPaper.value = data?.newspaper || null
    viewDate.value = data?.newspaper ? target.publish_date : ''
    closeDetail()
  } catch { /* 导航失败留在当前期 */ }
  finally {
    navLoading.value = false
  }
}

// 今天的世界影响是否已被读者手动消除（消除后异闻文本仍在版面上，但不再影响角色）
const worldDismissed = computed(() => Boolean(paper.value?.world_dismissed))

async function dismissWorld() {
  if (dismissing.value || !isToday.value) return
  dismissing.value = true
  try {
    const data = await api.dismissNewspaperWorldState(!worldDismissed.value)
    if (data?.newspaper) todayPaper.value = data.newspaper
    else todayPaper.value = { ...todayPaper.value, world_dismissed: !worldDismissed.value }
  } catch (err) {
    console.error('[NewspaperModal] toggle world state failed:', err)
  } finally {
    dismissing.value = false
  }
}

// 特稿主角：优先取活角色（带头像），角色后来被删则回退印报时的身份快照
const leadAuthorName = computed(() =>
  paper.value?.character?.display_name || paper.value?.character_event?.character_name || '')
const leadAuthorAvatar = computed(() =>
  paper.value?.character?.avatar_path || paper.value?.character_event?.character_avatar || '')

const items = computed(() => paper.value?.items || [])
const totalCount = computed(() => {
  if (!paper.value) return 0
  return items.value.length + (paper.value.character_event ? 1 : 0) + (paper.value.world_state ? 1 : 0)
})
// 普通新闻对半分到左右两栏
const leftItems = computed(() => items.value.slice(0, Math.ceil(items.value.length / 2)))
const rightItems = computed(() => items.value.slice(Math.ceil(items.value.length / 2)))

// 详情页内容：按 kind+index 从最新 paper 里实时取，轮询补图后详情也会跟着更新
const detailArticle = computed(() => {
  const p = paper.value
  const d = detail.value
  if (!p || !d) return null
  if (d.kind === 'lead' && p.character_event) {
    return {
      kind: 'lead',
      cat: '人物特稿',
      title: p.character_event.title,
      content: p.character_event.content,
      image: p.character_event.image,
      author: leadAuthorName.value,
      avatar: leadAuthorAvatar.value,
    }
  }
  if (d.kind === 'world' && p.world_state) {
    return {
      kind: 'world',
      cat: '今日异闻',
      title: p.world_state.name,
      content: [p.world_state.description, p.world_state.news].filter(Boolean).join('\n\n'),
      image: p.world_state.image,
      author: '',
      avatar: '',
    }
  }
  if (d.kind === 'item') {
    const it = items.value[d.index]
    if (!it) return null
    return { kind: 'item', cat: it.category, title: it.title, content: it.content, image: it.image, author: '', avatar: '' }
  }
  return null
})

function openDetail(d) {
  detail.value = d
}
function closeDetail() {
  detail.value = null
  zoomSrc.value = ''
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${d.getMonth() + 1}月${d.getDate()}日 · 星期${weekdays[d.getDay()]}`
}

function hasMissingImage(p) {
  if (!p) return false
  if (p.character_event && !p.character_event.image) return true
  if (p.world_state && !p.world_state.image) return true
  return (p.items || []).some(item => !item.image)
}

async function fetchPaper() {
  const data = await api.getTodayNewspaper()
  const paper = data?.newspaper || null
  // 开窗期间报纸才印出来（手动补发 / 生成完成）：首见即算看过，别把红点留在导航栏
  const firstArrival = Boolean(paper) && !todayPaper.value
  todayPaper.value = paper
  if (visible.value && firstArrival) emit('read', paper)
  schedulePoll()
}

async function fetchEditions() {
  try {
    const data = await api.listNewspaperEditions()
    editions.value = data?.editions || []
  } catch { /* 期列表失败不阻塞今天的报纸 */ }
}

function schedulePoll() {
  clearInterval(pollTimer)
  pollTimer = null
  // 配图是生成完一张落一张的，开窗期间有缺图就轻轮询补齐（只针对今天：往期配图不再补印）
  if (visible.value && hasMissingImage(todayPaper.value)) {
    pollTimer = setInterval(async () => {
      try { await fetchPaper() } catch { /* 轮询失败静默，下个周期再试 */ }
    }, POLL_INTERVAL_MS)
  }
}

async function urgePrint() {
  urging.value = true
  try {
    await api.generateNewspaper()
    // 已存在时后端直接返回；已启动时交给轮询把内容带回来
    setTimeout(() => { fetchPaper().catch(() => {}) }, 1500)
  } catch { /* 冷却中 / 正在生成：不打断用户 */ }
  finally {
    urging.value = false
  }
}

watch(visible, async (open) => {
  if (open) {
    loading.value = true
    viewDate.value = ''
    pastPaper.value = null
    try {
      await fetchPaper()
      if (todayPaper.value) emit('read', todayPaper.value)
    } catch { /* 打开失败时停在空态 */ }
    finally {
      loading.value = false
    }
    fetchEditions()
  } else {
    clearInterval(pollTimer)
    pollTimer = null
    closeDetail()
  }
})

onBeforeUnmount(() => {
  clearInterval(pollTimer)
})
</script>

<style scoped>
/* ── 报纸质感岛（例外家族：固定暖纸 + 墨色，不随主题） ── */
.np-paper {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(1200px 400px at 50% -80px, rgba(255, 253, 246, 0.9), rgba(255, 253, 246, 0) 70%),
    repeating-linear-gradient(0deg, rgba(120, 96, 64, 0.025) 0 2px, rgba(120, 96, 64, 0) 2px 5px),
    linear-gradient(180deg, #f7f2e7 0%, #f3ecdc 100%);
  color: #3a2a1a;
  padding: 18px 28px 14px;
  font-family: Georgia, 'Songti SC', 'STSong', 'SimSun', serif;
}

.np-header-meta {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

/* ── 期号导航（header-extra）：‹ 期号 · 日期 › ── */
.np-edition-nav {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.np-edition-nav .np-header-meta {
  min-width: 148px;
  text-align: center;
}
/* 报头右侧的「第 N 期」随导航联动时弱化（避免与 header 重复） */
.np-paper.is-past-view .np-mast-side-right {
  opacity: 0.55;
}

/* ── 期号切换条（报头下）：上一期 ← 当前 → 下一期 ── */
.np-edition-switch {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(58, 42, 26, 0.18);
}
.np-edition-current {
  font-size: 12px;
  letter-spacing: 0.12em;
  color: #8c3b22;
  white-space: nowrap;
}
.np-ed-switch-target {
  opacity: 0.75;
  font-weight: 400;
}

/* ── 报头 ── */
.np-masthead {
  flex: 0 0 auto;
}
.np-mast-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
}
.np-mast-side {
  flex: 1;
  min-width: 0;
  padding-bottom: 6px;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: #6b5a48;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-mast-side-right {
  text-align: right;
}
.np-mast-name {
  margin: 0;
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
  font-size: clamp(32px, 4.4vw, 54px);
  font-weight: 700;
  letter-spacing: 0.16em;
  line-height: 1.05;
  color: #332413;
  text-align: center;
  white-space: nowrap;
}

/* 日期线 */
.np-dateline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding: 7px 2px;
  border-top: 3px double rgba(58, 42, 26, 0.75);
  border-bottom: 1px solid rgba(58, 42, 26, 0.55);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: #6b5a48;
}
.np-dateline-dot {
  font-size: 8px;
  opacity: 0.55;
}
.np-dateline-end {
  margin-left: auto;
}

/* ── 版面三栏 ── */
.np-sheet {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1.45fr 1fr;
  margin-top: 12px;
}
.np-sheet--nolead {
  grid-template-columns: 1fr 1fr;
}
.np-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  padding: 0 18px;
}
.np-col:first-child {
  padding-left: 0;
}
.np-col:last-child {
  padding-right: 0;
}
.np-col + .np-col {
  border-left: 1px solid rgba(58, 42, 26, 0.22);
}
/* 栏内新闻均分剩余高度：grid 行 1fr 保证无论几条都压在一页内 */
.np-col-list {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-auto-rows: 1fr;
}

/* 可点击的新闻块（报纸内部属质感岛例外，自包含交互样式） */
.np-clickable {
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.3s ease;
}
.np-clickable:hover {
  background: rgba(140, 59, 34, 0.055);
}
.np-clickable:hover .np-article-title,
.np-clickable:hover .np-lead-title,
.np-clickable:hover .np-world-name {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.np-clickable:focus-visible {
  outline: 2px solid rgba(140, 59, 34, 0.5);
  outline-offset: 2px;
}

/* 栏目戳 */
.np-cat {
  display: inline-block;
  align-self: flex-start;
  font-size: 11px;
  letter-spacing: 0.2em;
  padding: 2px 8px 2px 10px;
  border: 1px solid rgba(58, 42, 26, 0.55);
  color: #6b5a48;
  border-radius: 3px;
}
.np-cat-lead {
  color: #8c3b22;
  border-color: rgba(140, 59, 34, 0.65);
  background: rgba(140, 59, 34, 0.07);
}

/* 今日异闻（世界状态）：block 流让配图可被文字环绕 */
.np-world {
  min-height: 0;
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(58, 42, 26, 0.55);
  outline: 1px solid rgba(58, 42, 26, 0.3);
  outline-offset: 3px;
  border-radius: 4px;
  background: rgba(255, 252, 245, 0.55);
  overflow: hidden;
}
.np-world-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.np-world-stamp {
  flex-shrink: 0;
  font-size: 12px;
  letter-spacing: 0.3em;
  color: #f5efe0;
  background: #8c3b22;
  padding: 3px 8px 3px 11px;
  border-radius: 3px;
  transform: rotate(-2deg);
}
.np-world-name {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.06em;
  line-height: 1.3;
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
}
.np-world-dismissed-stamp {
  flex-shrink: 0;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: #8c3b22;
  border: 1px solid rgba(140, 59, 34, 0.55);
  padding: 2px 7px 2px 9px;
  border-radius: 3px;
  transform: rotate(2deg);
  opacity: 0.85;
}

/* 人物特稿（头条） */
.np-lead {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 6px;
  overflow: hidden;
}
.np-lead-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.np-lead-author {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b5a48;
}
.np-lead-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid rgba(58, 42, 26, 0.35);
}
.np-lead-title {
  margin: 0 0 10px;
  font-size: clamp(22px, 2.4vw, 32px);
  line-height: 1.3;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-align: center;
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
}
.np-lead-text {
  font-size: 14px;
  margin-top: 10px;
  margin-bottom: 0;
}
/* 头条配图吃掉栏内剩余高度（满幅裁切是头条的专有语言；侧栏图保持原始比例环绕） */
.np-lead-figure {
  flex: 1 1 0;
  min-height: 60px;
}
.np-lead-figure img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 普通新闻：block 流（float 环绕需要），超高由 overflow:hidden 兜底（全文进详情） */
.np-article {
  min-height: 0;
  padding: 8px 4px;
  border-bottom: 1px solid rgba(58, 42, 26, 0.18);
  overflow: hidden;
}
.np-article:last-child {
  border-bottom: none;
}
.np-article-title {
  margin: 6px 0 4px;
  font-size: 16.5px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.03em;
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
}

/* 正文 */
.np-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.85;
  text-align: justify;
}
.np-text-sm {
  font-size: 13px;
  line-height: 1.8;
  margin-top: 6px;
}
.np-text-secondary {
  color: #6b5a48;
  margin-top: 4px;
}

/* 行数压裁：版面一页装不下的部分进详情读全文 */
.np-clamp-2,
.np-clamp-3,
.np-clamp-4,
.np-clamp-5 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.np-clamp-2 { -webkit-line-clamp: 2; }
.np-clamp-3 { -webkit-line-clamp: 3; }
.np-clamp-4 { -webkit-line-clamp: 4; }
.np-clamp-5 { -webkit-line-clamp: 5; }
.np-clamp-6 { -webkit-line-clamp: 6; }

/* 配图：细墨框 + 白衬。侧栏配图保持原始比例，文字半包围环绕；
   环绕方向按条目交错（左右左右），更像报纸拼版 */
.np-figure {
  margin: 4px 0 0;
  border: 1px solid rgba(58, 42, 26, 0.4);
  padding: 4px;
  background: #fffdf8;
  overflow: hidden;
}
.np-figure-wrap {
  float: left;
  width: 58%;
  margin: 4px 12px 4px 0;
}
.np-col-list .np-article:nth-of-type(even) .np-figure-wrap {
  float: right;
  margin: 4px 0 4px 12px;
}
.np-figure-wrap img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 2px;
}
.np-img-placeholder.np-figure-wrap {
  aspect-ratio: 4 / 3;
  min-height: 0;
}
.np-img-placeholder {
  margin: 4px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  letter-spacing: 0.15em;
  color: #a08c74;
  border: 1px dashed rgba(58, 42, 26, 0.4);
  background: rgba(255, 252, 245, 0.5);
  border-radius: 2px;
}

/* 报尾 */
.np-colophon {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 3px double rgba(58, 42, 26, 0.75);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: #6b5a48;
}
.np-colophon-hint {
  font-size: 11px;
  letter-spacing: 0.14em;
  color: #a08c74;
}
.np-colophon-motto {
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
  font-size: 13px;
}

/* ── 新闻详情（盖在版面上的摊开一页） ── */
.np-detail {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 400px at 50% -80px, rgba(255, 253, 246, 0.9), rgba(255, 253, 246, 0) 70%),
    linear-gradient(180deg, #f8f3e9 0%, #f4eddd 100%);
}
.np-detail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
  padding: 20px clamp(18px, 4vw, 48px) 28px;
}
.np-detail-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 3px double rgba(58, 42, 26, 0.75);
}
/* 异闻详情：消除按钮推到行尾（cat 在左、返回居中靠右由 space-between 改为显式 margin） */
.np-detail-bar .np-back {
  margin-left: auto;
}
.np-dismiss-btn {
  flex-shrink: 0;
}
.np-back {
  font-size: 13px;
  letter-spacing: 0.1em;
  color: #8c3b22;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  transition: background 0.3s ease;
  user-select: none;
}
.np-back:hover {
  background: rgba(140, 59, 34, 0.08);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.np-back:focus-visible {
  outline: 2px solid rgba(140, 59, 34, 0.5);
  outline-offset: 2px;
}
.np-detail-title {
  margin: 18px 0 0;
  font-size: clamp(24px, 3vw, 36px);
  line-height: 1.35;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-align: center;
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
}
.np-detail-byline {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12.5px;
  letter-spacing: 0.1em;
  color: #6b5a48;
}
.np-detail-figure {
  margin: 16px 0 0;
  border: 1px solid rgba(58, 42, 26, 0.4);
  padding: 5px;
  background: #fffdf8;
  cursor: zoom-in;
}
.np-detail-figure img {
  display: block;
  width: 100%;
  max-height: 46vh;
  object-fit: contain;
  background: rgba(58, 42, 26, 0.05);
  border-radius: 2px;
}
.np-detail-caption {
  padding-top: 6px;
  font-size: 11.5px;
  letter-spacing: 0.08em;
  text-align: center;
  color: #6b5a48;
}
.np-detail-nofimg {
  flex: none;
  min-height: 140px;
  margin-top: 16px;
}
.np-detail-text {
  margin: 16px 0 0;
  font-size: 15px;
  line-height: 2.05;
  text-align: justify;
  white-space: pre-line;
}
.np-detail-text::first-letter {
  float: left;
  padding: 6px 10px 0 0;
  font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'SimSun', serif;
  font-size: 3em;
  line-height: 0.9;
  color: #8c3b22;
}

/* 详情动画（0.3s 口径；图片放大走统一 ImageLightbox） */
.np-detail-fade-enter-active,
.np-detail-fade-leave-active {
  transition: opacity 0.3s ease;
}
.np-detail-fade-enter-from,
.np-detail-fade-leave-to {
  opacity: 0;
}

/* 空态 / 骨架 */
.np-empty {
  padding: 48px 20px;
  text-align: center;
}
.np-empty-icon {
  font-size: 40px;
  margin-bottom: 10px;
}
.np-empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.np-empty-hint {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--text-secondary);
}
.np-skeletons {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
}
.np-sk-line {
  height: 14px;
  width: 60%;
}
.np-sk-block {
  height: 180px;
}

/* 移动端：单栏报纸，版面内滚动 */
@media (max-width: 767px) {
  .np-paper {
    padding: 14px 16px 12px;
  }
  /* 期号切换条：窄屏允许换行、隐藏目标期日期，避免横向溢出 */
  .np-edition-switch {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .np-ed-switch-target {
    display: none;
  }
  .np-mast-side {
    display: none;
  }
  .np-mast-row {
    justify-content: center;
  }
  .np-mast-name {
    font-size: 30px;
    white-space: normal;
  }
  .np-dateline-end {
    margin-left: 0;
    width: 100%;
  }
  .np-sheet,
  .np-sheet--nolead {
    display: block;
    overflow-y: auto;
  }
  .np-col {
    padding: 0;
  }
  .np-col + .np-col {
    border-left: none;
  }
  .np-col-list {
    display: block;
  }
  .np-world {
    margin-top: 4px;
  }
  .np-lead {
    height: auto;
    padding: 10px 6px;
    border-bottom: 1px solid rgba(58, 42, 26, 0.25);
  }
  .np-lead-title {
    font-size: 23px;
    text-align: left;
  }
  /* 手机端不做环绕：配图通栏、保持比例 */
  .np-figure,
  .np-col-list .np-article:nth-of-type(even) .np-figure-wrap,
  .np-figure-wrap,
  .np-lead-figure {
    float: none;
    flex: none;
    width: auto;
    margin: 4px 0 0;
  }
  .np-img-placeholder.np-figure-wrap {
    aspect-ratio: auto;
    min-height: 100px;
  }
  .np-figure img {
    height: auto;
    max-height: 220px;
  }
  .np-img-placeholder {
    flex: none;
    min-height: 100px;
  }
  .np-colophon-hint {
    display: none;
  }
  .np-detail-figure img {
    max-height: 38vh;
  }
}
</style>

<style>
/* 报纸窗体：几乎铺满全屏的一整版报纸（panel-class/body-class 是 LinsheModal 的官方布局差异机制），
   只放大面板并去掉正文内边距让暖纸铺满内容区，不改窗体皮肤 */
.np-panel {
  --modal-full-width: min(1520px, 97vw);
  height: 94vh;
  max-height: 94vh;
}
.np-body {
  padding: 0 !important;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.np-body > * {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}
</style>
