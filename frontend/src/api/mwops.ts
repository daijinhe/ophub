import api from './client'

// ============================================================================
// 中间件管控（mwops）—— 部署落地之后的日常运维
//   · 实例 = 某台机器上的一个中间件（nginx / jdk / php / bws310 / redis）
//   · 能力 = 进程是否存活、启停重启重载、按 PID 结束进程、配置文件在线管理
// 数据来源：从「部署执行记录」同步，或页面手动纳管。
// ============================================================================

/** 类型能力档案（按类型共享） */
export interface MwOpsProfile {
  type: string
  label: string
  icon: string
  category: string
  /** pgrep -f 匹配串 */
  processPattern: string
  /** systemd 单元名候选 */
  units: string[]
  /** 常见安装路径（自动发现用） */
  defaultPaths: string[]
  defaultPort: string
  /** 配置文件候选，支持 {path} 占位与尾部 * 通配 */
  configPaths: string[]
  /** 保存后的配置校验命令（如 nginx -t） */
  configTestCmd: string
  versionCmd: string
  cmdStart: string
  cmdStop: string
  cmdRestart: string
  cmdReload: string
  /** 以进程为管理对象（jdk），无单体服务 */
  processOnly: boolean
  desc: string
  enabled: boolean
  instanceCount: number
}

/** 实例运行状态 */
export type MwOpsStatus = 'running' | 'stopped' | 'unknown'

/** 一个中间件实例 */
export interface MwInstance {
  id: number
  mwType: string
  version: string
  assetId: number
  assetName: string
  host: string
  zone: string
  port: string
  installPath: string
  /** 以下为「覆盖类型档案」的字段，空表示继承 */
  processPattern: string
  unit: string
  cmdStart: string
  cmdStop: string
  cmdRestart: string
  cmdReload: string
  /** JSON 字符串（[]string） */
  configPaths: string
  source: 'deploy' | 'manual'
  deployJobId: number
  status: MwOpsStatus
  statusText: string
  lastCheckAt?: string | null
  lastOutput: string
  lastError: string
  remark: string
  enabled: boolean
  /** 连接信息：非机密字段由后端返回，便于编辑时回填；
   *  密码类（sshPass / adminPass）后端不返回，编辑时留空即保持原值 */
  sshPort: string
  sshUser: string
  adminUser: string
  createdAt: string
  updatedAt: string
}

export interface MwOpsProc {
  pid: number
  user: string
  elapsed: string
  cpu: string
  mem: string
  args: string
}

export interface MwOpsPort {
  addr: string
  port: string
  pid: number
  proc: string
}

export interface MwOpsUnit {
  name: string
  state: string
}

/** 一次状态探测的明细 */
export interface MwOpsProbe {
  pids: number[]
  procs: MwOpsProc[]
  units: MwOpsUnit[]
  systemd: boolean
  ports: MwOpsPort[]
  dirs: string[]
  verRaw: string
  raw: string
  via: string
}

/** 一个可纳管的配置文件 */
export interface MwOpsConfigFile {
  path: string
  exists: boolean
  size: number
  md5: string
  mtime: string
  /** 存在 *.ophub.bak 备份，可回滚 */
  backup: boolean
}

export interface MwOpsInstanceStats {
  total: number
  running: number
  stopped: number
  unknown: number
  enabled: number
}

/** 新建 / 编辑实例入参（编辑时密码留空 = 保持原值） */
export interface MwOpsInstancePayload {
  mwType: string
  version?: string
  assetId?: number
  host?: string
  zone?: string
  port?: string
  installPath?: string
  processPattern?: string
  unit?: string
  cmdStart?: string
  cmdStop?: string
  cmdRestart?: string
  cmdReload?: string
  configPaths?: string[]
  sshPort?: string
  sshUser?: string
  sshPass?: string
  adminUser?: string
  adminPass?: string
  remark?: string
  enabled?: boolean
}

// ---------------- 类型档案 ----------------

export function listMwOpsProfiles(): Promise<{ list: MwOpsProfile[] }> {
  return api.get('/mwops/profiles').then((r) => r.data.data)
}

export function updateMwOpsProfile(type: string, payload: Partial<MwOpsProfile>): Promise<{ type: string }> {
  return api.put(`/mwops/profiles/${encodeURIComponent(type)}`, payload).then((r) => r.data.data)
}

// ---------------- 实例 ----------------

