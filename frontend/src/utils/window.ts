/**
 * 生成 window.open 的 features 字符串，把新窗口定位到屏幕正中间。
 *
 * 用法：
 *   window.open('/webterm/1', '_blank', buildCenteredFeatures())
 *   window.open('/webterm/1', 'webterm-1', buildCenteredFeatures(1280, 860, 'menubar=no,...'))
 *
 * 注意：浏览器在多显示器/缩放非 100% 时，screen.availWidth/Height 与实际可视区域可能略有偏差；
 * 但作为「屏幕正中间」展示已经足够准确，且不需要任何权限申请（与 window.screenX/Y 偏移计算相比更稳）。
 */
export function buildCenteredFeatures(
  width = 1280,
  height = 860,
  extra: string = 'menubar=no,toolbar=no,location=no,status=no,resizable=yes',
): string {
  let top = 0
  let left = 0
  try {
    const sw = window.screen?.availWidth ?? window.screen?.width ?? 1920
    const sh = window.screen?.availHeight ?? window.screen?.height ?? 1080
    left = Math.max(0, Math.round((sw - width) / 2))
    top = Math.max(0, Math.round((sh - height) / 2))
  } catch {
    /* SSR / 无 window：保持 0,0 */
  }
  const base = `width=${width},height=${height},top=${top},left=${left}`
  return extra ? `${base},${extra}` : base
}

/**
 * 一站式：在屏幕正中间打开一个新窗口。
 * 如果浏览器拦截了弹窗，返回 null；调用方负责提示用户放行。
 */
export function openCenteredWindow(
  url: string,
  target: string = '_blank',
  width = 1280,
  height = 860,
  extra: string = 'menubar=no,toolbar=no,location=no,status=no,resizable=yes',
): Window | null {
  return window.open(url, target, buildCenteredFeatures(width, height, extra))
}