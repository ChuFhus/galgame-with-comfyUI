export const STANDING_ACTION_LABELS = { pat: '轻拍头顶', stroke: '摸摸头', poke: '轻戳脸侧', overstimulated: '连续逗弄', feather: '羽毛轻触', plush: '递上玩偶' }
const TEXT = {
  pat: ['轻轻拍了拍。', '一点轻柔的回应。', '星星落在指尖。'],
  stroke: ['轻轻顺了顺头发。', '慢慢放松下来。', '停留片刻的温柔。'],
  poke: ['咦，碰到啦。', '轻轻一戳。', '小小的惊讶。'],
  overstimulated: ['往旁边躲了一点。', '先歇一小会儿。', '这次被躲开啦。'],
  feather: ['羽毛轻轻扫过。', '忍不住往旁边躲。', '有点痒痒的。'],
  plush: ['把小玩偶递到面前。', '让小玩偶陪在身边。', '气氛缓和下来。'],
}
export function createStandingInteractionEngine({ now = () => performance.now(), random = Math.random } = {}) {
  let level = 0, decayAt = now(), lastAt = -Infinity, recoveryUntil = 0
  let toolTimes = {}, history = {}
  function decay(t) {
    const steps = Math.floor(Math.max(0, t - decayAt) / 8000)
    if (steps) { level = Math.max(0, level - steps); decayAt += steps * 8000 }
  }
  function act(action, { sleeping = null, config = {} } = {}) {
    if (!['pat', 'stroke', 'poke', 'feather', 'plush'].includes(action)) return null
    const t = now(); decay(t)
    if (sleeping === null || sleeping && action !== 'plush') return null
    if (t - lastAt < 600 || action === 'feather' && t - (toolTimes.feather ?? -Infinity) < 2000 || action === 'plush' && t - (toolTimes.plush ?? -Infinity) < 3000) return null
    if (t < recoveryUntil && ['poke', 'feather'].includes(action)) return null
    lastAt = t; toolTimes[action] = t
    if (!sleeping) {
      level = Math.max(0, Math.min(4, level + ({ pat: -1, stroke: -1, poke: 1, feather: 2, plush: -2 }[action])))
      decayAt = t
      if (level === 4) recoveryUntil = t + 2000
    }
    const key = !sleeping && level >= 3 && ['poke', 'feather'].includes(action) ? 'overstimulated' : action
    const custom = config.linesEnabled && config.lines?.[key]?.length ? config.lines[key] : null
    const list = custom || TEXT[key]
    let index = Math.min(list.length - 1, Math.floor(Math.max(0, random()) * list.length))
    const h = history[key]
    if (list.length > 1 && h?.index === index && h.count >= 2) index = (index + 1) % list.length
    history[key] = { index, count: h?.index === index ? h.count + 1 : 1 }
    return { action, level, passive: Boolean(sleeping), semantic: sleeping ? null : key === 'overstimulated' ? 'annoyed' : ['poke', 'feather'].includes(action) ? 'surprised' : 'pleased',
      motion: sleeping ? 'still' : key === 'overstimulated' ? 'dodge' : action,
      variant: index % 3, amplitude: config.style === 'lively' ? 1 : config.style === 'shy' ? .65 : .45,
      text: sleeping ? '轻轻放下玩偶，让它陪着休息。' : list[index] }
  }
  function reset() { level = 0; decayAt = now(); lastAt = -Infinity; recoveryUntil = 0; toolTimes = {}; history = {} }
  return { act, reset, snapshot() { decay(now()); return { level, recoveryUntil, lastAt } } }
}
export function standingSelectionKey(state) { return `${state?.epoch}/${state?.selectionVersion}/${state?.characterId}` }
export function standingPresentationChanged(a, b) {
  return standingSelectionKey(a) !== standingSelectionKey(b) || a?.imageUrl !== b?.imageUrl || a?.imageVersion !== b?.imageVersion || a?.resolvedSlotId !== b?.resolvedSlotId || a?.replyVersion !== b?.replyVersion || a?.reason?.id !== b?.reason?.id || a?.reason?.text !== b?.reason?.text
}
export function compatibleReactionSlot(config, slots, base, semantic) {
  if (!config?.expressionsEnabled || !semantic || !config.compatibleSources?.some(r => r.slotId === base.resolvedSlotId && r.imageVersion === base.imageVersion)) return null
  const binding = config.bindings?.[semantic]
  return slots?.find(s => s.slotId === binding?.slotId && s.imageVersion === binding.imageVersion) || null
}
