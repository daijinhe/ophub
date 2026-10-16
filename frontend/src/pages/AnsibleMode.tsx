// 云枢 OpsHub · 智能运维平台
// Copyright (c) 2026 daijinhe <taichicho@foxmail.com>
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Card,
  Descriptions,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ApiOutlined,
  CloudServerOutlined,
  CodeOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import api from '../api/client'
import { useAuth } from '../store/AuthContext'

const { Text, Paragraph } = Typography

// 平台采集通道模式（v1.7.15+）：一个开关决定全平台调 ansible 走哪条通道
interface AnsibleModeInfo {
  mode: string // local / remote / auto
  effective: string // local / remote / none
  localAvailable: boolean
  localError?: string
  remoteCount: number
  remoteNames?: string
  fromEnv?: boolean
}

interface AnsibleLocalInfo {
  available: boolean
  ansibleVersion?: string
  pythonVersion?: string
  configFile?: string
  hostsPath?: string
  error?: string
}

const MODE_LABEL: Record<string, string> = {
  local: '本机 ansible（强制）',
  remote: '远端控制节点（强制）',
  auto: '自动（本机优先，不可用则远端）',
}

const MODE_HELP: Record<string, string> = {
  local:
    '所有采集（资源校准 / 中间件捕捉 / 智能巡检 / 定时任务）一律走平台本机 ansible。本机不可用时直接报错，不会静默回退到远端控制节点。',
  remote:
    '所有采集一律走「远端 Ansible 管理」里配置的控制节点，即使本机装了 ansible 也不会使用。适合本机 ansible 环境不全、只信赖控制节点的场景。',
  auto: '本机 ansible 可用就用本机，不可用自动回退到远端控制节点。这是历史默认行为。',
}

// 受该开关影响的调用点（后端全部经 ResolveAnsibleRunner 单一入口分发）
const AFFECTED = [
  '资源校准（资产详情重新采集）',
  '中间件捕捉 / 中间件管控',
  '智能巡检任务执行',
  '定时任务（crontab）读写',
  '提权探测（sudo / root 判定）',
]

