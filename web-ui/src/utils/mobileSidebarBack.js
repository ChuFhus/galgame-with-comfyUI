// Android shell expects a synchronous boolean: true means the page consumed Back.
export function createMobileSidebarBackHandler({ isMobile, isOpen, open }) {
  return () => {
    if (!isMobile() || isOpen()) return false
    open()
    return true
  }
}
