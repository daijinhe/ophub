// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from 'react'
import { Select, Input, Button, Divider, Tooltip } from 'antd'
import { PlusOutlined, CloseOutlined } from '@ant-design/icons'

interface Props {
  value?: string
  /** 合并后的完整选项（内置 + 自定义） */
  options: string[]
  onChange?: (v: string) => void
  /** 追加自定义值（持久化由调用方决定） */
  onAddOption?: (v: string) => void
  /** 可删除的选项（仅自定义值） */
  removable?: string[]
  onRemoveOption?: (v: string) => void
  disabled?: boolean
  placeholder?: string
  allowClear?: boolean
  style?: React.CSSProperties
}

/**
 * 下拉选择器：内置选项 + 自定义值。
 *
 * 关键点 1：dropdownRender 内的自定义输入区必须阻止 mousedown 冒泡/默认行为，
 *          否则点击输入框会让 Select 失焦并关闭下拉。
 *
 * 关键点 2（2026-09-12 二次修复）：**主选择框里直接打字也必须算数**。
 *   placeholder 是「请选择或输入业务环境」，用户最自然的动作就是直接在框里敲
 *   `jenkins` —— 但 antd Select 的 `showSearch` 只是「本地筛选」，输入的文字
 *   不会触发 onChange，于是：
 *     · 点弹窗「保存」→ 提交的是旧值（用户看到「保存失败 / 没生效」）；
 *     · 点下拉底部的「添加」→ 底部输入框是空的，点了毫无反应。
 *   现在：搜索文本被 `onSearch` 接住，并在「下拉收起 / 失焦 / 回车 / 点创建行」
 *   四处落到字段值上；下拉顶部还会实时出现「使用自定义值「xxx」」一行，点它即选中。
 *
 * 关键点 3：输入内容必须**实时同步到字段值**（底部输入框边打边写）。
 *   早期版本只在「回车 / 点添加」时才 onChange，用户打完字直接点「保存」
 *   （下拉收起、内部草稿被丢弃）就会出现「输入完保存不好使」。
 */
