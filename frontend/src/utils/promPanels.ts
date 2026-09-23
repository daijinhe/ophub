/**
 * 监控大屏「内容控制」面板清单（v1.7.41；v1.7.42 拆细负载 TOP）
 *
 * 背景：大屏版面是**固定格数**的（v1.7.42 拆细后：左 7 / 中 8 / 右 4 / 底 1 = 20 个开关），
 * 但不同项目想盯的东西不一样 ——
 * 有人不想把「项目/部门」暴露给参观者，有人只关心磁盘，有人干脆只想投一屏告警。
 * 所以把每个面板做成开关，关掉后面板不渲染、同一栏里其余面板自动接管它的高度。
 *
 * v1.7.42：原来四个负载榜共用一个 `topN` 组开关，现在拆成 topCpu / topMem / topDisk / topNet
 * 四个独立开关（同属 `group: 'top'`）—— 想只投「CPU 榜 + 磁盘榜」，或者干脆关掉网络榜，都能做到。
 *
 * ⚠️ 与后端 `handler_prom_screen.go` 的 `promPanelKeys` **必须一一对应**（键名一个字都不能差）：
 * 后端存配置时会用白名单清洗，键名对不上会被静默丢弃，表现为「开关点了没反应」。
 *
 * 语义（前后端一致）：**表里没有的键 = 展示**。这样历史库（根本没有 panels 字段）升级后
 * 行为完全不变；保存时也只写 `false` 的键，配置 JSON 不会随手点几下就膨胀。
 */

export type PromPanelCol = 'left' | 'mid' | 'right' | 'footer'

export type PromPanelKey =
  // 左栏
  | 'capacity'
  | 'kpiTarget'
  | 'kpiOnline'
  | 'kpiIssue'
  | 'kpiDisk'
  | 'kpiProject'
  | 'osDist'
  // 中栏（topCpu / topMem / topDisk / topNet 同属 group: 'top'）
  | 'gauges'
  | 'topCpu'
  | 'topMem'
  | 'topDisk'
  | 'topNet'
  | 'hostBars'
  | 'healthDist'
  | 'trend'
  // 右栏
  | 'alerts'
  | 'alertLevel'
  | 'alertTrend'
  | 'hostScroll'
  // 底部
  | 'footer'

/** 面板分组：目前只有「负载 TOP N」有组概念（管理页会多渲染一层组开关 + 说明） */
export type PromPanelGroup = 'top'

export interface PromPanelDef {
  key: PromPanelKey
  label: string
  col: PromPanelCol
  desc: string
  group?: PromPanelGroup
}

/** 四个负载榜的键（顺序 = 大屏上从左到右） */
export const PROM_TOP_PANEL_KEYS: PromPanelKey[] = ['topCpu', 'topMem', 'topDisk', 'topNet']

/**
 * v1.7.41 遗留的组开关（一个键管四个榜）。v1.7.42 拆细后它只剩**读兼容**作用：
 * 后端加载配置时已经把 `topN:false` 展开成 4 个键并删掉它；这里再兜一层，
 * 是为了「大屏读到的 config 还没走过迁移」的窗口期（例如重启恢复出来的旧快照 config）
 * 不会让用户明明关掉的榜自己冒出来。
 */
const LEGACY_TOP_KEY = 'topN'

/** 面板定义（顺序 = 大屏上从上到下的实际顺序，管理页按同一顺序罗列，便于「对着屏勾」） */
export const PROM_PANELS: PromPanelDef[] = [
  // ---- 左栏：集群总览 ----
  { key: 'capacity', label: '容量总览', col: 'left', desc: 'CPU 核数 / 内存 / 存储 三格容量卡' },
  { key: 'kpiTarget', label: '监控目标 / 主机', col: 'left', desc: 'Prometheus 目标数 与 实际采到资源的主机数' },
  { key: 'kpiOnline', label: '目标在线 / 离线', col: 'left', desc: '在线率与离线台数，含「未采集到资源」的差集' },
  { key: 'kpiIssue', label: '告警项 / 主机', col: 'left', desc: '超阈值项数与涉及主机数（严重 / 关注分列）', },
  { key: 'kpiDisk', label: '磁盘告警', col: 'left', desc: '磁盘维度的预警 / 严重项数（不受清单截断影响）' },
  { key: 'kpiProject', label: '项目 / 部门', col: 'left', desc: '按 target 标签去重的项目数与部门数' },
  { key: 'osDist', label: '操作系统分布', col: 'left', desc: '环形图 + 图例，展示各发行版台数' },

  // ---- 中栏：资源详情 ----
  { key: 'gauges', label: '资源平均使用率', col: 'mid', desc: 'CPU / 内存 / 磁盘 / 网络 四个平均值仪表' },
  // 负载 TOP N（group: 'top'）：四个榜可单独开关；内容还会被「风险与屏蔽」的规则按指标过滤
  { key: 'topCpu', label: 'CPU 负载 TOP N', col: 'mid', group: 'top', desc: 'CPU 使用率最高的若干台主机' },
  { key: 'topMem', label: '内存负载 TOP N', col: 'mid', group: 'top', desc: '内存使用率最高的若干台主机' },
  { key: 'topDisk', label: '磁盘负载 TOP N', col: 'mid', group: 'top', desc: '磁盘使用率最高的若干台主机' },
  { key: 'topNet', label: '网络负载 TOP N', col: 'mid', group: 'top', desc: '网络使用率最高的若干台主机（按参考带宽折算）' },
  { key: 'hostBars', label: '各主机实时使用率', col: 'mid', desc: '逐主机堆叠柱状图（与「资源健康分布」并排）' },
  { key: 'healthDist', label: '资源健康分布', col: 'mid', desc: '低 / 中 / 高 / 严重 / 无数据 五档占比（与柱状图并排）' },
  { key: 'trend', label: '资源使用率趋势', col: 'mid', desc: '近 N 小时 CPU / 内存 / 磁盘 走势曲线' },

  // ---- 右栏：告警区 ----
  { key: 'alerts', label: '实时告警列表', col: 'right', desc: '按大屏阈值自算的超阈值明细，自动滚动' },
  { key: 'alertLevel', label: '告警等级分布', col: 'right', desc: '严重 / 关注 占比环形图（与「告警趋势」并排）' },
  { key: 'alertTrend', label: '告警趋势', col: 'right', desc: '告警项数按小时走势（与「告警等级」并排）' },
  { key: 'hostScroll', label: '主机实时资源', col: 'right', desc: '逐主机 CPU / 内存 / 磁盘 / 网络 细条 + 在线状态' },

  // ---- 底部 ----
  { key: 'footer', label: '页脚采集信息', col: 'footer', desc: '采集频率 / 采集时间 / 耗时 / 数据源 / 监控目标 / 超阈值' },
]

