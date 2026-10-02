<template>
  <!-- 与全镇动态面板共用页面弹窗层，保持相对小镇页面居中。 -->
  <LinsheModal :model-value="modelValue" :title="`${name || '居民'} · 动态`" anchor=".page-modal-host" @update:model-value="$emit('update:modelValue', $event)">
    <p v-if="loading && !activity.length" class="tra-muted" role="status">正在读取行动记录…</p>
    <p v-else-if="!activity.length" class="tra-muted">还没有留下行动记录，去镇上转转会有的。</p>
    <ul v-else class="tra-list">
      <li v-for="item in activity" :key="item.seq" :class="{ 'is-local': item.local }">
        <time>{{ formatActivityTime(item.occurredAt) }}</time>
        <span v-if="item.local" class="tra-footprint-chip">足迹</span>
        <span class="tra-text">{{ item.text }}</span>
        <span v-if="item.reason" class="tra-reason-chip">{{ item.reason }}</span>
      </li>
    </ul>
    <p v-if="activity.length" class="tra-hint">足迹是本次游玩时看到的移动记录，刷新后不再保留。</p>
  </LinsheModal>
</template>

<script setup>
// 居民「动态」独立窗口：需求/心情看「状态」弹窗，这里只看最近行动记录（后端流水 + 前端足迹）。
// 从对话框头部按钮打开，不再挤占暖纸对话框的正文空间。
import LinsheModal from '../ui/LinsheModal.vue'

defineProps({
  modelValue: Boolean,
  name: { type: String, default: '' },
  activity: { type: Array, default: () => [] },
  loading: Boolean,
})
defineEmits(['update:modelValue'])

function formatActivityTime(occurredAt) {
  const date = new Date(occurredAt)
  if (!Number.isFinite(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return sameDay ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`
}
</script>

<style scoped>
.tra-muted { color: #9a8a78; font-size: 13px; padding: 18px 0; text-align: center; margin: 0; }
/* 记录可能上百条：列表自己滚动，别把弹窗顶到屏幕外 */
.tra-list {
  list-style: none; margin: 0; padding: 0; display: grid; gap: 6px;
  max-height: min(52vh, 420px); overflow-y: auto; overscroll-behavior: contain; overflow-wrap: anywhere;
}
.tra-list li {
  display: flex; gap: 10px; align-items: baseline; font-size: 12px; color: #4a3a2c;
  padding: 5px 10px; border: 1px solid rgba(161, 132, 110, .3); border-radius: 10px;
  background: rgba(255, 251, 243, .65);
}
.tra-list li time { flex: none; color: #a1846e; font-size: 10px; }
.tra-text { min-width: 0; }
.tra-list li.is-local { border-style: dashed; border-color: rgba(124, 143, 124, .5); }
.tra-footprint-chip {
  flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px; color: #6d826d;
  border: 1px dashed rgba(124, 143, 124, .6); background: rgba(124, 143, 124, .1);
}
/* 「为什么做/为什么中断」：理由小标签，靠右弱化显示 */
.tra-reason-chip {
  flex: none; margin-left: auto; padding: 1px 6px; border-radius: 999px; font-size: 10px;
  color: #a1846e; border: 1px solid rgba(161, 132, 110, .4); background: rgba(255, 251, 243, .7);
}
.tra-hint { margin: 10px 0 0; font-size: 10px; color: #a1846e; }
</style>
