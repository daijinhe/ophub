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
// 所有路径在入口做了 normalizeScriptPath 校验（必须落在 root 之下）；
// host 形参是「目标资产 ID」（即脚本管理目标机）—— 复用资产管理，不另接临时通道。
// ============================================================================

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

export interface ScriptHost {
  id: number
  hostname: string
  displayName?: string
  ip: string
  sshUser?: string
}

const BASE = '/scripts/java'

export function listScripts(
  host: number,
  path: string,
  root?: string,
): Promise<ScriptListResponse> {
  return api.get(BASE + '/ls', {
    params: { host, path, root: root || undefined },
  })
}

export function getScriptFile(
  host: number,
  path: string,
  root?: string,
): Promise<ScriptFile> {
  return api.get(BASE + '/file', {
    params: { host, path, root: root || undefined },
  })
}

export function putScriptFile(
  host: number,
  path: string,
  content: string,
  root?: string,
): Promise<{ msg: string; path: string; size: number }> {
  return api.put(BASE + '/file', { content }, {
    params: { host, path, root: root || undefined },
  })
}

export function createScriptDir(
  host: number,
  root: string,
  name: string,
): Promise<{ msg: string; path: string }> {
  return api.post(BASE + '/dir', undefined, {
    params: { host, root, name },
  })
}

export function createScriptFile(
  host: number,
  path: string,
  content: string,
  root?: string,
): Promise<{ msg: string; path: string }> {
  return api.post(BASE + '/file', undefined, {
    params: { host, path, content, root: root || undefined },
  })
}

export function deleteScriptEntry(
  host: number,
  path: string,
  root?: string,
): Promise<{ msg: string; path: string }> {
  return api.delete(BASE + '/entry', {
    params: { host, path, root: root || undefined },
  })
}
