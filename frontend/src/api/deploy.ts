import api from './client'

// 部署模式定义（如 Redis 单机 / 三主三从集群 / 哨兵）
export interface DeployModeDef {
  key: string
  label: string
  topology: 'single' | 'cluster' | 'roles'
  nodeCount?: number
  replicas?: number
  roles?: string[]
}

// 部署执行方式：与控制节点上既有 ansible 脚本形态对应
// copy = 上传包+脚本执行 | unarchive = 解压后执行包内脚本 | dir = 下发整个 files 目录 | playbook = 执行既有 yml
export type DeployStyle = 'copy' | 'unarchive' | 'dir' | 'playbook'

export const STYLE_LABELS: Record<DeployStyle, string> = {
  copy: '上传包 + 脚本执行',
  unarchive: '解压后执行包内脚本',
  dir: '下发整个目录后执行',
  playbook: '执行既有 playbook',
}

// 部署向导用：中间件目录项（来自 /deploy/catalog，仅已启用）
export interface MiddlewareDef {
  type: string
  label: string
  icon: string
  category?: string
  subDir: string
  style?: DeployStyle
  playbook?: string
  installPath?: string
  defaultPort?: string
  certDir?: string // 证书下发目录（目标机绝对路径）
  ready: boolean
  hasCert: boolean
  needCert: boolean
  versions: string[]
  modes: DeployModeDef[]
  packages: PkgMatrixItem[]
}

export interface DeployCatalog {
  middlewares: MiddlewareDef[]
  deployBase: string
}

// 部署配置管理用：中间件完整记录（来自 /deploy/middlewares）
export interface DeployMiddleware {
  id: number
  name: string
  label: string
  icon: string
  description: string
  category?: string
  versions: string // JSON []string
  packages: string // JSON map[osType_cpuType]PkgInfo
  modes: string // JSON []DeployModeDef
  subDir?: string
  style?: DeployStyle
  playbook?: string
  installPath?: string
  defaultPort?: string
  certDir?: string // 证书下发目录（目标机绝对路径）
  needCert: boolean
  ready: boolean
  enabled: boolean
  seedVer?: number
  createdAt: string
  updatedAt: string
}

// 离线包矩阵中的一项（osType/cpuType 支持 any 通配，zones 为空表示所有区域通用）
export interface PkgMatrixItem {
  osType: string
  cpuType: string
  pkg: string
  script: string
  target: string
  zones?: string[]
}

// 单条离线包配置
export interface PkgInfo {
  pkg: string
  script: string
  target: string
  zones?: string[]
}

// 网络区域（与 Ansible 控制节点「所属网络区域」一致）
export const NETWORK_ZONES = ['互联网', '政务外网']

// 目标识别结果
export interface DeployTarget {
  id: number
  name: string
  ip: string
  osRaw: string
  cpuRaw: string
  osType: string
  cpuType: string
  networkZone: string // 资产「所属网络区域」，用于自动分配执行节点
  supported: boolean
  reason: string
  hasCertField: boolean
}

// Ansible 控制节点（执行节点）
export interface RemoteNode {
  id: number
  name: string
  host: string
  networkZone: string // 绑定的网络区域（如 互联网/政务外网）
  status?: string
  description?: string
}

// 证书
export interface DeployCert {
  id: number
  name: string
  domain: string
  sans?: string // 备用域名（SAN，逗号分隔）
  project?: string // 关联项目/用途
  issuer?: string // 签发者（CA）
  serialNumber?: string // 序列号
  algorithm?: string // 算法 RSA/ECC
  commonName?: string // 主体 CN
  notBefore?: string // 生效时间
  notAfter?: string // 到期时间
  daysLeft?: number // 剩余天数（负数=已过期）
  status?: 'valid' | 'expiring' | 'expired' | 'unknown' // 到期状态
  remark: string
  caContent?: string
  crtContent?: string
  keyContent?: string
  hasCrt: boolean
  hasKey: boolean
  hasCa: boolean
  createdAt: string
  updatedAt?: string
}

// 证书到期汇总
export interface CertSummary {
  counts: {
    total: number
    valid: number
    expiring: number
    expired: number
    unknown: number
  }
  expiring: Array<{
    id: number
    name: string
    domain: string
    project: string
    notAfter: string
    daysLeft: number
    status: string
  }>
}

