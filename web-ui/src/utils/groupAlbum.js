/**
 * 群相册数据层：把某个群聊消息里出现过的图片筛出来，供「群设置  群相册」展示。
 *
 * 约定（与聊天区保持一致）：
 * - 表情包贴纸（/images/emoji/）不算相册图片聊天区里它们同样不可点开放大；
 * - 同一张图片忽略查询串后只保留一次（重新生成会覆写同名文件）；
 * - 输出按消息时间倒序，新图在前。
 */

export const ALL_SPEAKERS = 'all'
export const USER_SPEAKER = 'user'

/** 表情包贴纸：按 /images/emoji/ 路径识别（与 GroupChatView 同款判定） */
export function isStickerUrl(url) {
  return typeof url === 'string' && url.includes('/images/emoji/')
}

/** messages.images 字段（历史数据可能是 JSON 字符串） 图片地址数组 */
export function toImageUrls(raw) {
  let list = raw
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return list
    .map(item => (typeof item === 'string' ? item : item?.url || ''))
    .filter(Boolean)
}

/** URL 去掉查询串，用于判定「是不是同一张图」 */
export function imageBaseUrl(url) {
  return String(url || '').replace(/\?.*$/, '')
}

function timeOf(iso) {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? t : 0
}

function speakerOf(msg, members) {
  if (msg?.role === 'user') return { key: USER_SPEAKER, name: '我', avatar: '' }
  const member = members.find(m => m.id === msg?.speaker_character_id) || null
  return {
    key: `c${msg?.speaker_character_id ?? 'unknown'}`,
    name: member?.display_name || msg?.speaker_name || '群成员',
    avatar: member?.avatar_path || msg?.speaker_avatar || '',
  }
}

/** 群聊消息  相册图片列表（已去重、已过滤贴纸、按时间倒序） */
export function collectGroupImages(messages = [], group = null) {
  const members = group?.members || []
  const seen = new Set()
  const out = []
  for (const msg of messages || []) {
    const urls = toImageUrls(msg?.images).filter(url => !isStickerUrl(url))
    if (urls.length === 0) continue
    const speaker = speakerOf(msg, members)
    for (const url of urls) {
      const base = imageBaseUrl(url)
      if (!base || seen.has(base)) continue
      seen.add(base)
      out.push({
        url,
        base,
        speakerKey: speaker.key,
        speakerName: speaker.name,
        speakerAvatar: speaker.avatar,
        createdAt: msg?.created_at || '',
      })
    }
  }
  return out.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
}

/** 发言人筛选条：全部 + 我 + 群里实际发过图的成员（按群成员顺序，带张数） */
export function buildSpeakerFilters(images = [], group = null) {
  const counts = new Map()
  const labels = new Map()
  for (const img of images) {
    counts.set(img.speakerKey, (counts.get(img.speakerKey) || 0) + 1)
    if (!labels.has(img.speakerKey)) labels.set(img.speakerKey, img.speakerName)
  }
  const order = []
  if (counts.has(USER_SPEAKER)) order.push(USER_SPEAKER)
  for (const member of group?.members || []) {
    const key = `c${member.id}`
    if (counts.has(key) && !order.includes(key)) order.push(key)
  }
  for (const key of counts.keys()) {
    if (!order.includes(key)) order.push(key)
  }
  return [
    { key: ALL_SPEAKERS, label: '全部', count: images.length },
    ...order.map(key => ({ key, label: labels.get(key) || '群成员', count: counts.get(key) || 0 })),
  ]
}

/** 按发言人筛选；「全部」或空值原样返回 */
export function filterImagesBySpeaker(images = [], speakerKey = ALL_SPEAKERS) {
  if (!speakerKey || speakerKey === ALL_SPEAKERS) return images
  return images.filter(img => img.speakerKey === speakerKey)
}

/** 日期分组标签：今天 / 昨天 / M月D日 / YYYY年M月D日；时间不可用归入「未知时间」 */
export function dayLabelOf(dayStart, now = new Date()) {
  if (!dayStart) return '未知时间'
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (dayStart === todayStart) return '今天'
  if (dayStart === todayStart - 86400000) return '昨天'
  const d = new Date(dayStart)
  const month = d.getMonth() + 1
  const day = d.getDate()
  if (d.getFullYear() === now.getFullYear()) return `${month}月${day}日`
  return `${d.getFullYear()}年${month}月${day}日`
}

/** 按自然日分组（新的在前），标签口径与相册页一致 */
export function groupImagesByDay(images = [], now = new Date()) {
  const map = new Map()
  for (const img of images) {
    const t = timeOf(img.createdAt)
    const d = new Date(t)
    const dayStart = t ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() : 0
    if (!map.has(dayStart)) {
      map.set(dayStart, { key: dayStart, label: dayLabelOf(dayStart, now), items: [] })
    }
    map.get(dayStart).items.push(img)
  }
  return [...map.values()].sort((a, b) => b.key - a.key)
}

/** 图片悬停提示：发言人 + 时间 */
export function imageTooltip(img) {
  const t = timeOf(img?.createdAt)
  if (!t) return img?.speakerName || ''
  const d = new Date(t)
  const pad = n => String(n).padStart(2, '0')
  return `${img.speakerName}  ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}