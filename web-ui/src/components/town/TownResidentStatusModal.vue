<template>
  <LinsheModal :model-value="modelValue" :title="`${name || '居民'} · 状态`" @update:model-value="$emit('update:modelValue', $event)">
    <!-- <template #header-extra>
      <linshe-button variant="link" size="sm" :disabled="loading" @click="$emit('refresh')">{{ loading ? '刷新中…' : '刷新' }}</linshe-button>
    </template> -->
    <p v-if="loading && !status" class="trs-muted" role="status">正在读取状态…</p>
    <p v-else-if="!status" class="trs-muted">还没有这位居民的状态记录。</p>
    <div v-else class="trs-sheet">
      <section v-if="status.mood" class="trs-block">
        <span class="trs-mood-chip">{{ status.mood.label }}</span>
        <span class="trs-sub">综合心情 {{ status.mood.value }}</span>
      </section>
      <section v-if="status.needs" class="trs-block trs-needs">
        <div v-for="(need, key) in status.needs" :key="key" class="trs-need-row">
          <span class="trs-need-label">{{ need.label }}</span>
          <span class="trs-need-bar" role="img" :aria-label="`${need.label} ${need.value}/100`"><i :class="{ 'is-low': need.value < 40 }" :style="{ width: need.value + '%' }"></i></span>
          <span class="trs-need-value">{{ need.value }}</span>
        </div>
      </section>
      <section v-if="status.goals && status.goals.length" class="trs-block">
        <h3>在追的目标</h3>
        <ul class="trs-list">
          <li v-for="goal in status.goals" :key="goal.slot">
            <span>{{ goal.title }}</span>
            <span class="trs-sub">{{ goal.progress }}<template v-if="goal.amount">/{{ goal.amount }}</template><template v-if="goal.status === 'completed'"> · 已完成</template></span>
          </li>
        </ul>
      </section>
      <section v-if="status.skills && status.skills.length" class="trs-block">
        <h3>技能与习惯</h3>
        <ul class="trs-list">
          <li v-for="skill in status.skills" :key="skill.key">
            <span>{{ skill.label }}</span>
            <span class="trs-sub">Lv.{{ skill.level }}</span>
          </li>
        </ul>
      </section>
      <section v-if="status.relationships && status.relationships.length" class="trs-block">
        <h3>最近来往</h3>
        <ul class="trs-list">
          <li v-for="rel in status.relationships" :key="rel.name">
            <span>{{ rel.name }}</span>
            <span class="trs-sub">熟悉 {{ rel.familiarity }}<template v-if="rel.affection"> · 好感 {{ rel.affection }}</template></span>
          </li>
        </ul>
      </section>
    </div>
  </LinsheModal>
</template>

<script setup>
import LinsheModal from '../ui/LinsheModal.vue'
import LinsheButton from '../ui/LinsheButton.vue'

defineProps({
  modelValue: Boolean,
  name: { type: String, default: '' },
  status: { type: Object, default: null },
  loading: Boolean,
})
defineEmits(['update:modelValue', 'refresh'])
</script>

<style scoped>
.trs-muted { color: #9a8a78; font-size: 13px; padding: 18px 0; text-align: center; margin: 0; }
.trs-sheet { display: grid; gap: 12px; }
.trs-block { display: grid; gap: 6px; }
.trs-block h3 { margin: 0; font-size: 11px; font-weight: 600; color: #a1846e; letter-spacing: .08em; }
.trs-sub { color: #a1846e; font-size: 11px; }
.trs-mood-chip {
  justify-self: start; padding: 3px 10px; border-radius: 999px; font-size: 12px; color: #4a3a2c;
  border: 1px solid rgba(161, 132, 110, .45); background: rgba(255, 251, 243, .8);
}
.trs-needs { gap: 7px; }
.trs-need-row { display: grid; grid-template-columns: 52px 1fr 30px; align-items: center; gap: 8px; font-size: 12px; }
.trs-need-label { color: #6b5a48; }
.trs-need-value { text-align: right; color: #4a3a2c; font-variant-numeric: tabular-nums; }
.trs-need-bar { height: 6px; border-radius: 999px; background: rgba(161, 132, 110, .22); overflow: hidden; }
.trs-need-bar i { display: block; height: 100%; border-radius: inherit; background: #7fa87f; transition: width .3s ease; }
.trs-need-bar i.is-low { background: #cf7a6a; }
.trs-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
.trs-list li {
  display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: #4a3a2c;
  padding: 5px 10px; border: 1px solid rgba(161, 132, 110, .3); border-radius: 10px;
  background: rgba(255, 251, 243, .65);
}
</style>
