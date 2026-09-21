import api from './client'

// ============================================================================
// 脚本管理（Java 启停脚本） API
//
// 与后端 handler_scriptmgr.go 的路由一一对应：
//   GET  /scripts/java/ls        → 列出指定目录下条目
//   GET  /scripts/java/file      → 读取脚本原文
//   PUT  /scripts/java/file      → 保存（覆盖）
//   POST /scripts/java/file      → 新建脚本
//   POST /scripts/java/dir       → 新建服务目录
//   DELETE /scripts/java/entry   → 删除（文件 / 空目录 / 递归目录，自适应）
//
// 双落点（source）：
//   - 'local'  平台本机 —— 直接读写平台所在机器的文件系统（不经 ansible）
//   - 'remote' 目标服务器 —— 经 ansible 控制节点操作选中的资产
//
// 两种落点共用同一套路径约束（必须落在 root 之下）与 1MiB 大小上限。
//
// ⚠️ 响应解包：与 inspection.ts 一致，统一用 .then((r) => r.data.data) 解开 axios 包装 +
// 后端 {code, msg, data} 双层包装。**v1.7.22 修复**：之前直接 return api.get(...)，
// 导致 r.items 永远是 undefined（拿到的是 AxiosResponse 对象），页面始终显示空列表。
// ============================================================================

/** 数据落点：平台本机 / 目标服务器 */
export type ScriptSource = 'local' | 'remote'

export interface ScriptDirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modTime: string // YYYY-MM-DD HH:MM
}

export interface ScriptListResponse {
  root: string
  path: string
  items: ScriptDirEntry[]
}

export interface ScriptFile {
  path: string
  size: number
  content: string
}

const BASE = '/scripts/java'

/** 统一拼 query：本机模式下不传 host（后端也不校验） */
function q(
  source: ScriptSource,
  host: number | undefined,
  path: string,
  root?: string,
) {
  return {
    source,
    host: source === 'local' ? undefined : host,
    path,
    root: root || undefined,
  }
}

/** 统一解包：解掉 axios 的 response 包装 + 后端 {code, msg, data} 双层包装 */
const unwrap = <T,>(p: Promise<any>): Promise<T> => p.then((r) => r.data as T)

export function listScripts(
  source: ScriptSource,
  host: number | undefined,
  path: string,
  root?: string,
): Promise<ScriptListResponse> {
  return unwrap<ScriptListResponse>(
    api.get(BASE + '/ls', { params: q(source, host, path, root) }),
  )
}

export function getScriptFile(
  source: ScriptSource,
  host: number | undefined,
  path: string,
  root?: string,
): Promise<ScriptFile> {
  return unwrap<ScriptFile>(
    api.get(BASE + '/file', { params: q(source, host, path, root) }),
  )
}

export function putScriptFile(
  source: ScriptSource,
  host: number | undefined,
  path: string,
  content: string,
  root?: string,
): Promise<{ msg: string; path: string; size: number }> {
  return unwrap<{ msg: string; path: string; size: number }>(
    api.put(BASE + '/file', { content }, { params: q(source, host, path, root) }),
  )
}

export function createScriptDir(
  source: ScriptSource,
  host: number | undefined,
  root: string,
  name: string,
): Promise<{ msg: string; path: string }> {
  return unwrap<{ msg: string; path: string }>(
    api.post(BASE + '/dir', undefined, {
      params: {
        source,
        host: source === 'local' ? undefined : host,
        root,
        name,
      },
    }),
  )
}

export function createScriptFile(
  source: ScriptSource,
  host: number | undefined,
  path: string,
  content: string,
  root?: string,
): Promise<{ msg: string; path: string }> {
  return unwrap<{ msg: string; path: string }>(
    api.post(BASE + '/file', undefined, {
      params: { ...q(source, host, path, root), content },
    }),
  )
}

export function deleteScriptEntry(
  source: ScriptSource,
  host: number | undefined,
  path: string,
  root?: string,
): Promise<{ msg: string; path: string }> {
  return unwrap<{ msg: string; path: string }>(
    api.delete(BASE + '/entry', { params: q(source, host, path, root) }),
  )
}