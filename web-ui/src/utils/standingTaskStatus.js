export function standingTaskActivity(rows) {
  return {
    standing: rows.filter(row => row.busy && !['paused', 'stopping'].includes(row.jobStatus)).length,
    stopping: rows.filter(row => row.busy && row.jobStatus === 'stopping').length,
    touch: rows.filter(row => row.touchStatus === 'generating').length,
  }
}

// Only report transitions we observed, never old failures on the initial load.
export function standingTaskEndMessage(previous, rows) {
  const ended = { done: 0, stopped: 0, failed: 0 }
  for (const row of rows) {
    const before = previous[row.id]
    if (!before) continue
    if (before.busy && before.jobStatus !== 'paused' && (!row.busy || row.jobStatus === 'paused')) {
      if (row.jobStatus === 'paused') ended.stopped++
      else if (['failed', 'partial_failed'].includes(row.jobStatus)) ended.failed++
      else if (row.jobStatus === 'done') ended.done++
    }
    if (before.touchStatus === 'generating' && row.touchStatus !== 'generating') {
      if (row.touchStatus === 'failed') ended.failed++
      else if (row.touchStatus === 'ready') ended.done++
    }
  }
  return [
    ended.done && `${ended.done} 项后台任务已完成`,
    ended.stopped && `${ended.stopped} 项后台任务已停止，可在角色详情中继续`,
    ended.failed && `${ended.failed} 项后台任务失败或部分失败，请进入角色详情查看`,
  ].filter(Boolean).join('；')
}
