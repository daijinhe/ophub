import { useEffect, useRef, useState } from 'react'
import { Modal, Alert, Space, Tag, Select, Button, Input, Progress, Dropdown } from 'antd'
import {
  MonitorOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
  CloseOutlined,
  ExpandOutlined,
  FontSizeOutlined,
  BgColorsOutlined,
  ClearOutlined,
  CopyOutlined,
  ScissorOutlined,
  SnippetsOutlined,
  ReloadOutlined,
  DesktopOutlined,
  FileTextOutlined,
  SettingOutlined,
  PoweroffOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import { Terminal, ITerminalAddon } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { openCenteredWindow } from '../utils/window'
// 会话名统一走 assetDisplayName（项目简称_环境_业务环境_虚拟机IPv4），
// 与资产管理、定时任务、巡检大屏同源，资产改字段后所有页面一起变。
import { assetDisplayName } from '../utils/assetName'

interface Props {
  open: boolean
  asset: { id: number; name?: string; ip?: string; fields?: any } | null
  onClose: () => void
  /** standalone=true 时脱离 Modal，全屏独立渲染（用于新窗口打开） */
  standalone?: boolean
}


interface TermSettings {
  fontSize: number
  fontFamily: string
  theme: string
}

const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 18, 20].map((n) => ({ label: `${n}px`, value: n }))

const FONT_FAMILY_OPTIONS = [
  { label: '默认等宽', value: 'default', family: "'JetBrains Mono','Consolas','Courier New',monospace" },
  { label: 'Consolas', value: 'consolas', family: "'Consolas','Menlo',monospace" },
  { label: 'JetBrains Mono', value: 'jetbrains', family: "'JetBrains Mono','Fira Code',monospace" },
  { label: 'Fira Code', value: 'firacode', family: "'Fira Code','Consolas',monospace" },
  { label: 'Courier New', value: 'courier', family: "'Courier New',monospace" },
  { label: 'Source Code Pro', value: 'source', family: "'Source Code Pro','Consolas',monospace" },
]
const familyOf = (v: string) => FONT_FAMILY_OPTIONS.find((f) => f.value === v)?.family || FONT_FAMILY_OPTIONS[0].family

const THEME_OPTIONS = [
  { label: '深蓝科幻', value: 'default' },
  { label: 'Dracula', value: 'dracula' },
  { label: 'Monokai', value: 'monokai' },
  { label: 'Solarized Dark', value: 'solarized' },
  { label: '经典绿黑', value: 'green' },
  { label: '浅色', value: 'light' },
]

const THEMES: Record<string, any> = {
  default: {
    background: '#0a0f1e', foreground: '#d7e2f0', cursor: '#38bdf8',
    selectionBackground: 'rgba(56,189,248,0.35)',
    black: '#1e293b', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
    blue: '#38bdf8', magenta: '#c084fc', cyan: '#22d3ee', white: '#e2e8f0',
    brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a',
    brightBlue: '#7dd3fc', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
    selectionBackground: 'rgba(255,255,255,0.2)',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
    brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
    selectionBackground: 'rgba(255,255,255,0.2)',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
    blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
    brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  },
  solarized: {
    background: '#002b36', foreground: '#839496', cursor: '#839496',
    selectionBackground: 'rgba(131,148,150,0.3)',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
    brightBlue: '#268bd2', brightMagenta: '#d33682', brightCyan: '#2aa198', brightWhite: '#fdf6e3',
  },
  green: {
    background: '#000000', foreground: '#33ff66', cursor: '#33ff66',
    selectionBackground: 'rgba(51,255,102,0.3)',
    black: '#003300', red: '#ff4444', green: '#33ff66', yellow: '#ffff66',
    blue: '#66ccff', magenta: '#ff66ff', cyan: '#66ffff', white: '#c8ffc8',
    brightBlack: '#005500', brightRed: '#ff8888', brightGreen: '#88ffaa', brightYellow: '#ffffaa',
    brightBlue: '#aaddff', brightMagenta: '#ffbbff', brightCyan: '#bbffff', brightWhite: '#ffffff',
  },
  light: {
    background: '#f5f6f8', foreground: '#24292e', cursor: '#0969da',
    selectionBackground: 'rgba(9,105,218,0.3)',
    black: '#24292e', red: '#cf222e', green: '#116329', yellow: '#9a6700',
    blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#eaeef2',
    brightBlack: '#57606a', brightRed: '#cf222e', brightGreen: '#116329', brightYellow: '#9a6700',
    brightBlue: '#0969da', brightMagenta: '#8250df', brightCyan: '#1b7c83', brightWhite: '#ffffff',
  },
}

