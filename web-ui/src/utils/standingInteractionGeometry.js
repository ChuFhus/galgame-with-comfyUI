export function insideEllipse(point, ellipse) {
  return Boolean(point && ellipse?.rx > 0 && ellipse?.ry > 0 && ((point.x - ellipse.cx) / ellipse.rx) ** 2 + ((point.y - ellipse.cy) / ellipse.ry) ** 2 <= 1)
}
export function hitStandingRegion(point, regions) {
  if (insideEllipse(point, regions?.cheek)) return 'cheek'
  return insideEllipse(point, regions?.head) ? 'head' : null
}
export function pointerInStanding(svg, event, bounds) {
  try {
    const matrix = svg?.getScreenCTM()
    if (!matrix || !bounds?.imageWidth || !bounds?.imageHeight) return null
    const p = svg.createSVGPoint()
    p.x = event.clientX; p.y = event.clientY
    const q = p.matrixTransform(matrix.inverse())
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return null
    return { x: q.x / bounds.imageWidth, y: q.y / bounds.imageHeight }
  } catch { return null }
}
export function suggestStandingRegions(bounds) {
  if (!bounds?.imageWidth || !bounds?.imageHeight) return { head: null, cheek: null }
  const { x, y, width, height, imageWidth: w, imageHeight: h } = bounds
  return {
    head: { cx: (x + width * .5) / w, cy: (y + height * .1) / h, rx: width * .16 / w, ry: height * .055 / h },
    cheek: { cx: (x + width * .54) / w, cy: (y + height * .2) / h, rx: width * .1 / w, ry: height * .04 / h },
  }
}
export function clampStandingEllipse(ellipse) {
  const rx = Math.max(.005, Math.min(.49, ellipse.rx)), ry = Math.max(.005, Math.min(.49, ellipse.ry))
  return { cx: Math.max(rx, Math.min(1 - rx, ellipse.cx)), cy: Math.max(ry, Math.min(1 - ry, ellipse.cy)), rx, ry }
}
export function createStandingGesture({ tool = 'hand', point, screen, time, regions, headWidth = 60 }) {
  const zone = hitStandingRegion(point, regions)
  if (!point || tool === 'hand' && !zone) return null
  return { tool, regions, zone, startTime: time, lastTime: time, start: screen, last: screen, headThreshold: Math.max(16, Math.min(36, headWidth * .35)), headTime: 0, contactTime: 0, headPath: 0, contactPath: 0, distance: 0, outsideAt: null, previousHead: insideEllipse(point, regions?.head), previousContact: Boolean(zone) }
}
export function moveStandingGesture(g, { point, screen, time }) {
  if (!g || !point) return null
  const head = insideEllipse(point, g.regions?.head), contact = Boolean(hitStandingRegion(point, g.regions))
  const dt = Math.max(0, time - g.lastTime)
  const distance = Math.hypot(screen.x - g.last.x, screen.y - g.last.y)
  g.distance = Math.max(g.distance, Math.hypot(screen.x - g.start.x, screen.y - g.start.y))
  if (head && g.previousHead) { g.headTime += dt; if (distance >= 2) g.headPath += distance }
  if (contact && g.previousContact) { g.contactTime += dt; if (distance >= 2) g.contactPath += distance }
  const tracking = g.tool === 'hand' ? head : contact
  if (!tracking) {
    g.outsideAt ??= time
    if (time - g.outsideAt > 150) { g.headTime = 0; g.contactTime = 0; g.headPath = 0; g.contactPath = 0 }
  } else if (g.outsideAt !== null) {
    if (time - g.outsideAt > 150) { g.headTime = 0; g.contactTime = 0; g.headPath = 0; g.contactPath = 0 }
    g.outsideAt = null
  }
  g.last = screen; g.lastTime = time; g.previousHead = head; g.previousContact = contact
  return standingGestureAction(g, point, time)
}
export function standingGestureAction(g, point, time) {
  if (!g || !point) return null
  const zone = hitStandingRegion(point, g.regions)
  if (!zone) return null
  if (g.tool === 'plush') return 'plush'
  if (g.tool === 'feather') return g.contactTime >= 400 && g.contactPath >= 8 ? 'feather' : null
  if (g.zone === 'head' && insideEllipse(point, g.regions.head) && g.headTime >= 250 && g.headPath >= g.headThreshold) return 'stroke'
  if (zone === g.zone && time - g.startTime <= 250 && g.distance <= 10) return zone === 'cheek' ? 'poke' : 'pat'
  return null
}