export default function AnsibleMode() {
  const { hasPerm } = useAuth()
  const { message } = App.useApp()
  const [modeInfo, setModeInfo] = useState<AnsibleModeInfo | null>(null)
  const [localInfo, setLocalInfo] = useState<AnsibleLocalInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([api.get('/ansible/mode'), api.get('/ansible/local/info')])
      .then(([modeRes, localRes]) => {
        setModeInfo(modeRes.data.data)
        setLocalInfo(localRes.data.data)
      })
      .catch((e) => message.error(e.response?.data?.msg || '加载采集通道配置失败'))
      .finally(() => setLoading(false))
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  const saveMode = (m: string) => {
    setSaving(true)
    api
      .put('/ansible/mode', { mode: m })
      .then((r) => {
        setModeInfo(r.data.data)
        message.success(`已切换采集通道：${MODE_LABEL[m] || m}`)
      })
      .catch((e) => message.error(e.response?.data?.msg || '切换失败'))
      .finally(() => setSaving(false))
  }

  const effectiveTag = (eff?: string) => {
    if (eff === 'local') return <Tag color="green">本机 ansible</Tag>
    if (eff === 'remote') return <Tag color="blue">远端控制节点</Tag>
    return <Tag color="red">无可用通道</Tag>
  }

  const currentMode = modeInfo?.mode || 'auto'

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            平台采集通道设置
          </Typography.Title>
          <Space size={6} wrap style={{ marginTop: 4 }}>
            <Text type="secondary">当前生效：</Text>
            {modeInfo ? effectiveTag(modeInfo.effective) : <Tag>加载中</Tag>}
            {modeInfo?.fromEnv && <Tag color="orange">来自环境变量，未落库</Tag>}
          </Space>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
      </div>

      <Spin spinning={loading}>
        <Card
          size="small"
          title={
            <Space>
              <ApiOutlined />
              <span>采集通道</span>
              <Tooltip title="决定资源校准、中间件捕捉、智能巡检、定时任务等所有调用 ansible 的场景走哪条通道。改完立即生效，无需重启容器。">
                <InfoCircleOutlined style={{ color: '#999' }} />
              </Tooltip>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={14}>
            {/* 本页唯一的写操作是切换采集通道（PUT /ansible/mode），语义为「保存设置」→ ansible:mode:update */}
            {hasPerm('ansible:mode:update') && (
              <Space wrap>
                <Text>采集通道：</Text>
                <Segmented
                  value={currentMode}
                  disabled={!modeInfo || saving}
                  onChange={(v) => saveMode(String(v))}
                  options={[
                    { label: '本机 ansible', value: 'local' },
                    { label: '远端控制节点', value: 'remote' },
                    { label: '自动', value: 'auto' },
                  ]}
                />
              </Space>
            )}

            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {MODE_HELP[currentMode]}
            </Paragraph>

            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="本机 ansible">
                {modeInfo?.localAvailable ? (
                  <Space wrap size={6}>
                    <Tag color="green">可用</Tag>
                    {localInfo?.ansibleVersion && (
                      <Text type="secondary">{localInfo.ansibleVersion}</Text>
                    )}
                    {localInfo?.hostsPath && <Text type="secondary">hosts: {localInfo.hostsPath}</Text>}
                  </Space>
                ) : (
                  <Tooltip title={modeInfo?.localError || '不可用'}>
                    <Tag color="red">不可用</Tag>
                  </Tooltip>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="远端控制节点">
                {modeInfo && modeInfo.remoteCount > 0 ? (
                  <Space wrap size={6}>
                    <Tag color="blue">{modeInfo.remoteCount} 台</Tag>
                    <Text type="secondary">{modeInfo.remoteNames}</Text>
                  </Space>
                ) : (
                  <Tag>未配置</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="配置来源">
                {modeInfo?.fromEnv ? (
                  <Text type="secondary">
                    环境变量 ANSIBLE_RUNNER_MODE（在页面上改动后会写入数据库并覆盖环境变量）
                  </Text>
                ) : (
                  <Text type="secondary">数据库 system_settings（ansible.runner.mode）</Text>
                )}
              </Descriptions.Item>
            </Descriptions>

            {modeInfo?.mode === 'local' && !modeInfo.localAvailable && (
              <Alert
                type="error"
                showIcon
                message="已设为强制本机，但本机 ansible 不可用——所有采集会直接失败（不会静默回退远端）"
                description={modeInfo.localError}
              />
            )}
            {modeInfo?.mode === 'remote' && modeInfo.remoteCount === 0 && (
              <Alert
                type="warning"
                showIcon
                message="已设为强制远端，但没有配置任何控制节点"
                description="请在「远端 Ansible 管理」添加控制节点，或把通道切回「本机 ansible」。"
              />
            )}
            {modeInfo?.effective === 'none' && (
              <Alert
                type="error"
                showIcon
                message="当前没有任何可用通道"
                description="本机 ansible 不可用且未配置远端控制节点，所有 ansible 调用都会失败。"
              />
            )}
          </Space>
        </Card>
      </Spin>

      <Card
        size="small"
        title={
          <Space>
            <InfoCircleOutlined />
            <span>影响范围</span>
          </Space>
        }
      >
        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
          后端所有调用 ansible 的入口都走同一个解析函数，因此这个开关对以下场景统一生效：
        </Paragraph>
        <Space direction="vertical" size={4}>
          {AFFECTED.map((t) => (
            <Space key={t} size={6}>
              <Tag color={currentMode === 'local' ? 'green' : currentMode === 'remote' ? 'blue' : 'default'}>
                {currentMode === 'local' ? <CodeOutlined /> : currentMode === 'remote' ? <CloudServerOutlined /> : null}
              </Tag>
              <Text>{t}</Text>
            </Space>
          ))}
        </Space>
      </Card>
    </div>
  )
}