const UPLOAD_CHUNK = 48 * 1024

/**
 * VimTerminalQueryAddon —— 主动响应 vim/top/less 等全屏程序发起的终端查询
 * xterm.js 5.5.0 在大部分版本里已能响应 cursor pos query（\x1b[6n）和
 * primary/secondary DA，但某些远程主机（尤其最小化安装的旧机器）的
 * vim 启动时仍可能发出 \x1b[?6c / \x1b[>c / \x1b[6n 等查询，期望终端
 * 模拟器按协议应答。xterm.js 5.5.0 对 \x1b[6n 的响应偶尔在 InputHandler
 * 里被吞掉，导致 vim 等待光标位置、超时后才继续，进而表现为「vim 没反应」。
 * 这个 addon 拦截从 WS 收到的查询序列，立即用 ws.send 回包，确保
 * vim 永远不需要等终端应答。
 */
class VimTerminalQueryAddon implements ITerminalAddon {
  private term: Terminal | null = null
  private ws: WebSocket | null = null
  private buf = ''

  activate(term: Terminal) {
    this.term = term
  }

  setWebSocket(ws: WebSocket) {
    this.ws = ws
  }

  /**
   * 在 ws.onmessage 收到一段数据时调用，识别 vim 的查询并立即回包。
   * 同时把数据原样返回给 caller，caller 仍要写给 term 显示。
   */
  processIncoming(data: string): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return data
    this.buf += data
    // 在缓冲区里找查询序列：\x1b[6n / \x1b[?...c / \x1b[>c 等
    // 一次处理多轮查询（vim 启动时会连发好几个）
    let i = 0
    while (i < this.buf.length) {
      const esc = this.buf.indexOf('\x1b', i)
      if (esc < 0) {
        i = this.buf.length
        break
      }
      // 找到 ESC 后看序列
      const seq = this.buf.slice(esc, esc + 16)
      // cursor position report: \x1b[6n
      if (seq.startsWith('\x1b[6n')) {
        const row = (this.term?.buffer?.active?.cursorY ?? 0) + 1
        const col = (this.term?.buffer?.active?.cursorX ?? 0) + 1
        try { this.ws.send(`\x1b[${row};${col}R`) } catch { /* noop */ }
        i = esc + 4
        continue
      }
      // primary DA: \x1b[c 或 \x1b[?...c
      if (/^\x1b\[\??[0-9;]*c$/.test(seq)) {
        try { this.ws.send('\x1b[?1;2c') } catch { /* noop */ }
        i = esc + seq.length
        continue
      }
      // secondary DA: \x1b[>c 或 \x1b[>...c
      if (/^\x1b\[>[0-9;]*c$/.test(seq)) {
        try { this.ws.send('\x1b[>0;276;0c') } catch { /* noop */ }
        i = esc + seq.length
        continue
      }
      // DECRQM: \x1b[?...$p （模式状态查询，vim 偶尔会发）
      if (/^\x1b\[\??[0-9;]*\$p$/.test(seq)) {
        try { this.ws.send('\x1b[0$Rp') } catch { /* noop */ }
        i = esc + seq.length
        continue
      }
      i = esc + 1
    }
    // 清理已处理的部分（保留尾部不完整的 ESC，避免切断跨包序列）
    const lastEsc = this.buf.lastIndexOf('\x1b')
    if (lastEsc > 0) this.buf = this.buf.slice(lastEsc)
    else this.buf = ''
    return data
  }

  dispose() {
    this.term = null
    this.ws = null
    this.buf = ''
  }
}

// fetchWsTicket 调 /api/ws/ssh/ticket 拿一次性 ticket（带在 Authorization / cookie 上）。
// 服务端 401 / 403 时返回 null → 上层切回 legacy ?token= 形式。
async function fetchWsTicket(authToken: string): Promise<string | null> {
  const headers: Record<string, string> = {}
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  try {
    const r = await fetch('/api/ws/ssh/ticket', { method: 'POST', credentials: 'include', headers })
    if (!r.ok) return null
    const j = (await r.json()) as { ticket?: string }
    return j.ticket || null
  } catch {
    return null
  }
}

export default function WebTerminal({ open, asset, onClose, standalone = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const queryAddonRef = useRef<VimTerminalQueryAddon | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [settings, setSettings] = useState<TermSettings>(() => {
    try {
      const s = JSON.parse(localStorage.getItem('webterm_settings') || '')
      if (s && s.fontSize) return s
    } catch {
      /* noop */
    }
    return { fontSize: 13, fontFamily: 'default', theme: 'default' }
  })
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadTarget, setUploadTarget] = useState<{ file: File; path: string } | null>(null)

  const applySettings = (term: Terminal, s: TermSettings) => {
    term.options.fontSize = s.fontSize
    term.options.fontFamily = familyOf(s.fontFamily)
    term.options.theme = THEMES[s.theme] || THEMES.default
  }

  const updateSetting = (k: keyof TermSettings, v: any) => {
    setSettings((prev) => {
      const next = { ...prev, [k]: v }
      localStorage.setItem('webterm_settings', JSON.stringify(next))
      return next
    })
    const term = termRef.current
    if (!term) return
    if (k === 'fontSize') {
      term.options.fontSize = v as number
      try {
        fitRef.current?.fit()
      } catch {
        /* noop */
      }
    } else if (k === 'fontFamily') {
      term.options.fontFamily = familyOf(v as string)
    } else if (k === 'theme') {
      term.options.theme = THEMES[v as string] || THEMES.default
    }
  }

  useEffect(() => {
    if (!open || !asset) return
    // antd Modal（destroyOnClose）的 children DOM 挂载晚于 useEffect 执行，
    // 必须先等 containerRef 就绪再初始化 xterm，否则 term.open 无从渲染。
    let disposed = false
    let cleanup: (() => void) | undefined

    const init = (container: HTMLDivElement) => {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: settings.fontSize,
        fontFamily: familyOf(settings.fontFamily),
        theme: THEMES[settings.theme] || THEMES.default,
        scrollback: 5000,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      // 加载 vim 查询响应 addon —— 主动回包 cursor pos / DA / DECRQM，
      // 避免 vim 在最老/最小化远端因为终端应答缺失而阻塞等待。
      const queryAddon = new VimTerminalQueryAddon()
      term.loadAddon(queryAddon)
      queryAddonRef.current = queryAddon
      term.open(container)
      termRef.current = term
      fitRef.current = fit

      // 多次 fit 兜底：Modal 打开动画期间容器未完成 layout，fit 会得到 cols=0
      let fitRetries = 0
      const tryFit = () => {
        try {
          fit.fit()
        } catch {
          /* 容器未就绪 */
        }
        if ((term.cols === 0 || term.rows === 0) && fitRetries++ < 40) {
          requestAnimationFrame(tryFit)
        } else if (term.cols > 0 && term.rows > 0) {
          term.writeln('\x1b[36m正在连接服务器（自动登录并切换 root）…\x1b[0m')
        }
      }
      tryFit()

      // 建立 WebSocket（v1.7.1+ 鉴权方式：先拿一次性 ticket，再用 ticket 升级 WS）
      // 兼容期：后端 ALLOW_WS_TOKEN_URL=true 时仍支持 ?token=，但默认走 ticket。
      // 这里把 WebSocket 创建挪到 IIFE：让 init 本身保持同步签名，
      // 等 ticket 拿到后再建 WS；后续 cleanup 通过外层 ws 引用做 null 安全检查。
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
      const wsToken = localStorage.getItem('token') || ''
      let ws: WebSocket | null = null
      ;(async () => {
        try {
          const useTicket = await fetchWsTicket(wsToken)
          const wsUrl = useTicket
            ? `${proto}${location.host}/api/ws/ssh?assetId=${asset.id}&ticket=${encodeURIComponent(useTicket)}`
            : `${proto}${location.host}/api/ws/ssh?assetId=${asset.id}&token=${encodeURIComponent(wsToken)}`
          ws = new WebSocket(wsUrl)
          wsRef.current = ws
          queryAddon.setWebSocket(ws)
          ws.onopen = () => term.focus()
          ws.onmessage = (ev) => {
            const data = typeof ev.data === 'string' ? ev.data : ''
            // 先经过 vim 查询响应 addon —— 拦截 cursor pos / DA 等查询立即回包
            const safe = queryAddon.processIncoming(data)
            term.write(safe)
          }
          ws.onclose = () => {
            term.writeln('')
            term.writeln('\x1b[33m[连接已断开]\x1b[0m')
          }
          ws.onerror = () => {
            term.writeln('')
            term.writeln('\x1b[31m[连接错误，请检查服务器连通性与资产凭证]\x1b[0m')
          }
        } catch (e: any) {
          term.writeln('\x1b[31m[连接失败] 无法获取 WebSocket 鉴权：' + (e?.message || e) + '\x1b[0m')
        }
      })()

      const dataDisposable = term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
      })

      const onResize = () => {
        if (!fitRef.current || !termRef.current) return
        try {
          fitRef.current.fit()
        } catch {
          /* noop */
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }))
        }
      }
      const ro = new ResizeObserver(onResize)
      ro.observe(container)
      window.addEventListener('resize', onResize)
      const t1 = setTimeout(onResize, 300)

