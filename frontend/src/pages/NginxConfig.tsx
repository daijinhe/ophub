// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  FileProtectOutlined,
  PlusOutlined,
  SearchOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  ScanOutlined,
  SyncOutlined,
  CloudDownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import {
  configScanScope,
  scanNginxConfigs,
  importNginxConfigs,
  listNginxConfigs,
  createNginxConfig,
  deleteNginxConfig,
  pullNginxConfig,
  syncNginxConfig,
  type NginxConfigItem,
  type NginxConfigStats,
  type ScannedNginxItem,
  type ScanScopeAsset,
} from '../api/config'
import { useAuth } from '../store/AuthContext'

const { Text, Title } = Typography

// 状态展示映射
const STATUS_META: Record<string, { text: string; color: string; icon: React.ReactNode }> = {
  synced: { text: '已同步', color: 'green', icon: <CheckCircleOutlined /> },
  modified: { text: '待同步', color: 'orange', icon: <ExclamationCircleOutlined /> },
  error: { text: '异常', color: 'red', icon: <CloseCircleOutlined /> },
  notfound: { text: '远端缺失', color: 'default', icon: <WarningOutlined /> },
  unknown: { text: '未拉取', color: 'default', icon: <WarningOutlined /> },
}

// 类型展示映射
const KIND_META: Record<string, { text: string; color: string }> = {
  main: { text: '主配置', color: 'geekblue' },
  'conf.d': { text: 'conf.d', color: 'blue' },
  site: { text: '站点', color: 'cyan' },
  module: { text: '模块', color: 'purple' },
  other: { text: 'include', color: 'default' },
}

