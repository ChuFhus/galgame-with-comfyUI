/** Fit the opaque subject, not the PNG padding; leave room for a head bubble. */
export function standingGeometry(bounds, width, height, { horizontal = 32, vertical = 140 } = {}) {
  const b = bounds?.width > 0 && bounds?.height > 0 ? bounds : { x: 0, y: 0, width: 768, height: 1536, imageWidth: 768, imageHeight: 1536 }
  const scale = Math.max(0.01, Math.min((width - horizontal) / b.width, (height - vertical) / b.height))
  return { width: b.width * scale, height: b.height * scale, image: { width: `${b.imageWidth * scale}px`, height: `${b.imageHeight * scale}px`, left: `${-b.x * scale}px`, top: `${-b.y * scale}px` } }
}