export function listMwOpsInstances(params: {
  mwType?: string
  status?: string
  keyword?: string
}): Promise<{ list: MwInstance[]; stats: MwOpsInstanceStats; byType: Record<string, number> }> {
  return api.get('/mwops/instances', { params }).then((r) => r.data.data)
}

export function createMwOpsInstance(payload: MwOpsInstancePayload): Promise<MwInstance> {
  return api.post('/mwops/instances', payload).then((r) => r.data.data)
}

export function updateMwOpsInstance(id: number, payload: MwOpsInstancePayload): Promise<MwInstance> {
  return api.put(`/mwops/instances/${id}`, payload).then((r) => r.data.data)
}

export function deleteMwOpsInstance(id: number): Promise<{ deleted: boolean }> {
  return api.delete(`/mwops/instances/${id}`).then((r) => r.data.data)
}

/** 从部署执行记录同步实例（幂等） */
export function syncMwOpsFromDeploy(): Promise<{
  created: number
  updated: number
  skipped: number
  failed: number
  jobCount: number
  notes: string[]
}> {
  return api.post('/mwops/instances/sync-deploy').then((r) => r.data.data)
}

// ---------------- 检测 / 动作 ----------------

export function checkMwOpsInstance(id: number): Promise<{
  instance: MwInstance
  probe: MwOpsProbe | null
  ok: boolean
  error?: string
}> {
  return api.post(`/mwops/instances/${id}/check`, {}, { timeout: 180000 }).then((r) => r.data.data)
}

/** 批量检测：ids 省略时检测全部启用实例 */
export function checkMwOpsBatch(ids?: number[]): Promise<{
  checked: number
  running: number
  stopped: number
  failed: number
  failures: string[]
}> {
  return api
    .post('/mwops/instances/check-batch', ids && ids.length ? { ids } : { all: true }, { timeout: 600000 })
    .then((r) => r.data.data)
}

export function mwOpsAction(
  id: number,
  action: 'start' | 'stop' | 'restart' | 'reload',
  confirm = false,
): Promise<{
  ok: boolean
  action: string
  cmd: string
  via: string
  output: string
  instance: MwInstance
  probe: MwOpsProbe | null
}> {
  return api
    .post(`/mwops/instances/${id}/action`, { action, confirm }, { timeout: 300000 })
    .then((r) => r.data.data)
}

export function mwOpsKillProcess(
  id: number,
  pid: number,
  signal: '15' | '9' = '15',
): Promise<{ ok: boolean; pid: number; output: string; instance: MwInstance }> {
  return api.post(`/mwops/instances/${id}/kill`, { pid, signal }, { timeout: 180000 }).then((r) => r.data.data)
}

// ---------------- 配置管理 ----------------

export function listMwOpsConfigs(id: number): Promise<{
  list: MwOpsConfigFile[]
  candidates: string[]
  testCmd: string
  reloadCmd: string
  processOnly: boolean
  installPath: string
}> {
  return api.get(`/mwops/instances/${id}/configs`, { timeout: 180000 }).then((r) => r.data.data)
}

export function getMwOpsConfig(
  id: number,
  path: string,
): Promise<{ path: string; content: string; md5: string; size: number; testCmd: string; reloadCmd: string }> {
  return api
    .get(`/mwops/instances/${id}/config`, { params: { path }, timeout: 180000 })
    .then((r) => r.data.data)
}

export function saveMwOpsConfig(
  id: number,
  payload: { path: string; content: string; test?: boolean; reload?: boolean },
): Promise<{
  saved: boolean
  path: string
  valid?: boolean
  validateOutput?: string
  reloaded?: boolean
  reloadCmd?: string
  reloadOutput?: string
  reloadError?: string
  files?: MwOpsConfigFile[]
  instance?: MwInstance
}> {
  return api.post(`/mwops/instances/${id}/config`, payload, { timeout: 300000 }).then((r) => r.data.data)
}

export function restoreMwOpsConfig(
  id: number,
  payload: { path: string; test?: boolean; reload?: boolean },
): Promise<{
  restored: boolean
  path: string
  valid?: boolean
  validateOutput?: string
  reloaded?: boolean
  reloadOutput?: string
  files?: MwOpsConfigFile[]
}> {
  return api.post(`/mwops/instances/${id}/config/restore`, payload, { timeout: 300000 }).then((r) => r.data.data)
}
