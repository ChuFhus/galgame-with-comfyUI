export const carryGroundPoint = g => ({
  x: g.point.x + (g.gripOffset?.x || 0), y: g.point.y + (g.gripOffset?.y || 0),
})

/** Screen-space overlay keeps the carried sprite in front of roofs, with its shadow on the ground. */
export function drawResidentCarry(ctx, g, { zoom, now, reducedMotion, project, getImage, valid, colors }) {
  if (!g || g.phase === 'starting') return
  const image = [g.agent.sprites?.[g.direction || 'down'], g.agent.standingUrl, g.agent.avatarPath]
    .map(url => url && getImage(url)).find(Boolean)
  const ground = carryGroundPoint(g)
  const lift = 26 * zoom
  const landing = g.phase === 'landing'
  const progress = Math.min(1, Math.max(0, (now - (landing ? g.landedAt : g.heldAt)) / 300))
  const eased = 1 - (1 - progress) ** 3
  const target = landing ? project(g.position) : ground
  const feet = landing
    ? { x: ground.x + (target.x - ground.x) * eased, y: ground.y - lift + (target.y - ground.y + lift) * eased }
    : { x: ground.x, y: ground.y - lift * (reducedMotion ? 1 : eased) }
  const h = 72 * zoom
  const w = h * (image ? (image.naturalWidth || image.width) / (image.naturalHeight || image.height) : .65)
  ctx.save()
  ctx.globalAlpha = landing ? 1 - progress : 1
  ctx.fillStyle = 'rgba(30,25,20,.24)'
  ctx.beginPath(); ctx.ellipse(target.x, target.y, 15 * zoom, 6 * zoom, 0, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = valid ? colors.accent : colors.danger
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.ellipse(target.x, target.y, 22 * zoom, 10 * zoom, 0, 0, Math.PI * 2); ctx.stroke()
  ctx.restore()
  ctx.save()
  ctx.translate(feet.x, feet.y - h)
  if (!reducedMotion && !landing) ctx.rotate(Math.sin((now - g.heldAt) / (now - g.heldAt > 5000 ? 100 : 220)) * .08)
  ctx.imageSmoothingEnabled = true
  if (image) ctx.drawImage(image, -w / 2, 0, w, h)
  else {
    ctx.fillStyle = colors.paper; ctx.strokeStyle = colors.ink; ctx.lineWidth = 2
    ctx.beginPath(); ctx.ellipse(0, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = colors.ink; ctx.font = `${18 * zoom}px sans-serif`; ctx.textAlign = 'center'
    ctx.fillText((g.agent.displayName || '邻')[0], 0, h / 2)
  }
  if (!landing) {
    ctx.fillStyle = colors.paper; ctx.strokeStyle = colors.ink; ctx.lineWidth = 2
    ctx.beginPath(); ctx.ellipse(w / 2 + 8, 5, 13, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    ctx.fillStyle = colors.ink; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText(g.count >= 3 ? '╬' : now - g.heldAt > 5000 ? '〰' : '!', w / 2 + 8, 10)
  }
  ctx.restore()
}