      return () => {
        dataDisposable.dispose()
        ro.disconnect()
        window.removeEventListener('resize', onResize)
        clearTimeout(t1)
        if (ws && ws.readyState === WebSocket.OPEN) ws.close()
        wsRef.current = null
        term.dispose()
        queryAddonRef.current = null
        termRef.current = null
        fitRef.current = null
      }
    }

    const waitContainer = () => {
      if (disposed) return
      if (containerRef.current) {
        cleanup = init(containerRef.current)
      } else {
        requestAnimationFrame(waitContainer)
      }
    }
    waitContainer()

    return () => {
      disposed = true
      cleanup?.()
    }
    // 依赖只用 asset?.id：父组件（WebTerminalPage）在窗口 focus / visibilitychange 时会静默
    // 重拉资产展示信息，setAsset 每次都产生「新对象」。若把整个 asset 放进依赖，切屏/重获焦点
    // 就会触发 effect 清理（关 WebSocket + dispose 终端）并重连，表现为「切屏就重连、会话不稳定」。
    // 连接只需要 asset.id 稳定即可，展示用的字段变化不应重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset?.id])

  // standalone（新窗口）模式下，退出快捷键改为 Ctrl+Shift+W。
  // 注意：不能用 ESC —— ESC 是 vim/top/less 等全屏程序的核心按键，
  // 若在此拦截会导致终端内 Esc 失效（表现为 vim 快捷键全用不了）。退出统一用 X 按钮 / 状态栏 / 本快捷键。
  useEffect(() => {
    if (!standalone) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [standalone, onClose])

  const pickFile = () => fileInputRef.current?.click()
  const clearTerm = () => {
    termRef.current?.clear()
    termRef.current?.write('\x1b[2J\x1b[H')
  }
  const copySel = async () => {
    const sel = termRef.current?.getSelection()
    if (sel) await navigator.clipboard.writeText(sel).catch(() => undefined)
  }
  const pasteCli = async () => {
    try {
      const t = await navigator.clipboard.readText()
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN && t) ws.send(t)
    } catch {
      /* noop */
    }
  }

  const openNewWindow = () => {
    if (!asset) return
    const w = openCenteredWindow(
      `/webterm/${asset.id}`,
      '_blank',
      1280,
      860,
      'menubar=no,toolbar=no,location=no,status=no',
    )
    if (!w) {
      const term = termRef.current
      term?.writeln('\r\n\x1b[33m[提示] 浏览器拦截了新窗口，请允许本站弹出窗口后重试\x1b[0m')
    }
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) {
      setUploadProgress(0)
      setUploadTarget({ file: f, path: `/tmp/${f.name}` })
    }
    e.target.value = ''
  }

  // ===== Xshell 风格：菜单栏（平铺 File/Edit/View/Tools/Window/Help） =====
  const xshellMenus = [
    {
      key: 'file',
      label: '文件(F)',
      items: [
        { key: 'new-window', label: '新建连接窗口(N)…', icon: <ExpandOutlined />, onClick: () => openNewWindow() },
        { key: 'upload', label: '上传文件(U)…', icon: <UploadOutlined />, onClick: () => pickFile() },
        { type: 'divider' as const },
        { key: 'exit', label: '退出会话(X)', icon: <PoweroffOutlined />, danger: true, onClick: () => onClose() },
      ],
    },
    {
      key: 'edit',
      label: '编辑(E)',
      items: [
        { key: 'copy', label: '复制(C)  Ctrl+Shift+C', icon: <CopyOutlined />, onClick: () => copySel() },
        { key: 'paste', label: '粘贴(V)  Ctrl+Shift+V', icon: <SnippetsOutlined />, onClick: () => pasteCli() },
        { key: 'select-all', label: '全选(A)  Ctrl+Shift+A', icon: <FileTextOutlined /> },
      ],
    },
    {
      key: 'view',
      label: '视图(V)',
      items: [
        { key: 'clear', label: '清屏(L)  Ctrl+L', icon: <ClearOutlined />, onClick: () => clearTerm() },
        { key: 'reload', label: '重置终端(R)', icon: <ReloadOutlined />, onClick: () => clearTerm() },
      ],
    },
    {
      key: 'tools',
      label: '工具(T)',
      items: [
        {
          key: 'font-size',
          label: `字号：${settings.fontSize}px`,
          icon: <FontSizeOutlined />,
          children: FONT_SIZE_OPTIONS.map((o) => ({
            key: `fs-${o.value}`,
            label: o.label,
            onClick: () => updateSetting('fontSize', o.value),
          })),
        },
        {
          key: 'font-family',
          label: '字体(F)',
          icon: <FontSizeOutlined />,
          children: FONT_FAMILY_OPTIONS.map((o) => ({
            key: `ff-${o.value}`,
            label: o.label,
            onClick: () => updateSetting('fontFamily', o.value),
          })),
        },
        {
          key: 'theme',
          label: '配色方案(C)',
          icon: <BgColorsOutlined />,
          children: THEME_OPTIONS.map((o) => ({
            key: `th-${o.value}`,
            label: o.label,
            onClick: () => updateSetting('theme', o.value),
          })),
        },
      ],
    },
    {
      key: 'window',
      label: '窗口(W)',
      items: [
        { key: 'open-new', label: '在新窗口打开', icon: <ExpandOutlined />, onClick: () => openNewWindow() },
      ],
    },
    {
      key: 'help',
      label: '帮助(H)',
      items: [
        { key: 'about', label: '关于 Web Terminal', icon: <SettingOutlined /> },
      ],
    },
  ]

  const xshellMenuBar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        height: 28,
        background: '#f0f0f0',
        borderBottom: '1px solid #d0d0d0',
        paddingLeft: 4,
        userSelect: 'none',
      }}
    >
      {xshellMenus.map((m) => (
        <Dropdown
          key={m.key}
          menu={{ items: m.items as any }}
          trigger={['click']}
          placement="bottomLeft"
        >
          <div
            style={{
              padding: '0 12px',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              fontSize: 13,
              color: '#222',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#d8e6f7')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {m.label}
          </div>
        </Dropdown>
      ))}
    </div>
  )

  const xshellToolbar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 36,
        background: '#fafafa',
        borderBottom: '1px solid #d0d0d0',
        paddingLeft: 6,
        paddingRight: 6,
        userSelect: 'none',
      }}
    >
      <Button
        size="small"
        type="text"
        icon={<UploadOutlined />}
        onClick={pickFile}
        loading={uploading}
        title="上传文件到 /tmp（U）"
        style={{ color: '#222' }}
      >
        上传
      </Button>
      {!standalone && (
        <Button
          size="small"
          type="text"
          icon={<ExpandOutlined />}
          onClick={openNewWindow}
          title="在新窗口打开"
          style={{ color: '#222' }}
        >
          新窗口
        </Button>
      )}
      <Button
        size="small"
        type="text"
        icon={<CopyOutlined />}
        onClick={copySel}
        title="复制选中内容"
        style={{ color: '#222' }}
      >
        复制
      </Button>
      <Button
        size="small"
        type="text"
        icon={<SnippetsOutlined />}
        onClick={pasteCli}
        title="粘贴剪贴板"
        style={{ color: '#222' }}
      >
        粘贴
      </Button>
      <Button
        size="small"
        type="text"
        icon={<ClearOutlined />}
        onClick={clearTerm}
        title="清屏"
        style={{ color: '#222' }}
      >
        清屏
      </Button>

      <div style={{ width: 1, height: 20, background: '#d0d0d0', margin: '0 4px' }} />

      <span style={{ color: '#555', fontSize: 12, marginRight: 2 }}>字号</span>
      <Select
        size="small"
        style={{ width: 78 }}
        value={settings.fontSize}
        options={FONT_SIZE_OPTIONS}
        onChange={(v) => updateSetting('fontSize', v)}
        getPopupContainer={(t) => t.parentElement || document.body}
        listHeight={220}
        dropdownStyle={{ zIndex: 2100 }}
      />
      <span style={{ color: '#555', fontSize: 12, marginRight: 2, marginLeft: 6 }}>字体</span>
      <Select
        size="small"
        style={{ width: 132 }}
        value={settings.fontFamily}
        options={FONT_FAMILY_OPTIONS}
        onChange={(v) => updateSetting('fontFamily', v)}
        getPopupContainer={(t) => t.parentElement || document.body}
        listHeight={220}
        dropdownStyle={{ zIndex: 2100 }}
      />
      <span style={{ color: '#555', fontSize: 12, marginRight: 2, marginLeft: 6 }}>配色</span>
      <Select
        size="small"
        style={{ width: 128 }}
        value={settings.theme}
        options={THEME_OPTIONS}
        onChange={(v) => updateSetting('theme', v)}
        getPopupContainer={(t) => t.parentElement || document.body}
        listHeight={220}
        dropdownStyle={{ zIndex: 2100 }}
      />

      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onFileChange} />
    </div>
  )

  const xshellPropertyBar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 22,
        background: '#e8e8e8',
        borderBottom: '1px solid #c8c8c8',
        paddingLeft: 8,
        paddingRight: 8,
        fontSize: 11,
        color: '#333',
        userSelect: 'none',
      }}
    >
      <span style={{ color: '#005a9e', fontWeight: 600 }}>Properties</span>
      <span style={{ color: '#888' }}>|</span>
      <span>会话：<b>{assetDisplayName(asset)}</b></span>
      <span style={{ color: '#888' }}>|</span>
      <span>字体：<b>{settings.fontSize}px</b> · <b>{FONT_FAMILY_OPTIONS.find((f) => f.value === settings.fontFamily)?.label}</b></span>
      <span style={{ color: '#888' }}>|</span>
      <span>配色：<b>{THEME_OPTIONS.find((t) => t.value === settings.theme)?.label}</b></span>
      <span style={{ color: '#888' }}>|</span>
      <span style={{ color: '#2e7d32', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <WifiOutlined style={{ fontSize: 11 }} /> Connected · 已自动登录 root
      </span>
    </div>
  )

  const xshellStatusBar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        height: 22,
        background: '#3a8c3a',
        borderTop: '1px solid #2e7d32',
        paddingLeft: 10,
        paddingRight: 10,
        fontSize: 11,
        color: '#ffffff',
        userSelect: 'none',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <WifiOutlined />
        <b>已连接</b>
        <span style={{ opacity: 0.85 }}>· {assetDisplayName(asset)} · SSH 自动登录并切换 root</span>
      </span>
      <span style={{ opacity: 0.85 }}>
        字号 {settings.fontSize}px · {THEME_OPTIONS.find((t) => t.value === settings.theme)?.label} · 右键/X/Ctrl+Shift+W 退出会话
      </span>
    </div>
  )

  const doUpload = async () => {
    if (!uploadTarget || !wsRef.current || uploading) return
    const { file, path } = uploadTarget
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const term = termRef.current
      term?.writeln('\r\n\x1b[33m[提示] SSH 连接尚未建立，无法上传文件，请等待终端就绪后重试\x1b[0m')
      return
    }
    setUploading(true)
    setUploadProgress(0)
    try {
      const total = file.size
      let offset = 0
      while (offset < total) {
        const blob = file.slice(offset, Math.min(offset + UPLOAD_CHUNK, total))
        const dataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => reject(new Error('读取文件失败'))
          r.readAsDataURL(blob)
        })
        const base64 = dataUrl.split(',')[1]
        const done = offset + UPLOAD_CHUNK >= total
        ws.send(JSON.stringify({ type: 'upload', path, data: base64, done }))
        offset += UPLOAD_CHUNK
        const pct = total === 0 ? 100 : Math.min(100, Math.round((offset / total) * 100))
        setUploadProgress(pct)
        await new Promise((r) => setTimeout(r, 8))
      }
      setUploadProgress(100)
      setTimeout(() => setUploadTarget(null), 1000)
    } catch (e: any) {
      const term = termRef.current
      term?.writeln(`\r\n\x1b[31m[上传失败] ${e?.message || e}\x1b[0m`)
    } finally {
      setUploading(false)
    }
  }

  const titleContent = (
    <Space size={8}>
      <MonitorOutlined style={{ color: '#38bdf8' }} />
      <span>
        Web 终端 · <b>{assetDisplayName(asset)}</b>
      </span>
      <Tag color="cyan" icon={<SafetyCertificateOutlined />}>
        已自动登录并切换 root
      </Tag>
    </Space>
  )

  const toolbar = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>终端设置</span>
      <Select
        size="small"
        style={{ width: 74 }}
        value={settings.fontSize}
        options={FONT_SIZE_OPTIONS}
        onChange={(v) => updateSetting('fontSize', v)}
      />
      <Select
        size="small"
        style={{ width: 140 }}
        value={settings.fontFamily}
        options={FONT_FAMILY_OPTIONS}
        onChange={(v) => updateSetting('fontFamily', v)}
      />
      <Select
        size="small"
        style={{ width: 130 }}
        value={settings.theme}
        options={THEME_OPTIONS}
        onChange={(v) => updateSetting('theme', v)}
      />
      <Button size="small" type="primary" ghost icon={<UploadOutlined />} loading={uploading} onClick={pickFile}>
        上传文件
      </Button>
      {!standalone && (
        <Button size="small" icon={<ExpandOutlined />} onClick={openNewWindow}>
          新窗口打开
        </Button>
      )}
      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onFileChange} />
    </div>
  )

  const terminalBox = (
    <div
      ref={containerRef}
      style={{
        height: standalone ? '100%' : 'calc(80vh - 170px)',
        flex: standalone ? 1 : undefined,
        minHeight: standalone ? 0 : 340,
        background: '#0a0f1e',
        borderRadius: standalone ? 0 : 10,
        overflow: 'hidden',
        border: standalone ? 'none' : '1px solid rgba(56,189,248,0.25)',
      }}
    />
  )

  const uploadModal = (
    <Modal
      title="上传文件到服务器"
      open={!!uploadTarget}
      onCancel={() => !uploading && setUploadTarget(null)}
      onOk={doUpload}
      okText={uploading ? `上传中 ${uploadProgress}%` : '开始上传'}
      cancelText="取消"
      okButtonProps={{ disabled: uploading }}
      confirmLoading={uploading}
      maskClosable={false}
      keyboard={true}
      width={460}
    >
      {uploadTarget && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>本地文件</div>
            <Tag color="blue" style={{ fontSize: 13 }}>
              {uploadTarget.file.name}（{(uploadTarget.file.size / 1024).toFixed(1)} KB）
            </Tag>
          </div>
          <div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>目标路径（默认上传到 /tmp 目录，可修改）</div>
            <Input
              value={uploadTarget.path}
              onChange={(e) => setUploadTarget({ ...uploadTarget, path: e.target.value })}
              placeholder="/tmp/filename 或 /data/filename"
              disabled={uploading}
            />
          </div>
          {uploading && (
            <div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>
                上传进度（{((uploadTarget.file.size * uploadProgress) / 100 / 1024).toFixed(1)} / {(uploadTarget.file.size / 1024).toFixed(1)} KB）
              </div>
              <Progress percent={uploadProgress} status="active" strokeColor={{ from: '#38bdf8', to: '#22d3ee' }} />
            </div>
          )}
        </div>
      )}
    </Modal>
  )

  // 兜底 inline 进度条：使用 fixed 定位直接挂在 body，便于截图与无 antd 容器时观察
  const inlineProgress = uploading ? (
    <div
      data-testid="webterm-inline-progress"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        zIndex: 9999,
        background: 'rgba(10,15,30,0.92)',
        border: '1px solid rgba(56,189,248,0.45)',
        borderRadius: 10,
        padding: '10px 14px',
        boxShadow: '0 8px 32px rgba(56,189,248,0.25)',
        minWidth: 260,
      }}
    >
      <div style={{ color: '#7dd3fc', fontSize: 12, marginBottom: 6 }}>文件上传中（{uploadTarget?.file.name}）</div>
      <Progress percent={uploadProgress} status="active" strokeColor={{ from: '#38bdf8', to: '#22d3ee' }} />
    </div>
  ) : null

  // ===== standalone（新窗口）模式：Xshell 风格布局 =====
  if (standalone) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 2000,
        }}
      >
        {/* Xshell 标题栏（深灰） */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 12px',
            background: '#2d2d30',
            color: '#ffffff',
            borderBottom: '1px solid #1f1f21',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500 }}>
            <MonitorOutlined style={{ color: '#7dd3fc' }} />
            <span>Web Terminal — {assetDisplayName(asset)}</span>
            <Tag color="green" style={{ marginLeft: 6, fontSize: 11 }}>
              <SafetyCertificateOutlined style={{ marginRight: 4 }} />
              已自动登录 root
            </Tag>
          </div>
          <Button danger size="small" icon={<CloseOutlined />} onClick={onClose}>
            退出会话
          </Button>
        </div>

        {/* Xshell 工具栏（白底） */}
        {xshellToolbar}

        {/* Xshell 属性条（Properties） */}
        {xshellPropertyBar}

        {/* 终端区 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: 6,
            background: '#ffffff',
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: '100%',
              height: '100%',
              background: '#0a0f1e',
              borderRadius: 4,
              border: '1px solid #c8c8c8',
              overflow: 'hidden',
            }}
          />
        </div>

        {/* Xshell 状态栏（绿底） */}
        {xshellStatusBar}

        {uploadModal}
        {inlineProgress}
      </div>
    )
  }

  // ===== 普通 Modal 模式 =====
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="80vw"
      style={{ top: 24, maxWidth: 1200 }}
      destroyOnClose
      closable={true}
      maskClosable={false}
      keyboard={false}
      closeIcon={<CloseOutlined style={{ color: 'var(--text-secondary)', fontSize: 18 }} />}
      title={titleContent}
    >
      {toolbar}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message="终端内直接操作目标服务器；点击右上角 X 断开连接，点击遮罩不会关闭（ESC 已保留给 vim/top/less 等程序）。"
      />
      {terminalBox}
      {uploadModal}
    </Modal>
  )
}