/** 栏目中文名（管理页分组标题、大屏空栏提示共用） */
export const PROM_PANEL_COL_CN: Record<PromPanelCol, string> = {
  left: '左栏 · 集群总览',
  mid: '中栏 · 资源详情',
  right: '右栏 · 告警区',
  footer: '底部 · 页脚',
}

/** 某栏下全部面板（保持 PROM_PANELS 顺序） */
export function promPanelsOfCol(col: PromPanelCol): PromPanelDef[] {
  return PROM_PANELS.filter((p) => p.col === col)
}

/** 某分组下全部面板（管理页的「组开关：全开 / 全关」用它） */
export function promPanelsOfGroup(group: PromPanelGroup): PromPanelDef[] {
  return PROM_PANELS.filter((p) => p.group === group)
}

/** 分组中文名（管理页组开关带标题用） */
export const PROM_PANEL_GROUP_CN: Record<PromPanelGroup, string> = {
  top: '负载 TOP N · 四个榜可单独开关',
}

/**
 * 大屏判断单个面板是否展示（缺省 = 展示）。
 *
 * 判定顺序：先看自己的键，再看 v1.7.41 遗留的组开关（关掉 topN = 四个榜一起关）。
 * 大屏与管理页都用它，**不要各写一份** —— 否则会出现「管理页显示关着、大屏还在渲染」。
 */
export function promPanelOn(panels: Record<string, boolean> | undefined | null, key: PromPanelKey): boolean {
  if (panels?.[key] === false) return false
  if (panels?.[LEGACY_TOP_KEY] === false && PROM_TOP_PANEL_KEYS.includes(key)) return false
  return true
}

/**
 * 把「部分开关」补成「全量开关」——缺省 = 展示。
 * 管理页的 Switch 列表要用它（否则没存过的面板拿不到值，Switch 会显示成关）。
 * 内部直接复用 promPanelOn，保证「列表显示的开关状态」与「大屏实际渲染」永远一致。
 */
export function promPanelsFill(panels?: Record<string, boolean> | null): Record<PromPanelKey, boolean> {
  const out = {} as Record<PromPanelKey, boolean>
  for (const p of PROM_PANELS) out[p.key] = promPanelOn(panels, p.key)
  return out
}

/**
 * 按「可见面板」拼 CSS grid-template-rows。
 *
 * 解决的是关掉面板后**留一片空白**的问题：把最后一个可见行撑成 `1fr` 吃掉剩余高度
 * （`h: 'FR'` 表示这一行本来就想占满）。
 *
 * ⚠️ 关掉面板只影响「行」的构成，**不改剩余行的像素高度** —— 除最后一行外，
 * 其余行保持设计稿的固定高，避免「关掉一个 KPI 卡，其它卡全被拉高变形」。
 */
export function promRowsCss(rows: { on: boolean; h: string }[]): string {
  const vis = rows.filter((r) => r.on)
  if (vis.length === 0) return '1fr'
  const hs = vis.map((r) => r.h)
  if (!hs.includes('FR')) hs[hs.length - 1] = '1fr'
  return hs.map((h) => (h === 'FR' ? '1fr' : h)).join(' ')
}

/** 某栏是否至少有一个面板可见（用于整栏隐藏 / 页面栅格重排） */
export function promColOn(panels: Record<string, boolean> | undefined | null, col: PromPanelCol): boolean {
  return promPanelsOfCol(col).some((p) => promPanelOn(panels, p.key))
}
