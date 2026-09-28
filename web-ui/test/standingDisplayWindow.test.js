import test from 'node:test'
import assert from 'node:assert/strict'
import { openStandingDisplay } from '../src/utils/standingDisplay.js'

test('display uses an always-on-top document PiP window and reuses it', async () => {
  const previous = globalThis.window
  let attached, requests = 0, focused = 0
  const pip = { document: { body: { style: {}, append: frame => { attached = frame } }, createElement: () => ({ style: {} }) }, focus: () => focused++ }
  globalThis.window = { location: { href: 'https://example.test/#/chat' }, documentPictureInPicture: { requestWindow: async () => { requests++; return pip } }, open: () => assert.fail('ordinary popup must not open') }
  try {
    assert.equal(await openStandingDisplay(), true)
    assert.equal(attached.src, 'https://example.test/#/standing-display?desktop=1')
    assert.equal(pip.document.title, '用手机查看效果更佳~')
    window.documentPictureInPicture.window = pip
    assert.equal(await openStandingDisplay(), true)
    assert.equal(requests, 1)
    assert.equal(focused, 1)
  } finally { globalThis.window = previous }
})

test('unsupported PiP falls back and reports a blocked popup', async () => {
  const previous = globalThis.window
  globalThis.window = { location: { href: 'http://localhost/#/chat' }, open: () => null }
  try { assert.equal(await openStandingDisplay(), false) }
  finally { globalThis.window = previous }
})
