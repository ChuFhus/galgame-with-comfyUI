import { setStandingDisplayCharacter } from '../api/index.js'

const clientId = globalThis.crypto?.randomUUID?.() || `standing-${Date.now()}-${Math.random()}`
let sequence = 0
export function selectStandingCharacter(characterId) {
  return setStandingDisplayCharacter({ characterId, clientId, sequence: ++sequence }).catch(() => {})
}
export async function openStandingDisplay() {
  if (window.documentPictureInPicture) {
    try {
      const existing = window.documentPictureInPicture.window
      if (existing && !existing.closed) { existing.focus(); return true }
      const pip = await window.documentPictureInPicture.requestWindow({ width: 480, height: 800 })
      pip.document.title = '用手机查看效果更佳~'
      pip.document.body.style.margin = '0'
      const frame = pip.document.createElement('iframe')
      frame.title = '同步形象展示'
      frame.src = standingDisplayUrl()
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;'
      pip.document.body.append(frame)
      return true
    } catch { /* Unsupported/denied PiP retains the ordinary display entry. */ }
  }
  const url = new URL(window.location.href)
  url.hash = '/standing-display?desktop=1'
  const win = window.open(url.href, 'linshe-standing-display', 'popup,width=480,height=800,resizable=yes,scrollbars=no')
  if (win) win.focus()
  return !!win
}
export function standingDisplayUrl() {
  const url = new URL(window.location.href)
  url.hash = '/standing-display?desktop=1'
  return url.href
}
