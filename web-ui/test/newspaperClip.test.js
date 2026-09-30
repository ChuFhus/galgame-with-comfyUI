import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 《邻舍日报》头版正文的压裁口径（源码级回归）：
// 正文要绕着浮动配图排（float 半包围），所以不能用 -webkit-line-clamp（那是 display:-webkit-box，
// 正文会变成整块不再环绕），改由 useArticleClip 量完排版后补省略号。
// 这一层是「模板标记 ↔ composable」的契约，改动任何一边都要同步，否则省略号会整版消失。
const MODAL = fileURLToPath(new URL('../src/components/NewspaperModal.vue', import.meta.url))
const CLIP = fileURLToPath(new URL('../src/composables/useArticleClip.js', import.meta.url))

const modal = readFileSync(MODAL, 'utf8')
const clip = readFileSync(CLIP, 'utf8')

test('压裁器挂到版面上，并随显隐 / 换期 / 补图重量', () => {
  assert.match(modal, /ref="paperEl"[^>]*class="np-paper"/, '版面根节点要能被 composable 扫到')
  assert.match(modal, /useArticleClip\(\{/, '版面要接上压裁器')
  assert.match(modal, /root: paperEl/, 'root 指向版面根节点')
  assert.match(modal, /active: visible/, '窗口关着时不量（量不到尺寸）')
  assert.match(modal, /sources:\s*\[[^\]]*paper[^\]]*\]/, '换期 / 补图等数据变化要触发重量')
})

test('每条正文都带 data-np-clip，且不套 -webkit-box 压裁', () => {
  const bodies = [...modal.matchAll(/<p[^>]*class="np-text[^"]*"[^>]*>/g)].map(match => match[0])
  const articleBodies = bodies.filter(tag => !tag.includes('np-detail-text'))
  assert.ok(articleBodies.length >= 4, `头版正文标签数异常：${articleBodies.length}`)
  for (const tag of articleBodies) {
    assert.match(tag, /data-np-clip/, `头版正文缺 data-np-clip：${tag}`)
    assert.doesNotMatch(tag, /np-clamp-\d/, `头版正文不能用 line-clamp（会丢掉 float 环绕）：${tag}`)
  }
  assert.equal(articleBodies.some(tag => /np-clamp-\d/.test(tag)), false)
})

test('标题保留 CSS 行数压裁，正文不再依赖 np-clamp 系列', () => {
  assert.match(modal, /np-article-title np-clamp-2/, '标题仍是两行压裁')
  // np-clamp 家族只保留标题用的 2 行版，正文的 3/4/5/6 行版已随压裁器删除
  for (const n of [3, 4, 5, 6]) {
    assert.doesNotMatch(modal, new RegExp(`\\.np-clamp-${n}\\b`), `残留未使用的 .np-clamp-${n}`)
  }
  assert.match(modal, /\.np-clamp-2\s*\{[^}]*-webkit-line-clamp:\s*2/)
})

test('压裁器判定用文字排版高度，而不是被 overflow 锁住的 height', () => {
  assert.match(clip, /selectNodeContents\(el\)/, '要量正文文字范围')
  assert.match(clip, /const fits = \(\) =>/, '要有「装得下吗」的判定')
  assert.doesNotMatch(clip, /fits = \(\) => el\.getBoundingClientRect\(\)\.height/,
    '正文自身 overflow:hidden，height 永远等于边界，不能用它判定溢出')
})