export default function OptionSelect({
  value,
  options,
  onChange,
  onAddOption,
  removable = [],
  onRemoveOption,
  disabled,
  placeholder = '请选择',
  allowClear = true,
  style,
}: Props) {
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  /** 下拉是否展开（仅镜像 antd 状态，用于挂「穿透点击」监听） */
  const [open, setOpen] = useState(false)
  /** 主选择框里的搜索文本（ref 版，供事件回调里读最新值，避免闭包取到旧 state） */
  const searchRef = useRef('')
  /** 本次收起下拉是因为「选中了选项」→ 不要再用搜索词/草稿去覆盖它 */
  const pickedRef = useRef(false)
  const selRef = useRef<{ blur?: () => void } | null>(null)

  /** 输入中：立即同步为字段值（不写进选项列表，避免每敲一个字就多一条记录） */
  const typing = (raw: string) => onChange?.((raw || '').trim())

  /** 提交：写入字段值 + 记住该自定义选项（空值直接忽略） */
  const commit = (raw: string) => {
    const v = (raw || '').trim()
    if (!v) return
    if (!options.includes(v)) onAddOption?.(v)
    onChange?.(v)
    setDraft('')
    setSearch('')
    searchRef.current = ''
  }

  const prevent = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  /** 当前搜索词是否可以作为一个新自定义值（与已有选项忽略大小写去重） */
  const q = search.trim()
  const canCreate = !!q && !options.some((o) => o.toLowerCase() === q.toLowerCase())

  /**
   * 关键点 4（2026-09-12）：**下拉浮层不许吃掉弹窗底部按钮的点击**。
   * 实测：自定义值攒多了之后下拉高达 300px，把弹窗的「保存」按钮整个盖住，
   * 点在按钮位置上其实点到了下拉的空白处 —— 用户看到的现象就是
   * 「点保存没反应」。这里在下拉展开期间监听 mousedown：
   * 若点在下拉的**非控件空白处**、且该坐标落在弹窗 footer 上，
   * 就关掉下拉并把这次点击转交给 footer 上的按钮。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || typeof t.closest !== 'function') return
      if (!t.closest('.ant-select-dropdown')) return
      // 点的是下拉里的实体控件（选项 / 创建行 / 输入框 / 按钮）→ 交给组件自己处理
      if (t.closest('.ant-select-item') || t.closest('button') || t.closest('input') || t.closest('textarea')) return
      // 该坐标是否落在弹窗底部按钮区
      const foot = Array.from(document.querySelectorAll('.ant-modal-footer')).find((f) => {
        const r = f.getBoundingClientRect()
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      })
      if (!foot) return
      const x = e.clientX
      const y = e.clientY
      e.preventDefault()
      e.stopPropagation()
      // 关下拉（blur → onBlur → commit，保证已输入的值先落进字段）
      selRef.current?.blur?.()
      window.setTimeout(() => {
        const under = document.elementsFromPoint(x, y).find((n) => n.closest('.ant-modal-footer'))
        const btn = under?.closest('button') as HTMLButtonElement | null
        btn?.click()
      }, 80)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open])

  return (
    <Select
      ref={(el: any) => {
        selRef.current = el
      }}
      value={value || undefined}
      onChange={(v) => {
        // 选中已有选项 / 清空：草稿与搜索词必须一起清掉，
        // 否则下拉收起时 commit 会用旧草稿 + 旧搜索词覆盖用户刚选的值
        pickedRef.current = true
        setDraft('')
        setSearch('')
        searchRef.current = ''
        onChange?.(v ?? '')
      }}
      disabled={disabled}
      allowClear={allowClear}
      placeholder={placeholder}
      showSearch
      optionFilterProp="label"
      // 选项列表限高：下拉整体别太高，避免盖住弹窗底部的「保存」按钮
      listHeight={180}
      style={style}
      onSearch={(t) => {
        // 主选择框里直接打字：只记录，不立即写入字段（避免边打边变成已选值）
        searchRef.current = t
        setSearch(t)
      }}
      // 下拉收起（点「保存」/ 点别处）时，把已输入但没回车的值落下来
      onDropdownVisibleChange={(o) => {
        setOpen(o)
        if (o) {
          pickedRef.current = false
          setDraft('')
          setSearch('')
          searchRef.current = ''
          return
        }
        if (!pickedRef.current) commit(draft || searchRef.current)
        pickedRef.current = false
      }}
      // 失焦兜底：Tab / 点到别处
      onBlur={() => commit(draft || searchRef.current)}
      options={options.map((o) => {
        const isCustom = removable.includes(o)
        return {
          value: o,
          label: isCustom ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o}</span>
              <Tooltip title="删除该自定义值">
                <CloseOutlined
                  style={{ fontSize: 11, color: '#94a3b8', flex: '0 0 auto' }}
                  onMouseDown={(e) => {
                    prevent(e)
                    onRemoveOption?.(o)
                  }}
                />
              </Tooltip>
            </div>
          ) : (
            o
          ),
        }
      })}
      dropdownRender={(menu) => (
        <div>
          {/* 在主选择框里打了字、且不是已有选项 → 直接给一行「使用该值」 */}
          {canCreate && (
            <div
              onMouseDown={prevent}
              onClick={() => {
                const v = q
                commit(v)
                selRef.current?.blur?.()
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 12px',
                cursor: 'pointer',
                color: '#1677ff',
                borderBottom: '1px solid var(--bg-3, #f0f0f0)',
              }}
            >
              <PlusOutlined style={{ fontSize: 12 }} />
              <span>使用自定义值「{q}」</span>
            </div>
          )}
          {menu}
          <Divider style={{ margin: '4px 0' }} />
          <div
            style={{ display: 'flex', gap: 6, padding: '0 8px 6px' }}
            // 关键：阻止冒泡 + 默认行为，保证输入框可聚焦、下拉不被关闭
            onMouseDown={prevent}
          >
            <Input
              size="small"
              placeholder="输入自定义值（回车或点添加）"
              value={draft}
              disabled={disabled}
              onChange={(e) => {
                setDraft(e.target.value)
                typing(e.target.value)
              }}
              // 失焦也提交一次，兜住「输入后直接去点保存」的路径
              onBlur={() => commit(draft)}
              onPressEnter={(e) => {
                e.preventDefault()
                e.stopPropagation()
                commit(draft)
              }}
            />
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              disabled={disabled}
              onClick={() => {
                // 底部输入框空着时，把主选择框里打的字也用上（用户以为「添加」就该加它）
                commit(draft || searchRef.current)
              }}
            >
              添加
            </Button>
          </div>
        </div>
      )}
    />
  )
}

/**
 * 无内置选项的字段：可输入 + 记住历史自定义值。
 * 注意 tags 模式下 Select 的 value 必须是数组，早期版本直接传字符串，
 * antd 会按字符逐个渲染成多个标签，这里做了归一化。
 */
export function OptionAutoComplete({
  value,
  options,
  onChange,
  onAddOption,
  disabled,
  placeholder = '输入新值',
  style,
}: Omit<Props, 'removable' | 'onRemoveOption'>) {
  const v = (value || '').trim()
  return (
    <Select
      value={v ? [v] : []}
      onChange={(arr) => {
        const next = ((arr as string[]) || [])[0] || ''
        onChange?.(next)
        if (next && !options.includes(next)) onAddOption?.(next)
      }}
      disabled={disabled}
      showSearch
      placeholder={placeholder}
      style={style}
      mode="tags"
      maxCount={1}
      open={false}
      suffixIcon={null}
      options={options.map((o) => ({ value: o, label: o }))}
    />
  )
}
