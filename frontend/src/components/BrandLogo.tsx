// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

/**
 * 云枢品牌徽章（v1.7.45）：登录 / 注册页共用。
 *
 * ⚠️ 图标直接复用巡检大屏顶栏那份 `/inspection-logo-icon.svg` —— 品牌图形全项目只此一份。
 * 另外自造一个「云」图标只会让登录页和大屏看起来像两个产品（自造过一次，已回退）。
 * 深蓝渐变方块在近黑底上对比度偏低，所以外层用 CSS 补一圈极细青边 + 蓝色辉光把它托起来。
 */
export default function BrandLogo({ size = 64 }: { size?: number }) {
  return (
    <span className="xy-badge" style={{ width: size, height: size }}>
      <img src="/inspection-logo-icon.svg" alt="" aria-hidden="true" />
    </span>
  )
}
