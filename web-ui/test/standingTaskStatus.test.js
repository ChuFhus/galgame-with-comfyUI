import test from 'node:test'
import assert from 'node:assert/strict'
import { standingTaskActivity, standingTaskEndMessage } from '../src/utils/standingTaskStatus.js'

test('idle and paused tasks do not keep the background indicator visible', () => {
  assert.deepEqual(standingTaskActivity([{ busy: true, jobStatus: 'paused', touchStatus: 'ready' }, { busy: false, jobStatus: 'failed' }]), { standing: 0, stopping: 0, touch: 0 })
})
test('queued, generating, and stopping tasks remain visible independently of dialogue generation', () => {
  assert.deepEqual(standingTaskActivity([
    { busy: true, jobStatus: 'queued' }, { busy: true, jobStatus: 'generating', touchStatus: 'generating' },
    { busy: true, jobStatus: 'stopping' },
  ]), { standing: 2, stopping: 1, touch: 1 })
})
test('historical completion and failure do not produce notifications on initial load', () => {
  assert.equal(standingTaskEndMessage({}, [{ id: 1, jobStatus: 'failed', touchStatus: 'failed' }, { id: 2, jobStatus: 'done' }]), '')
})
test('stopping to paused reports termination even when the service keeps busy true', () => {
  const paused = { id: 1, busy: true, jobStatus: 'paused' }
  assert.match(standingTaskEndMessage({ 1: { busy: true, jobStatus: 'stopping' } }, [paused]), /后台任务已停止/)
  assert.equal(standingTaskEndMessage({ 1: paused }, [paused]), '')
})
test('completion and partial failure are reported without calling failures successful', () => {
  assert.match(standingTaskEndMessage({ 1: { busy: true, jobStatus: 'generating', touchStatus: 'generating' } }, [
    { id: 1, busy: false, jobStatus: 'partial_failed', touchStatus: 'ready' },
  ]), /1 项后台任务已完成；1 项后台任务失败或部分失败/)
})
