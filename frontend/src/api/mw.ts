import api from './client'

// 中间件类型字段定义
export interface MwField {
  key?: string
  label: string
  default?: string
  options?: string[]
  dependsOn?: { field: string; value: string }
}

// 中间件类型模板：一个类型对应一组字段
export interface MwTemplate {
  type: string
  fields: MwField[]
}

// 列出全部中间件类型模板
export function getMwTemplates(): Promise<MwTemplate[]> {
  return api.get('/mw/templates').then((r) => r.data.data as MwTemplate[])
}

// 新建或更新某类型的字段模板（upsert）
export function upsertMwTemplate(type: string, fields: MwField[]): Promise<void> {
  return api.put(`/mw/templates/${encodeURIComponent(type)}`, { fields })
}

// 删除某中间件类型
export function deleteMwTemplate(type: string): Promise<void> {
  return api.delete(`/mw/templates/${encodeURIComponent(type)}`)
}
