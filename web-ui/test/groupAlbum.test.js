// 群相册数据层单测：筛选当前群图片、去重、贴纸过滤、发言人分组与按天分组。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_SPEAKERS,
  USER_SPEAKER,
  collectGroupImages,
  buildSpeakerFilters,
  filterImagesBySpeaker,
  groupImagesByDay,
  dayLabelOf,
  imageTooltip,
  toImageUrls,
} from '../src/utils/groupAlbum.js'

// 本地时间构造，保证与 dayLabelOf 的「今天 / 昨天」判定处于同一时区
const at = (day, hour) => new Date(2026, 8, day, hour, 0, 0).toISOString()

const group = {
  id: 7,
  members: [
    { id: 11, display_name: '小满', avatar_path: '/avatars/xiaoman.png' },
    { id: 12, display_name: '阿澈', avatar_path: '' },
  ],
}

const messages = [
  { id: 1, role: 'assistant', speaker_character_id: 11, created_at: at(20, 9), images: ['/images/a.png', '/images/emoji/e1.png'] },
  { id: 2, role: 'user', created_at: at(20, 11), images: ['/images/b.png?_t=5'] },
  { id: 3, role: 'assistant', speaker_character_id: 12, created_at: at(21, 8), images: '["/images/b.png"]' },
  { id: 4, role: 'assistant', speaker_character_id: 11, created_at: at(21, 9), images: ['/images/c.png'] },
  { id: 5, role: 'assistant', speaker_character_id: 12, created_at: at(21, 10), content: '今天天气不错' },
]

test('toImageUrls 兼容数组、JSON 字符串与 {url} 结构', () => {
  assert.deepEqual(toImageUrls(['/images/a.png']), ['/images/a.png'])
  assert.deepEqual(toImageUrls('["/images/a.png"]'), ['/images/a.png'])
  assert.deepEqual(toImageUrls([{ url: '/images/a.png' }, { url: '' }]), ['/images/a.png'])
  assert.deepEqual(toImageUrls('not-json'), [])
  assert.deepEqual(toImageUrls(null), [])
})

test('collectGroupImages 过滤表情包、按 base 去重并按时间倒序', () => {
  const images = collectGroupImages(messages, group)
  assert.deepEqual(images.map(i => i.base), ['/images/c.png', '/images/b.png', '/images/a.png'])
  // 表情包贴纸不进群相册
  assert.equal(images.some(i => i.url.includes('/images/emoji/')), false)
  // 发言人：角色消息取成员资料，用户消息归到「我」
  assert.equal(images[0].speakerKey, 'c11')
  assert.equal(images[0].speakerName, '小满')
  assert.equal(images[0].speakerAvatar, '/avatars/xiaoman.png')
  assert.equal(images[1].speakerKey, USER_SPEAKER)
  assert.equal(images[1].speakerName, '我')
})

test('buildSpeakerFilters 只列有图的发言人，且按群成员顺序', () => {
  const images = collectGroupImages(messages, group)
  const filters = buildSpeakerFilters(images, group)
  assert.deepEqual(filters.map(f => f.key), [ALL_SPEAKERS, USER_SPEAKER, 'c11'])
  assert.deepEqual(filters.map(f => f.count), [3, 1, 2])
  assert.equal(filters[0].label, '全部')
  assert.equal(filters[2].label, '小满')

  // 只有阿澈发过图时，筛选条不再列出没发图的成员
  const onlyAche = collectGroupImages([
    { id: 9, role: 'assistant', speaker_character_id: 12, created_at: at(21, 8), images: ['/images/d.png'] },
  ], group)
  assert.deepEqual(buildSpeakerFilters(onlyAche, group).map(f => f.key), [ALL_SPEAKERS, 'c12'])
})

test('filterImagesBySpeaker 按发言人收窄，「全部」原样返回', () => {
  const images = collectGroupImages(messages, group)
  assert.equal(filterImagesBySpeaker(images, ALL_SPEAKERS), images)
  assert.deepEqual(filterImagesBySpeaker(images, 'c11').map(i => i.base), ['/images/c.png', '/images/a.png'])
  assert.deepEqual(filterImagesBySpeaker(images, 'c12'), [])
})

test('groupImagesByDay 按自然日分组：今天 / 昨天 / 月日 / 跨年', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0)
  const images = [
    { url: '/images/today.png', base: '/images/today.png', speakerKey: 'c11', speakerName: '小满', createdAt: at(22, 9) },
    { url: '/images/yesterday.png', base: '/images/yesterday.png', speakerKey: 'c11', speakerName: '小满', createdAt: at(21, 9) },
    { url: '/images/older.png', base: '/images/older.png', speakerKey: 'c11', speakerName: '小满', createdAt: at(19, 9) },
    { url: '/images/lastyear.png', base: '/images/lastyear.png', speakerKey: 'c11', speakerName: '小满', createdAt: new Date(2025, 8, 19, 9, 0, 0).toISOString() },
    { url: '/images/unknown.png', base: '/images/unknown.png', speakerKey: 'c11', speakerName: '小满', createdAt: '' },
  ]
  const days = groupImagesByDay(images, now)
  assert.deepEqual(days.map(d => d.label), ['今天', '昨天', '9月19日', '2025年9月19日', '未知时间'])
  assert.deepEqual(days.map(d => d.items.length), [1, 1, 1, 1, 1])
  // 新的在前，时间不可用的沉到最后
  assert.equal(days[days.length - 1].key, 0)
})

test('dayLabelOf / imageTooltip 的兜底口径', () => {
  assert.equal(dayLabelOf(0, new Date(2026, 8, 22)), '未知时间')
  assert.equal(imageTooltip({ speakerName: '小满', createdAt: '' }), '小满')
  assert.equal(imageTooltip({ speakerName: '小满', createdAt: at(20, 9) }), '小满  2026/9/20 09:00')
})