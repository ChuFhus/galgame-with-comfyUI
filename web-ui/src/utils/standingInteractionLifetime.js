// Own all asynchronous work for one mounted interaction controller. A canceled
// callback stays invalid even if the host has already queued it for execution.
export function createStandingInteractionLifetime({ scope, schedule = setTimeout, unschedule = clearTimeout }) {
  let serial = 0, disposed = false
  const timers = new Map()
  function invalidate() { serial++ }
  function begin() { return { serial: ++serial, scope: scope() } }
  function current(ticket) { return !disposed && ticket.serial === serial && ticket.scope === scope() }
  function cancel(name) { const value = timers.get(name); if (value) unschedule(value.handle); timers.delete(name) }
  function after(name, delay, callback) {
    cancel(name)
    const value = { scope: scope(), handle: null }
    timers.set(name, value)
    value.handle = schedule(() => {
      if (disposed || timers.get(name) !== value || value.scope !== scope()) return
      timers.delete(name); callback()
    }, delay)
  }
  function clear() { for (const name of [...timers.keys()]) cancel(name) }
  function dispose() { disposed = true; invalidate(); clear() }
  return { begin, current, invalidate, after, cancel, clear, dispose, pending: () => timers.size }
}
