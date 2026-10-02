// Real TownView with isolated, in-memory HTTP. No user's world or model calls.
import { createApp, h, reactive } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import TownView from '../../src/views/TownView.vue'
import LinsheButton from '../../src/components/ui/LinsheButton.vue'
import { useSettingsStore } from '../../src/stores/settings.js'
import '../../src/styles/tokens.css'
import '../../src/styles/base.css'
import '../../src/styles/components.css'
import '../../src/styles/animations.css'

const metrics = reactive({ calls: [], dark: false, mobile: false, delay: false, error: false, status: '长按居民，拖到空地后松手', forbidden: 0 })
const svg = text => 'data:image/svg+xml,' + encodeURIComponent(text) + '#'
const sprite = svg('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="80"><path d="M13 40h22l7 26H6Z" fill="#da8190" stroke="#58473d" stroke-width="2"/><circle cx="24" cy="23" r="17" fill="#f7d8ba" stroke="#58473d" stroke-width="2"/><path d="M7 23Q4 1 24 3Q46 0 41 25L31 12L18 20L17 12Z" fill="#66504b"/><path d="M17 27h3m8 0h3M20 35q4 3 8 0M16 67v10m16-10v10" stroke="#58473d" stroke-width="3"/></svg>')
const grass = svg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#abc397" d="M0 0h64v64H0z"/><path d="M0 0h64v64H0zM14 22l2-4m25 28l2-4" fill="none" stroke="#97b183"/></svg>')
const grid = () => Array.from({ length: 12 }, () => Array(12).fill(1))
const blocks = grid().map(row => row.map(() => null)); blocks[7][7] = 1
const map = { id: 1, version: 1, name: '拎起测试镇', cols: 12, rows: 12,
  layers: { ground: grid(), road: [], objects: [], blockOverride: blocks }, locations: [],
  assets: [{ id: 1, kind: 'ground', imagePath: grass, meta: { projection: 'topdown_square' } }] }
const resident = { actorId: 'carry-fixture-actor', agentKey: 'npc:1', npcId: 1, displayName: '小桃',
  x: 5, y: 5, path: [], speed: .5, presence: 'in_town', encounterId: null,
  sprites: { down: sprite, up: sprite }, standingUrl: sprite }
const snapshot = () => ({ worldId: 'fixture', worldEpoch: 1, mapId: 1, playerRevision: 1,
  serverTime: Date.now(), initialized: true, map, locations: [], lifeVenues: [], encountersActive: [],
  agents: [structuredClone(resident)], player: { agentKey: 'me', x: 6, y: 6, path: [], sprites: { down: sprite } },
  weather: { hour: 12, text: '晴' } })
let lease = null
window.fetch = async (url, options = {}) => {
  const path = new URL(String(url), location.href).pathname
  const body = options.body ? JSON.parse(options.body) : {}
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  if (path.endsWith('/carry')) {
    metrics.calls.push(body.operation)
    if (body.operation === 'begin') {
      if (metrics.delay) await new Promise(r => setTimeout(r, 1500))
      if (metrics.error) return response({ error: '测试：居民正在交谈' }, 409)
      lease = body.token
    } else if (body.token !== lease) return response({ error: '租约已结束' }, 409)
    if (body.operation === 'drop') { resident.x = body.x; resident.y = body.y; lease = null }
    if (body.operation === 'cancel') lease = null
    metrics.status = `${body.operation} · 居民位置 (${resident.x}, ${resident.y})`
    return response({ ok: true, position: { x: resident.x, y: resident.y }, returned: body.operation === 'cancel' })
  }
  if (path === '/api/town/state') return response(snapshot())
  if (path === '/api/town/map') return response(map)
  if (path === '/api/town/maps') return response({ currentMapId: 1, playerRevision: 1, maps: [{ ...map, status: 'ready' }] })
  if (path === '/api/town/activity') return response({ entries: [] })
  if (path === '/api/town/viewer/heartbeat') return response({ ok: true })
  if (path === '/api/town/player/move' || path === '/api/town/player/dir') { metrics.status = '普通地图点击'; return response({ ok: true }) }
  if (path.endsWith('/hold') || path.endsWith('/release')) { metrics.status = '普通点击对话'; return response({ ok: true }) }
  if (path.includes('/interactions')) return response({ capabilities: [], choices: [] })
  if (path.endsWith('/messages')) return response({ messages: [] })
  if (path.endsWith('/encounters')) return response({ encounters: [] })
  if (path.endsWith('/npcs/1')) return response({ id: 1, display_name: '小桃', portrait_path: sprite })
  metrics.forbidden++; return response({ error: `Fixture blocked ${path}` }, 400)
}
const style = document.createElement('style')
style.textContent = 'body{margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:sans-serif}.fixture-controls{display:flex;gap:10px;padding:10px;align-items:center;flex-wrap:wrap}.fixture-host{height:680px;position:relative}.fixture-host.mobile{width:390px;height:844px;margin:auto}.fixture-host.mobile .town-view{position:relative!important;left:0!important;top:0!important;width:100%!important;height:100%!important;transform:none!important}.fixture-host .town-shell{height:100%}pre{white-space:pre-wrap;padding:8px}'
document.head.append(style)
const pinia = createPinia()
useSettingsStore(pinia).bgmMuted = true
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: TownView }] })
// Fixed scene: resident starts one diagonal cell behind the centered player.
// Exercise the real canvas handlers, including the long-press timer and HTTP adapter.
function demoCarry() {
  const canvas = document.querySelector('.town-view canvas:last-of-type')
  const rect = canvas.getBoundingClientRect()
  const x = rect.width / 2, y = rect.height / 2 - 130
  const send = (type, dx = 0) => {
    const event = new PointerEvent(type, {
    bubbles: true, pointerId: 91, pointerType: 'touch', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: rect.left + x + dx, clientY: rect.top + y,
    })
    Object.defineProperties(event, { offsetX: { value: x + dx }, offsetY: { value: y } })
    canvas.dispatchEvent(event)
  }
  send('pointerdown')
  setTimeout(() => send('pointermove', 120), 850)
  setTimeout(() => send('pointerup', 120), 8000)
}
createApp({ render: () => h('main', [
  h('div', { class: 'fixture-controls' }, [
    h(LinsheButton, { onClick: demoCarry }, () => '触控长按回归（8秒）'),
    h(LinsheButton, { onClick: () => { metrics.dark = !metrics.dark; document.documentElement.dataset.theme = metrics.dark ? 'dark' : 'warm' } }, () => '暖色 / 暗夜'),
    h(LinsheButton, { onClick: () => { metrics.mobile = !metrics.mobile } }, () => '桌面 / 手机宽度'),
    h(LinsheButton, { onClick: () => { metrics.delay = !metrics.delay } }, () => `延迟响应：${metrics.delay}`),
    h(LinsheButton, { onClick: () => { metrics.error = !metrics.error } }, () => `拒绝拎起：${metrics.error}`),
  ]),
  h('p', { style: 'padding:0 12px' }, metrics.status),
  h('div', { class: ['fixture-host', metrics.mobile && 'mobile'] }, [h(TownView)]),
  h('pre', {}, `请求：${metrics.calls.join(', ')}\n拦截其他接口：${metrics.forbidden}`),
]) }).use(pinia).use(router).mount('#app')
