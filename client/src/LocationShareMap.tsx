/**
 * v4.4.5: 实时位置共享地图页(全屏overlay)
 * - Leaflet + 高德免key瓦片(GCJ-02坐标系, 与上报坐标直接匹配, 无需重投影)
 * - 成员标记实时刷新(安卓原生服务30s上报); 自己的位置走 location_share_self 事件即时刷新
 * - 安卓: 进入自动加入共享(微信式), 离开=退出; 桌面: 只读观看
 */
import React, { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { LocationShareSession } from './conversation'

interface LocationShareMapProps {
  session: LocationShareSession
  myAgentId: string
  isAndroid: boolean
  onJoin: () => Promise<{ ok: boolean; error?: string }>
  onStop: () => void
  onClose: () => void
}

/** 参与者标记颜色轮换 */
const PIN_COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#f06292', '#ba68c8', '#fff176']

const fmtAgentName = (agentId: string): string => {
  if (!agentId) return '?'
  const base = agentId.replace(/-android$/, '')
  return base.length > 12 ? base.slice(0, 12) + '…' : base
}

const fmtAge = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}秒前`
  return `${Math.floor(s / 60)}分钟前`
}

export const LocationShareMap: React.FC<LocationShareMapProps> = ({
  session, myAgentId, isAndroid, onJoin, onStop, onClose,
}) => {
  const mapDivRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Record<string, L.Marker>>({})
  const [, forceTick] = useState(0) // 刷新"xx秒前"显示
  const [joinErr, setJoinErr] = useState('')
  const [joining, setJoining] = useState(false)

  const participants = Object.entries(session.participants || {})
  const iAmSharing = !!session.participants?.[myAgentId]
  const ended = !!session.ended
  const colorOf = (agent: string) => {
    const keys = Object.keys(session.participants || {})
    const idx = keys.indexOf(agent)
    return PIN_COLORS[(idx < 0 ? 0 : idx) % PIN_COLORS.length]
  }

  // 初始化地图(一次)
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return
    const map = L.map(mapDivRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([23.1291, 113.2644], 11) // 默认广州
    // 高德免key瓦片(GCJ-02): 上报坐标同为GCJ-02, 直接叠加零偏移
    // 注意: webrd 主机只有 style=8; style=7 必须用 wprd 主机(曾用错导致整片404白图)
    const layer = L.tileLayer(
      'https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=7',
      { subdomains: ['1', '2', '3', '4'], maxZoom: 18 },
    ).addTo(map)
    // 瓦片连续失败自动切腾讯源兜底(同为GCJ-02)
    let tileErrs = 0
    layer.on('tileerror', () => {
      tileErrs += 1
      if (tileErrs === 3) {
        L.tileLayer('https://rt{s}.map.gtimg.com/realtimerender?z={z}&x={x}&y={y}&type=vector&style=0', {
          subdomains: ['0', '1', '2', '3'],
          maxZoom: 18,
        }).addTo(map)
      }
    })
    mapRef.current = map
    // Leaflet在隐藏容器初始化后需要重算尺寸(多次重试防 Android 布局慢)
    setTimeout(() => map.invalidateSize(), 100)
    setTimeout(() => map.invalidateSize(), 500)
    setTimeout(() => map.invalidateSize(), 1500)
    return () => {
      map.remove()
      mapRef.current = null
      markersRef.current = {}
    }
  }, [])

  // 参与者标记同步
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const markers = markersRef.current
    // 移除消失的参与者
    for (const agent of Object.keys(markers)) {
      if (!session.participants[agent]) {
        map.removeLayer(markers[agent])
        delete markers[agent]
      }
    }
    // 新增/更新
    for (const [agent, p] of Object.entries(session.participants || {})) {
      const html = `<div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-14px);">
        <div style="background:${colorOf(agent)};color:#000;font-size:11px;font-weight:700;padding:1px 6px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.4);">${fmtAgentName(agent)}${agent === myAgentId ? '(我)' : ''}</div>
        <div style="font-size:20px;line-height:1;margin-top:1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));">📍</div>
      </div>`
      const icon = L.divIcon({ html, className: 'sm-share-pin', iconSize: [80, 34], iconAnchor: [40, 30] })
      if (markers[agent]) {
        markers[agent].setLatLng([p.lat, p.lng])
        markers[agent].setIcon(icon)
        markers[agent].getPopup()?.setContent(`${fmtAgentName(agent)} · ${fmtAge(p.ts)}${p.accuracy ? ` · ±${Math.round(p.accuracy)}m` : ''}`)
      } else {
        const m = L.marker([p.lat, p.lng], { icon }).addTo(map)
        m.bindPopup(`${fmtAgentName(agent)} · ${fmtAge(p.ts)}${p.accuracy ? ` · ±${Math.round(p.accuracy)}m` : ''}`)
        markers[agent] = m
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.participants, myAgentId])

  // 视野适配: 参与者数量变化时fitBounds; 有"跟随"需求时保持简单不自动跟随
  const partCount = Object.keys(session.participants || {}).length
  const prevCountRef = useRef(0)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const pts = Object.values(session.participants || {}).map(p => [p.lat, p.lng] as [number, number])
    if (pts.length === 0) return
    if (pts.length === 1) {
      map.setView(pts[0], 15)
    } else {
      map.fitBounds(L.latLngBounds(pts).pad(0.3))
    }
    prevCountRef.current = partCount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partCount])

  // "xx秒前"每15s刷新一次
  useEffect(() => {
    const t = setInterval(() => forceTick(x => x + 1), 15000)
    return () => clearInterval(t)
  }, [])

  // 安卓: 进入地图自动加入共享(微信式; 已在共享/已结束/桌面除外)
  useEffect(() => {
    if (!isAndroid || ended || iAmSharing) return
    setJoining(true)
    onJoin().then(r => {
      if (!r.ok && r.error) setJoinErr(r.error)
    }).finally(() => setJoining(false))
    // 仅进入时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStop = () => {
    onStop()
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#0f1115', zIndex: 9000,
      display: 'flex', flexDirection: 'column',
    }}>
      {/* 顶栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px',
        padding: '10px 14px', background: '#16181d',
        borderBottom: '1px solid #2a2d35', flexShrink: 0,
      }}>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: '#aaa', fontSize: '22px',
          cursor: 'pointer', padding: '2px 6px', lineHeight: 1,
        }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: '15px', fontWeight: 600 }}>
            📍 实时位置共享
            <span style={{
              marginLeft: '8px', fontSize: '11px', padding: '1px 8px', borderRadius: '10px',
              background: ended ? '#444' : '#1b5e20', color: ended ? '#999' : '#a5d6a7',
            }}>{ended ? '已结束' : '共享中'}</span>
          </div>
          <div style={{ color: '#888', fontSize: '12px', marginTop: '2px' }}>
            {participants.length} 人在共享 · 每30秒更新
            {!isAndroid && ' · 桌面端仅观看'}
          </div>
        </div>
        {iAmSharing && !ended && (
          <button onClick={handleStop} style={{
            background: '#e74c3c', color: '#fff', border: 'none', borderRadius: '8px',
            padding: '8px 16px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}>结束共享</button>
        )}
      </div>

      {/* 地图 */}
      <div ref={mapDivRef} style={{ flex: 1, minHeight: 0, background: '#1a1d24' }} />

      {/* 底部状态栏 */}
      <div style={{
        padding: '8px 14px', background: '#16181d',
        borderTop: '1px solid #2a2d35', flexShrink: 0,
        display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
      }}>
        {participants.map(([agent, p]) => (
          <span key={agent} style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            background: '#22252c', borderRadius: '10px', padding: '3px 10px',
            fontSize: '12px', color: '#ccc',
          }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: colorOf(agent), display: 'inline-block' }} />
            {fmtAgentName(agent)}{agent === myAgentId ? '(我)' : ''} · {fmtAge(p.ts)}
          </span>
        ))}
        {participants.length === 0 && (
          <span style={{ color: '#888', fontSize: '12px' }}>暂无位置数据</span>
        )}
        {joinErr && <span style={{ color: '#e74c3c', fontSize: '12px', marginLeft: 'auto' }}>{joinErr}</span>}
        {joining && !joinErr && <span style={{ color: '#888', fontSize: '12px', marginLeft: 'auto' }}>正在加入共享…</span>}
      </div>
    </div>
  )
}
