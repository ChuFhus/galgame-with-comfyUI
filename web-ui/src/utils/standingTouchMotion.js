// A small elastic deformation of the existing PNG; feet remain the pivot.
export function touchMotionTransform(part, point, bounds, strength = 1) {
  const x = point && bounds?.width ? (point.x * bounds.imageWidth - bounds.x) / bounds.width : .5
  const direction = x < .5 ? 1 : -1
  const profiles = {
    head: [0, 2, .029, -.038, .35, .3],
    face: [9, 0, -.018, .009, 1.3, 1.7],
    neck: [5, 2, .014, -.022, .9, 1],
    shoulder: [7, 3, .018, -.025, 1.4, .9],
    hand: [10, -2, -.012, .012, 1.5, 1.1],
    chest: [4, 3, .022, -.027, .65, .8],
    belly: [5, 4, .03, -.032, .9, 1.1],
    butt: [8, -2, -.017, .015, 1.4, 1.2],
    thigh: [6, -5, -.014, .019, 1.1, .8],
    calf: [5, -7, -.017, .022, 1, .6],
    foot: [3, -9, -.02, .027, .8, .4],
  }
  const [tx, ty, sx, sy, rotate, skew] = profiles[part] || profiles.head
  return `translate(${tx * direction * strength}px, ${ty * strength}px) rotate(${rotate * direction * strength}deg) skewX(${skew * direction * strength}deg) scale(${1 + sx * strength}, ${1 + sy * strength})`
}
