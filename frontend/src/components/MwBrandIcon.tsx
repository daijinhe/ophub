// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import type { ReactNode } from 'react'
import simpleIcons from './mw-icons.json'

/**
 * 中间件官方品牌图标（本地打包，无需请求外部 CDN）
 * - simple-icons 已收录 Nginx / Redis / MySQL / PHP / Oracle（Java）等官方单色 logo
 * - 国产/小众产品（宝兰德 BWS310）使用自绘 SVG
 *
 * 渲染说明：simple-icons 的 JSON 是 Iconify 集合格式，width/height 写在集合顶层，
 * 单个图标对象只含 body。若直接把图标对象丢给 @iconify/react，会因缺少尺寸被推断成
 * viewBox="0 0 1 1"，把 24 单位的可视区域裁掉（图标看起来“缺一块 / 不完整”）。
 * 这里直接拼原生 <svg viewBox="0 0 24 24"> 注入 body，尺寸永远正确。
 */

export const MW_BRAND_ICON: Record<string, string> = {
  nginx: 'nginx',
  jdk: 'oracle',
  redis: 'redis',
  mysql: 'mysql',
  php: 'php',
  // 宝兰德bws310 无官方品牌图，走自绘分支
}

// 官方品牌主色（保持与卡片徽章协调）
export const MW_BRAND_COLOR: Record<string, string> = {
  nginx: '#009639', // nginx 官方绿
  jdk: '#F80000',   // oracle 红
  redis: '#A41E11', // redis 红
  mysql: '#00758F', // mysql 蓝
  php: '#777BB4',   // php 紫
  宝兰德bws310: '#0ea5e9',
}

interface BrandIconProps {
  type: string
  size?: number
  className?: string
  style?: React.CSSProperties
  color?: string
}

// 自绘：宝兰德 BWS310（simple-icons 未收录）。透明底 + 白色 BWS 文字，叠在品牌色徽章上。
function BwsMark({ size = 24, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="宝兰德 BWS310"
      style={{ display: 'block' }}
    >
      <text
        x="32"
        y="42"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        fontWeight={800}
        fontSize="24"
        letterSpacing="1"
        fill={color}
      >
        BWS
      </text>
    </svg>
  )
}

export function MwBrandIcon({ type, size = 24, className, style, color = '#fff' }: BrandIconProps): ReactNode {
  if (type === '宝兰德bws310') {
    return (
      <span className={className} style={style}>
        <BwsMark size={size} color={color} />
      </span>
    )
  }
  const name = MW_BRAND_ICON[type]
  const body = name ? ((simpleIcons.icons as Record<string, any>)[name]?.body as string) : ''
  if (!body) {
    // 兜底：取名称首字母大写，避免空白
    return (
      <span
        className={className}
        style={{
          ...style,
          fontSize: size,
          color,
          fontWeight: 700,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {type.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${(simpleIcons.width as number) || 24} ${(simpleIcons.height as number) || 24}`}
      width={size}
      height={size}
      fill="currentColor"
      color={color}
      className={className}
      style={style}
      role="img"
      aria-label={name}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}
