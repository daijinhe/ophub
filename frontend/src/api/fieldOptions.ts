// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

// 字段下拉选项的「自定义值」持久化层
// 说明：内置选项来自后端 /api/fields（真源 backend/fields.go ← scripts/gen_fields.py）；
//       这里只存用户在界面上追加的自定义值，合并后一起展示。
//       当前用 localStorage，满足"本机后续继续添加"；若需跨用户共享，
//       把 load/save 换成接口调用即可（调用方只依赖这两个函数与数据结构）。

const LS_KEY = 'cmdb.fieldOptions.v1'

export type CustomOptionMap = Record<string, string[]>

export function loadCustomOptions(): CustomOptionMap {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: CustomOptionMap = {}
    Object.entries(obj as Record<string, unknown>).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        const list = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        if (list.length) out[k] = list
      }
    })
    return out
  } catch {
    return {}
  }
}

export function saveCustomOptions(m: CustomOptionMap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(m))
  } catch {
    // 隐私模式 / 配额超限时静默失败，不影响主流程
  }
}

/** 内置 + 自定义，去重保序（内置在前，自定义追加在后） */
export function mergeOptions(base?: string[], custom?: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of [...(base || []), ...(custom || [])]) {
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/** 追加一个自定义值，返回新的 map（已存在则原样返回，避免无意义重渲） */
export function addCustomOption(
  map: CustomOptionMap,
  fieldKey: string,
  value: string,
): CustomOptionMap {
  const v = (value ?? '').trim()
  if (!v) return map
  const cur = map[fieldKey] || []
  if (cur.includes(v)) return map
  return { ...map, [fieldKey]: [...cur, v] }
}

/** 移除一个自定义值 */
export function removeCustomOption(
  map: CustomOptionMap,
  fieldKey: string,
  value: string,
): CustomOptionMap {
  const cur = map[fieldKey] || []
  const next = cur.filter((x) => x !== value)
  if (next.length === cur.length) return map
  const out = { ...map }
  if (next.length) out[fieldKey] = next
  else delete out[fieldKey]
  return out
}
