import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../api/client'
import WebTerminal from '../components/WebTerminal'

interface AssetLite {
  id: number
  name?: string
  ip?: string
  fields?: Record<string, any>
}

export default function WebTerminalPage() {
  const { assetId } = useParams<{ assetId: string }>()
  const navigate = useNavigate()
  const [asset, setAsset] = useState<AssetLite | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const id = Number(assetId)
    if (!id) {
      setErr('缺少资产 ID')
      setLoading(false)
      return
    }
    const load = (silent = false) =>
      api
        .get(`/assets/${id}`)
        .then((r) => {
          if (!alive) return
          const data = r.data?.data || r.data
          const next = { id, name: data?.name, ip: data?.ip, fields: data?.fields }
          // 静默刷新（focus / visibilitychange）时若展示信息没变，保持原对象引用不变，
          // 避免无意义的重渲染与终端抖动（配合 WebTerminal 依赖 asset?.id，彻底不重连）。
          setAsset((prev) => {
            if (
              prev &&
              prev.name === next.name &&
              prev.ip === next.ip &&
              JSON.stringify(prev.fields) === JSON.stringify(next.fields)
            ) {
              return prev
            }
            return next
          })
        })
        .catch((e) => {
          if (!alive || silent) return // 静默刷新失败不打断已建立的会话
          setErr(e?.response?.data?.message || '加载资产信息失败')
        })
        .finally(() => {
          if (alive && !silent) setLoading(false)
        })

    load()

    // 终端窗口常常一开就是几小时。若期间资产信息被改（自己在别的页面改、或别人改了），
    // 会话名会一直停留在打开那一刻的旧值。窗口重新获得焦点 / 重新可见时静默拉一次最新，
    // 只刷新展示用的资产信息，不影响已建立的 SSH 会话。
    const onWake = () => {
      if (document.visibilityState === 'visible') void load(true)
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      alive = false
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [assetId])

  // 关闭：优先关闭由脚本打开的新窗口，失败则回退到导航
  const handleClose = () => {
    try {
      // 仅当是本窗口自身由 window.open 打开时才允许脚本关闭
      if (window.opener || window.history.length <= 1) {
        window.close()
      }
    } catch {
      /* noop */
    }
    navigate('/cmdb')
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0f1e', color: '#7dd3fc' }}>
        正在加载终端…
      </div>
    )
  }

  if (err || !asset) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, background: '#0a0f1e', color: '#fca5a5' }}>
        <div>{err || '资产不存在'}</div>
        <button onClick={() => navigate('/cmdb')} style={{ padding: '6px 16px', cursor: 'pointer' }}>
          返回 CMDB
        </button>
      </div>
    )
  }

  return <WebTerminal open={true} asset={asset} onClose={handleClose} standalone />
}