function fmtTime(v?: string | null) {
  if (!v) return '—'
  return v.replace('T', ' ').slice(0, 19)
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export default function NginxConfig() {
  const { message, modal } = App.useApp()
  const { hasPerm } = useAuth()

  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<NginxConfigItem[]>([])
  const [stats, setStats] = useState<NginxConfigStats | null>(null)

  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  // 扫描
  const [scanOpen, setScanOpen] = useState(false)
  const [scope, setScope] = useState<ScanScopeAsset[]>([])
  const [scanAsset, setScanAsset] = useState<number | undefined>()
  const [scanning, setScanning] = useState(false)
  const [scanItems, setScanItems] = useState<ScannedNginxItem[]>([])
  const [scanSummary, setScanSummary] = useState('')
  const [importing, setImporting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])

  // 新增纳管
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({ assetId: undefined as number | undefined, path: '', kind: 'other', content: '' })
  const [creating, setCreating] = useState(false)

  // 编辑（在线编辑 + 同步）
  const [editOpen, setEditOpen] = useState(false)
  const [editRec, setEditRec] = useState<NginxConfigItem | null>(null)
  const [draft, setDraft] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [validateResult, setValidateResult] = useState<{ valid: boolean; output: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = {}
      if (keyword.trim()) params.keyword = keyword.trim()
      if (statusFilter !== 'all') params.status = statusFilter
      const d = await listNginxConfigs(params)
      setRows(d.list || [])
      setStats(d.stats || null)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [keyword, statusFilter, message])

  useEffect(() => {
    load()
  }, [load])

  const dirty = useMemo(() => (editRec ? draft !== editRec.content : false), [editRec, draft])

  // ---- 扫描 ----
  const openScan = async () => {
    setScanOpen(true)
    setScanItems([])
    setScanSummary('')
    setSelectedKeys([])
    if (scope.length === 0) {
      try {
        const d = await configScanScope()
        setScope(d.assets || [])
      } catch (e: any) {
        message.error(e?.response?.data?.msg || '读取资产清单失败')
      }
    }
  }

  const runScan = async (all: boolean) => {
    if (!all && !scanAsset) {
      message.warning('请先选择要扫描的主机')
      return
    }
    setScanning(true)
    setScanItems([])
    setScanSummary('')
    setSelectedKeys([])
    try {
      const d = await scanNginxConfigs(all ? { all: true } : { assetId: scanAsset })
      setScanItems(d.items || [])
      setScanSummary(`扫描 ${d.assetCount} 台主机，发现 ${d.foundCount} 个配置文件`)
      if (!d.items?.length) message.info('未发现任何配置（主机可能未安装 nginx 或连接失败）')
    } catch (e: any) {
      message.error(e?.response?.data?.msg || e.message || '扫描失败')
    } finally {
      setScanning(false)
    }
  }

  const doImport = async () => {
    const picked = scanItems.filter((it) => !it.error && selectedKeys.includes(keyOf(it)))
    if (!picked.length) {
      message.warning('请先勾选要导入的配置文件')
      return
    }
    setImporting(true)
    try {
      const d = await importNginxConfigs(
        picked.map((it) => ({
          assetId: it.assetId,
          path: it.path,
          kind: it.kind,
          content: it.content,
          md5: it.md5,
          assetName: it.assetName,
          host: it.host,
        }))
      )
      message.success(`导入完成：新增 ${d.created}，跳过重复 ${d.skipped}，失败 ${d.failed}`)
      if (d.created > 0) {
        setScanOpen(false)
        load()
      }
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const keyOf = (it: ScannedNginxItem) => `${it.assetId}|${it.path}` as unknown as number

  // ---- 新增 ----
  const doCreate = async () => {
    if (!createForm.assetId || !createForm.path.trim()) {
      message.warning('请选择主机并填写配置文件路径')
      return
    }
    setCreating(true)
    try {
      const rec = await createNginxConfig({
        assetId: createForm.assetId,
        path: createForm.path.trim(),
        kind: createForm.kind,
        content: createForm.content,
      })
      message.success('纳管记录已创建；可在编辑中保存内容到服务器（远端文件不存在时会自动创建）')
      setCreateOpen(false)
      setCreateForm({ assetId: undefined, path: '', kind: 'other', content: '' })
      load()
      openEdit(rec)
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  // ---- 编辑 / 同步 / 拉取 / 删除 ----
  const openEdit = (rec: NginxConfigItem) => {
    setEditRec(rec)
    setDraft(rec.content || '')
    setValidateResult(null)
    setEditOpen(true)
  }

  const doPull = async () => {
    if (!editRec) return
    if (dirty) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '从服务器拉取将覆盖当前编辑器中的内容（包括未保存的修改）。',
        okText: '拉取覆盖',
        cancelText: '取消',
        onOk: () => pullNow(),
      })
      return
    }
    pullNow()
  }

  const pullNow = async () => {
    if (!editRec) return
    setPulling(true)
    try {
      const rec = await pullNginxConfig(editRec.id)
      setEditRec(rec)
      setDraft(rec.content || '')
      setValidateResult(null)
      message.success('已从服务器拉取最新内容')
      load()
    } catch (e: any) {
      message.error(e?.response?.data?.msg || '拉取失败')
      load()
    } finally {
      setPulling(false)
    }
  }

  const doSync = async () => {
    if (!editRec) return
    if (!draft.trim()) {
      message.warning('配置内容为空，不予保存（防止误清空远端文件）')
      return
    }
    modal.confirm({
      title: '保存并同步到服务器？',
      content: (
        <div>
          <p>将把编辑器内容写入远端文件：</p>
          <code style={{ wordBreak: 'break-all' }}>{editRec.path}</code>
          <p style={{ marginTop: 8, color: '#888' }}>
            写入前平台会自动在目标机生成 <code>*.ophub.bak</code> 备份；写入后自动执行 nginx -t 校验。
          </p>
        </div>
      ),
      okText: '保存并同步',
      cancelText: '取消',
      onOk: async () => {
        setSyncing(true)
        try {
          const r = await syncNginxConfig(editRec.id, draft)
          setValidateResult({ valid: r.valid, output: r.validateOutput })
          if (r.valid) {
            message.success('已保存并同步到服务器，nginx -t 校验通过')
          } else {
            message.error('已写入服务器，但 nginx -t 校验未通过，请检查配置')
          }
          load()
        } catch (e: any) {
          message.error(e?.response?.data?.msg || '同步失败')
        } finally {
          setSyncing(false)
        }
      },
    })
  }

  const doDelete = (rec: NginxConfigItem) => {
    let delRemote = false
    modal.confirm({
      title: '删除纳管记录？',
      content: (
        <div>
          <p>
            配置文件：<code style={{ wordBreak: 'break-all' }}>{rec.path}</code>
          </p>
          <p style={{ color: '#888' }}>仅移除平台的纳管记录，不影响服务器上的文件。</p>
          <Checkbox onChange={(e) => (delRemote = e.target.checked)}>
            同时删除服务器上的配置文件（危险）
          </Checkbox>
        </div>
      ),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await deleteNginxConfig(rec.id, delRemote)
          if (delRemote && r.remoteDeleted === false) {
            message.warning('平台记录已删除，但远端文件删除失败：' + (r.remoteWarning || '未知原因'))
          } else {
            message.success(delRemote ? '纳管记录与远端文件已删除' : '纳管记录已删除')
          }
          if (editRec?.id === rec.id) setEditOpen(false)
          load()
        } catch (e: any) {
          message.error(e?.response?.data?.msg || '删除失败')
        }
      },
    })
  }

  // ---- 表格列 ----
  const columns: ColumnsType<NginxConfigItem> = [
    {
      title: '资产 / 主机',
      width: 190,
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.assetName || `资产 #${r.assetId}`}</div>
          <Text type="secondary" style={{ fontSize: 12 }} className="ct-code">
            {r.host || '—'}
          </Text>
        </div>
      ),
    },
    {
      title: '配置文件',
      render: (_, r) => (
        <div>
          <code className="ct-code ct-code--cmd" style={{ wordBreak: 'break-all' }}>
            {r.path}
          </code>
        </div>
      ),
    },
    {
      title: '类型',
      width: 96,
      render: (_, r) => {
        const m = KIND_META[r.kind] || KIND_META.other
        return <Tag color={m.color}>{m.text}</Tag>
      },
    },
    {
      title: '状态',
      width: 110,
      render: (_, r) => {
        const m = STATUS_META[r.status] || STATUS_META.unknown
        return (
          <Tag color={m.color} icon={m.icon}>
            {m.text}
          </Tag>
        )
      },
    },
    {
      title: '远端 MD5',
      width: 120,
      render: (_, r) => (
        <Tooltip title={r.remoteMd5 || '未拉取'}>
          <Text type="secondary" className="ct-code" style={{ fontSize: 12 }}>
            {r.remoteMd5 ? r.remoteMd5.slice(0, 8) + '…' : '—'}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '最后同步',
      width: 150,
      render: (_, r) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {fmtTime(r.lastSyncAt)}
        </Text>
      ),
    },
    {
      title: '操作',
      width: 220,
      render: (_, r) => (
        <Space size={4} wrap>
          {hasPerm('config:update') && (
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(r)}>
              编辑
            </Button>
          )}
          {hasPerm('config:sync') && (
            <Button
              size="small"
              type="link"
              icon={<CloudDownloadOutlined />}
              onClick={async () => {
                try {
                  await pullNginxConfig(r.id)
                  message.success(`已拉取 ${r.path}`)
                  load()
                } catch (e: any) {
                  message.error(e?.response?.data?.msg || '拉取失败')
                }
              }}
            >
              拉取
            </Button>
          )}
          {hasPerm('config:delete') && (
            <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => doDelete(r)}>
              删除
            </Button>
          )}
        </Space>
      ),
    },
  ]

  // ---- 扫描结果列 ----
  const scanColumns: ColumnsType<ScannedNginxItem> = [
    { title: '资产', width: 140, render: (_, r) => r.assetName || `#${r.assetId}` },
    { title: '主机', width: 130, render: (_, r) => <span className="ct-code">{r.host}</span> },
    {
      title: '配置文件',
      render: (_, r) =>
        r.error ? (
          <Tooltip title={r.error}>
            <span style={{ color: '#cf1322' }}>
              <WarningOutlined /> {r.path || r.error.slice(0, 40)}
            </span>
          </Tooltip>
        ) : (
          <code className="ct-code" style={{ wordBreak: 'break-all' }}>
            {r.path}
          </code>
        ),
    },
    {
      title: '类型',
      width: 90,
      render: (_, r) => {
        const m = KIND_META[r.kind] || KIND_META.other
        return r.error ? <Tag color="red">失败</Tag> : <Tag color={m.color}>{m.text}</Tag>
      },
    },
    { title: '大小', width: 90, render: (_, r) => (r.error ? '—' : fmtSize(r.size)) },
  ]

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Hero */}
      <div className="mw-hero" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileProtectOutlined style={{ fontSize: 26, color: 'var(--accent)' }} />
          <div>
            <Title level={4} style={{ margin: 0 }}>
              Nginx 配置管理
            </Title>
            <Text type="secondary">扫描虚拟机列表中的 nginx 配置文件，在线编辑、保存同步（自动 nginx -t 校验），全程留备份。</Text>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 22, marginTop: 14, flexWrap: 'wrap' }}>
          {[
            { label: '纳管配置', value: stats?.total ?? 0, color: 'var(--accent)' },
            { label: '已同步', value: stats?.synced ?? 0, color: '#52c41a' },
            { label: '待同步', value: stats?.modified ?? 0, color: '#fa8c16' },
            { label: '异常', value: (stats?.error ?? 0) + (stats?.notfound ?? 0), color: '#ff4d4f' },
          ].map((s) => (
            <div key={s.label}>
              <div style={{ fontSize: 26, fontWeight: 700, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="mw-cfg-toolbar" style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索路径 / 资产 / 主机"
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={load}
        />
        <Select
          style={{ width: 130 }}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v)}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'synced', label: '已同步' },
            { value: 'modified', label: '待同步' },
            { value: 'error', label: '异常' },
            { value: 'notfound', label: '远端缺失' },
            { value: 'unknown', label: '未拉取' },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>
          刷新
        </Button>
        <div style={{ flex: 1 }} />
        {hasPerm('config:sync') && (
          <Button type="primary" icon={<ScanOutlined />} onClick={openScan}>
            扫描配置
          </Button>
        )}
        {hasPerm('config:create') && (
          <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增纳管
          </Button>
        )}
      </div>

      {/* 列表 */}
      <Table
        rowKey="id"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 条`, showSizeChanger: false }}
        locale={{ emptyText: <Empty description="暂无纳管配置，点击「扫描配置」从虚拟机列表发现 nginx 配置" /> }}
      />

      {/* 扫描抽屉 */}
      <Drawer
        title={
          <Space>
            <ScanOutlined />
            扫描虚拟机 nginx 配置
          </Space>
        }
        width={860}
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        destroyOnClose
      >
        <Space style={{ marginBottom: 14 }} wrap>
          <Select
            showSearch
            allowClear
            placeholder="选择要扫描的主机"
            style={{ width: 280 }}
            value={scanAsset}
            onChange={setScanAsset}
            optionFilterProp="label"
            options={scope.map((a) => ({ value: a.id, label: `${a.name}（${a.ip || '未填 IP'}）` }))}
          />
          {hasPerm('config:sync') && (
            <Button type="primary" loading={scanning} onClick={() => runScan(false)}>
              扫描该主机
            </Button>
          )}
          {hasPerm('config:sync') && (
            <Button loading={scanning} onClick={() => runScan(true)}>
              扫描全部主机
            </Button>
          )}
        </Space>
        {scanSummary && (
          <Alert type="info" showIcon message={scanSummary} style={{ marginBottom: 12 }} />
        )}
        {scanning ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 14, color: '#888' }}>
              正在 SSH 连接目标机探测 nginx 配置（全部主机扫描可能需要较长时间）…
            </div>
          </div>
        ) : (
          <>
            <Table
              rowKey={(r: ScannedNginxItem) => keyOf(r) as any}
              size="small"
              columns={scanColumns}
              dataSource={scanItems}
              pagination={false}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: setSelectedKeys,
                getCheckboxProps: (r: ScannedNginxItem) => ({ disabled: !!r.error }),
              }}
              locale={{ emptyText: <Empty description="选择主机后点击「扫描」" /> }}
              scroll={{ y: 380 }}
            />
            <div style={{ marginTop: 14, textAlign: 'right' }}>
              {/* 「导入」后端 /config/import 收口在 config:sync，故用 :sync */}
              {hasPerm('config:sync') && (
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  loading={importing}
                  disabled={selectedKeys.length === 0}
                  onClick={doImport}
                >
                  导入选中（{selectedKeys.length}）
                </Button>
              )}
            </div>
          </>
        )}
      </Drawer>

      {/* 新增纳管 */}
      <Modal
        title="新增 nginx 配置纳管"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={doCreate}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
        width={640}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={12}>
          <div>
            <div style={{ marginBottom: 4 }}>主机（来自虚拟机列表）</div>
            <Select
              showSearch
              placeholder="选择资产"
              style={{ width: '100%' }}
              value={createForm.assetId}
              onChange={(v) => setCreateForm((f) => ({ ...f, assetId: v }))}
              optionFilterProp="label"
              options={scope.map((a) => ({ value: a.id, label: `${a.name}（${a.ip || '未填 IP'}）` }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>配置文件绝对路径</div>
            <Input
              placeholder="/etc/nginx/conf.d/site.conf"
              value={createForm.path}
              onChange={(e) => setCreateForm((f) => ({ ...f, path: e.target.value }))}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>类型</div>
            <Select
              style={{ width: 200 }}
              value={createForm.kind}
              onChange={(v) => setCreateForm((f) => ({ ...f, kind: v }))}
              options={[
                { value: 'main', label: '主配置' },
                { value: 'conf.d', label: 'conf.d 片段' },
                { value: 'site', label: '站点配置' },
                { value: 'module', label: '模块加载' },
                { value: 'other', label: '其它 include' },
              ]}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>初始内容（可选；远端文件不存在时，保存同步将自动创建）</div>
            <Input.TextArea
              rows={6}
              className="nx-editor"
              placeholder="server { ... }"
              value={createForm.content}
              onChange={(e) => setCreateForm((f) => ({ ...f, content: e.target.value }))}
            />
          </div>
        </Space>
      </Modal>

      {/* 编辑抽屉（在线编辑 + 同步） */}
      <Drawer
        title={
          <Space direction="vertical" size={2}>
            <Space>
              <EditOutlined />
              <span style={{ fontWeight: 600 }}>编辑配置</span>
              {editRec && (
                <Tag color={(STATUS_META[editRec.status] || STATUS_META.unknown).color}>
                  {(STATUS_META[editRec.status] || STATUS_META.unknown).text}
                </Tag>
              )}
              {dirty && <Tag color="orange">有未保存修改</Tag>}
            </Space>
            {editRec && (
              <Text type="secondary" style={{ fontSize: 12 }} className="ct-code">
                {editRec.assetName} · {editRec.host} · {editRec.path}
              </Text>
            )}
          </Space>
        }
        width={920}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        destroyOnClose
        extra={
          <Space>
            {hasPerm('config:sync') && (
              <Button icon={<CloudDownloadOutlined />} loading={pulling} onClick={doPull}>
                从服务器拉取
              </Button>
            )}
            {/* 「保存并同步」写入远端，后端 /config/:id/sync 收口在 config:sync，故用 :sync */}
            {hasPerm('config:sync') && (
              <Button type="primary" icon={<SyncOutlined />} loading={syncing} onClick={doSync}>
                保存并同步
              </Button>
            )}
          </Space>
        }
      >
        {editRec && (
          <>
            {validateResult && (
              <Alert
                style={{ marginBottom: 12 }}
                type={validateResult.valid ? 'success' : 'error'}
                showIcon
                icon={validateResult.valid ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                message={validateResult.valid ? 'nginx -t 校验通过' : 'nginx -t 校验未通过'}
                description={
                  validateResult.output ? <pre className="ct-pre">{validateResult.output}</pre> : undefined
                }
              />
            )}
            {editRec.status === 'notfound' && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                message="远端文件不存在或不可读"
                description="可以直接在下方编写配置内容，点击「保存并同步」将在服务器上创建该文件。"
              />
            )}
            <Input.TextArea
              className="nx-editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={26}
              spellCheck={false}
              placeholder="# nginx 配置内容"
            />
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                写入远端前自动生成 <code>*.ophub.bak</code> 备份；保存后自动执行 <code>nginx -t</code> 校验。
              </Text>
              {hasPerm('config:delete') && (
                <Button danger icon={<DeleteOutlined />} onClick={() => doDelete(editRec)}>
                  删除纳管
                </Button>
              )}
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}
