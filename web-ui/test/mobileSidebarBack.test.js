import test from 'node:test'
import assert from 'node:assert/strict'
import { createMobileSidebarBackHandler } from '../src/utils/mobileSidebarBack.js'

test('mobile Back opens the shared character sidebar and consumes the native event', () => {
  let opened = false
  const back = createMobileSidebarBackHandler({ isMobile: () => true, isOpen: () => opened, open: () => { opened = true } })
  assert.equal(back(), true)
  assert.equal(opened, true)
  assert.equal(back(), false)
  opened = false
  assert.equal(back(), true)
})

test('desktop display does not consume mobile Back', () => {
  const back = createMobileSidebarBackHandler({ isMobile: () => false, isOpen: () => false, open: () => assert.fail('desktop must not open sidebar') })
  assert.equal(back(), false)
})
