import test from 'node:test'
import assert from 'node:assert/strict'
import { standingGeometry } from '../src/utils/standingGeometry.js'

test('portrait fits desktop popup, mobile portrait and landscape with bubble headroom', () => {
  const bounds = { x: 100, y: 120, width: 500, height: 1200, imageWidth: 768, imageHeight: 1536 }
  for (const [w, h] of [[480, 800], [390, 844], [844, 390]]) {
    const g = standingGeometry(bounds, w, h)
    assert.ok(g.width <= w - 32 + 1e-6)
    assert.ok(g.height <= h - 140 + 1e-6)
    assert.ok(Math.abs(g.width / g.height - 500 / 1200) < 1e-6)
    assert.ok(parseFloat(g.image.left) < 0 && parseFloat(g.image.top) < 0)
  }
})
test('transparent PNG padding does not change subject size or baseline', () => {
  const a = standingGeometry({ x: 0, y: 0, width: 300, height: 600, imageWidth: 300, imageHeight: 600 }, 390, 844)
  const b = standingGeometry({ x: 200, y: 100, width: 300, height: 600, imageWidth: 768, imageHeight: 1536 }, 390, 844)
  assert.equal(a.width, b.width); assert.equal(a.height, b.height)
})
test('missing metadata has finite nonzero fallback dimensions', () => {
  const g = standingGeometry(null, 390, 844)
  assert.ok(Number.isFinite(g.width) && g.width > 0)
  assert.equal(g.width / g.height, 0.5)
})