// 部署任务
export interface DeployJob {
  id: number
  middleware: string
  version: string
  mode: string
  topology: string
  remoteId: number
  hasCert: boolean
  certId?: number
  certName: string
  env: string
  businessEnv: string
  extraMw: string
  mwItems?: string
  targets: string
  status: string // pending/running/success/failed
  output: string
  errorMsg: string
  createdBy: number
  createdAt: string
  finishedAt?: string
}

export function getDeployCatalog(): Promise<DeployCatalog> {
  return api.get('/deploy/catalog').then((r) => r.data.data as DeployCatalog)
}

export function detectTargets(assetIds: number[], middleware: string): Promise<DeployTarget[]> {
  return api
    .post('/deploy/detect', { assetIds, middleware })
    .then((r) => (r.data.data?.targets as DeployTarget[]) || [])
}

// 中间件部署配置（页面管理）
export function listDeployMiddlewares(): Promise<DeployMiddleware[]> {
  return api.get('/deploy/middlewares').then((r) => (r.data.data?.list as DeployMiddleware[]) || [])
}

export function getDeployMiddleware(id: number): Promise<DeployMiddleware> {
  return api.get(`/deploy/middlewares/${id}`).then((r) => r.data.data as DeployMiddleware)
}

export function createDeployMiddleware(payload: Partial<DeployMiddleware>): Promise<DeployMiddleware> {
  return api.post('/deploy/middlewares', payload).then((r) => r.data.data as DeployMiddleware)
}

export function updateDeployMiddleware(
  id: number,
  payload: Partial<DeployMiddleware>
): Promise<DeployMiddleware> {
  return api.put(`/deploy/middlewares/${id}`, payload).then((r) => r.data.data as DeployMiddleware)
}

export function deleteDeployMiddleware(id: number): Promise<void> {
  return api.delete(`/deploy/middlewares/${id}`)
}

export function listDeployCerts(): Promise<DeployCert[]> {
  return api.get('/deploy/certs').then((r) => (r.data.data?.certs as DeployCert[]) || [])
}

export function getDeployCert(id: number): Promise<DeployCert> {
  return api.get(`/deploy/certs/${id}`).then((r) => r.data.data as DeployCert)
}

export function createDeployCert(payload: {
  name: string
  domain?: string
  sans?: string
  project?: string
  crtContent: string
  keyContent: string
  caContent?: string
  remark?: string
}): Promise<{ id: number }> {
  return api.post('/deploy/certs', payload).then((r) => r.data.data as { id: number })
}

export function updateDeployCert(
  id: number,
  payload: {
    name?: string
    domain?: string
    sans?: string
    project?: string
    crtContent?: string
    keyContent?: string
    caContent?: string
    remark?: string
  },
): Promise<{ id: number }> {
  return api.put(`/deploy/certs/${id}`, payload).then((r) => r.data.data as { id: number })
}

export function certSummary(): Promise<CertSummary> {
  return api.get('/deploy/certs/summary').then((r) => r.data.data as CertSummary)
}

// 上传证书文件（CRT 必填，KEY/CA 可选），自动解析 CRT 元数据。
// 若提供 id 或 name 命中已有证书则更新，否则新建。formData 由调用方用 FormData 构造。
export function uploadDeployCert(formData: FormData): Promise<{ id: number; created: boolean }> {
  return api
    .post('/deploy/certs/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data.data as { id: number; created: boolean })
}

export function deleteDeployCert(id: number): Promise<void> {
  return api.delete(`/deploy/certs/${id}`)
}

// 每个中间件各自的配置（多选时逐项下发）
export interface DeployMwItem {
  middleware: string
  version: string
  mode?: string
  // 逐项证书：每个中间件可各用一张证书（平台只把证书下发到目标机，SSL 由脚本配置）
  hasCert?: boolean
  certId?: number
  certName?: string
}

export function deployRun(payload: {
  middleware: string
  version: string
  mode?: string
  topology?: Record<number, string>
  hasCert: boolean
  certId?: number
  certName?: string
  env?: string
  businessEnv?: string
  assetIds: number[]
  /** 手动输入的目标（不走资产管理）；与 assetIds 合并执行，按相同 SSH/槽位链路下发 */
  manualTargets?: ManualTargetPayload[]
  /** 手动目标的角色映射（IP -> role），roles 模式必填 */
  manualTopology?: Record<string, string>
  extraMw: string[]
  items?: DeployMwItem[]
  inventoryMode?: 'platform' | 'group' // Ansible 接入方式：platform(默认)/group(复用 Jenkins 组)
}): Promise<{ jobId: number; unsupported: string[] }> {
  return api.post('/deploy/run', payload).then((r) => r.data.data)
}

/** 手动输入的目标载荷（与后端 deployTargetRow 对齐：IP/OS/CPU/zone/凭据；id 忽略） */
export interface ManualTargetPayload {
  id?: number
  name?: string
  ip: string
  osType: string
  cpuType: string
  port?: string
  user: string
  pass: string
  become?: string
  becomePass: string
  zone: string
}

export function getDeployJob(id: number): Promise<DeployJob> {
  return api.get(`/deploy/jobs/${id}`).then((r) => r.data.data as DeployJob)
}

/** 部署执行记录列表（分页 + 过滤） */
export function listDeployJobs(params: {
  page?: number
  size?: number
  middleware?: string
  status?: string
} = {}): Promise<{ list: DeployJob[]; total: number; page: number; size: number }> {
  const qs = new URLSearchParams()
  if (params.page) qs.set('page', String(params.page))
  if (params.size) qs.set('size', String(params.size))
  if (params.middleware) qs.set('middleware', params.middleware)
  if (params.status) qs.set('status', params.status)
  const q = qs.toString()
  return api.get(`/deploy/jobs${q ? `?${q}` : ''}`).then((r) => r.data.data)
}

/** 从已有执行记录一键重跑，返回新任务 ID */
export function rerunDeployJob(id: number): Promise<{ jobId: number }> {
  return api.post(`/deploy/jobs/${id}/rerun`).then((r) => r.data.data)
}

/** 用户列表（用于把执行记录的 createdBy 映射成昵称/用户名） */
export interface SimpleUser {
  id: number
  username: string
  nickname?: string
}
export function listUsers(): Promise<SimpleUser[]> {
  return api.get('/users').then((r) => (r.data.data as { list: SimpleUser[] }).list)
}

// ---------- 系统初始化 ----------
export interface SysInitTaskOption {
  key: string
  label?: string
  group?: string // 向导分组（基础配置 / 系统优化 / GaussDB 安装 / …；空归入「其他」）
  domain?: string // 目录域：空=系统初始化；gaussdb=GaussDB（独立目录 gaussDB_init）
  desc: string
  playbook?: string // 相对所属域根目录的 playbook 路径
  varMode?: 'os' | 'cpu' | 'static' | 'none'
  varArgs?: string // varMode=static 时的固定变量
  custom?: boolean // 页面自定义添加
  osTypes?: string[] // 支持的 OS 令牌（空=全部）
  cpuTypes?: string[] // 支持的 CPU 令牌（空=全部）
}
export interface SysInitOptions {
  tasks: SysInitTaskOption[]
  osTypes: string[]
  cpuTypes: string[]
  systemInitDir: string
  gaussdbInitDir?: string
}
export interface SysInitJob {
  id: number
  tasks: string[] | string
  targets: any
  osType: string
  cpuType: string
  status: 'pending' | 'running' | 'success' | 'failed'
  output: string
  errorMsg: string
  createdAt: string
  finishedAt?: string | null
}

export function sysinitOptions(): Promise<SysInitOptions> {
  return api.get('/deploy/sysinit/options').then((r) => r.data.data as SysInitOptions)
}

export function createSysInit(payload: {
  tasks: string[]
  assetIds: number[]
  /** 手动输入的目标（不走资产管理）；与 assetIds 合并执行 */
  manualTargets?: ManualTargetPayload[]
  // OS/CPU 不再由前端手选：留空时由后端按「资产优先 → 后台探测」自动识别
  osType?: string
  cpuType?: string
  inventoryMode?: 'platform' | 'group' // Ansible 接入方式：platform(默认)/group(复用 Jenkins 组)
}): Promise<{ id: number; unsupported: string[] }> {
  return api.post('/deploy/sysinit', payload).then((r) => r.data.data)
}

// 系统初始化环境自动识别结果（资产优先 → 后台探测）
export interface SysInitEnvTarget {
  id: number
  name: string
  ip: string
  zone: string
  osType: string
  cpuType: string
  osSource: 'asset' | 'detected' | 'unknown'
  cpuSource: 'asset' | 'detected' | 'unknown'
}
export interface SysInitEnvZone {
  zone: string
  osType: string
  cpuType: string
  osSource: 'asset' | 'detected' | 'unknown'
  cpuSource: 'asset' | 'detected' | 'unknown'
  error?: string
}

// 探测系统初始化所需的 OS_TYPE/CPU_TYPE：优先取资产管理字段，缺失时由后端 SSH 探测。
// 供「系统初始化」独立页与部署向导第一步展示，无需用户手选。
export function detectSysInitEnv(
  assetIds: number[],
): Promise<{ targets: SysInitEnvTarget[]; zones: SysInitEnvZone[]; unsupported: string[] }> {
  return api.post('/deploy/sysinit/detect', { assetIds }).then((r) => r.data.data)
}

export function getSysInitJob(id: number): Promise<SysInitJob> {
  return api.get(`/deploy/sysinit/${id}`).then((r) => r.data.data as SysInitJob)
}

export function listSysInitJobs(): Promise<SysInitJob[]> {
  return api.get('/deploy/sysinit').then((r) => r.data.data as SysInitJob[])
}

// ---------- 系统初始化管理（目录可自定义） ----------
export interface SysInitCatalogItem {
  id: number
  key: string
  label: string
  group: string
  domain: string // 目录域：空=系统初始化；gaussdb=GaussDB
  playbook: string
  desc: string
  varMode: 'os' | 'cpu' | 'static' | 'none'
  varArgs: string
  osTypes: string[]
  cpuTypes: string[]
  orderNo: number
  enabled: boolean
  custom: boolean
  deleted: boolean
  seedVer: number
  updatedAt: string
}

export interface SysInitCatalogList {
  list: SysInitCatalogItem[]
  groups: string[]
  osTypes: string[]
  cpuTypes: string[]
  systemInitDir: string
  gaussdbInitDir: string
  seedVer: number
}

export interface SysInitCatalogPayload {
  key: string
  label: string
  group: string
  domain?: string // 目录域：空=系统初始化；gaussdb=GaussDB（省略=保持原值）
  playbook: string
  desc: string
  varMode: 'os' | 'cpu' | 'static' | 'none'
  varArgs: string
  osTypes: string[]
  cpuTypes: string[]
  orderNo: number
  enabled: boolean
}

export function listSysInitCatalog(): Promise<SysInitCatalogList> {
  return api.get('/deploy/sysinit/catalog').then((r) => r.data.data as SysInitCatalogList)
}

export function createSysInitCatalog(p: SysInitCatalogPayload): Promise<SysInitCatalogItem> {
  return api.post('/deploy/sysinit/catalog', p).then((r) => r.data.data as SysInitCatalogItem)
}

export function updateSysInitCatalog(id: number, p: SysInitCatalogPayload): Promise<SysInitCatalogItem> {
  return api.put(`/deploy/sysinit/catalog/${id}`, p).then((r) => r.data.data as SysInitCatalogItem)
}

export function deleteSysInitCatalog(id: number): Promise<{ deleted: string; key: string }> {
  return api.delete(`/deploy/sysinit/catalog/${id}`).then((r) => r.data.data)
}

export function toggleSysInitCatalog(id: number, enabled: boolean): Promise<SysInitCatalogItem> {
  return api.patch(`/deploy/sysinit/catalog/${id}/enabled`, { enabled }).then((r) => r.data.data as SysInitCatalogItem)
}

// 重新同步内置目录；restore=true 时顺带清除「删除墓碑」恢复被删的内置项
export function syncSysInitCatalog(restore = false): Promise<{ restored: number; total: number; enabled: number }> {
  return api.post('/deploy/sysinit/catalog/sync', { restore }).then((r) => r.data.data)
}

// 列出控制节点指定目录域根目录下的全部 playbook（相对路径）
// domain：''=系统初始化（system_init）；'gaussdb'=GaussDB（gaussDB_init）
export function listSysInitPlaybooks(
  domain = '',
): Promise<{ dir: string; domain: string; node: string; files: string[]; count: number }> {
  return api.get('/deploy/sysinit/catalog/playbooks', { params: { domain } }).then((r) => r.data.data)
}

// 校验 playbook 在控制节点上是否存在，并取回头部内容预览（domain 决定拼哪个域的根目录）
export function checkSysInitPlaybook(
  playbook: string,
  domain = '',
  lines = 60,
): Promise<{ playbook: string; fullPath: string; domain: string; exists: boolean; node: string; head: string }> {
  return api.post('/deploy/sysinit/catalog/check', { playbook, domain, lines }).then((r) => r.data.data)
}
