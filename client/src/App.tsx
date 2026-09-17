/**
 * 硅侣3.0 — App Entry
 *
 * 集成：登录 → IM多会话 → 场景路由
 * - 多会话管理(ConversationStore + Sidebar)
 * - 登录成功后启动客户端Agent
 * - 用户输入→agent_manager.send_message()→output_filter过滤→chat.tsx显示
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Login } from './login'
import { Chat } from './chat'
import { VoiceChat } from './voice'
import { Sidebar } from './sidebar'
import {
  Conversation,
  Message,
  loadConversations,
  saveConversations,
  createConversation,
  addMessage,
  updateLastAssistantMessage,
  deleteConversation,
  SmcpTarget,
  SmcpGroupTarget,
} from './conversation'
import { smcpInit, getMyAgentId, startPolling, stopPolling, sendMessage as smcpSendMessage, sendGroupMessage, uploadFile, SmcpMessage, taskExecute, TaskResult, listCapabilities, CapabilityInfo, taskCheckTimeouts, taskRemovePendingRemote, taskResultSend, permissionSet } from './smcp'

interface ImageAttachment {
  path: string
  name: string
  ocr_text: string | null
  ocr_status: 'pending' | 'success' | 'failed' | 'not_available' | 'no_text'
  file_size: number
  data?: string // base64 for SMCP transfer
  type?: string // mime type for SMCP transfer
}

type AppView = 'login' | 'chat' | 'voice'

const IS_DEV = import.meta.env.DEV

/**
 * US1/US2 激活门禁屏 — 未激活时唯一可见界面:
 * 账号信息 + 激活码输入 + 功能锁定清单。激活成功后由父组件解锁全部功能。
 */
const ActivationGate: React.FC<{
  accountId: string
  siliconId: string
  onActivated: (plan: string) => void
  onSwitchAccount: () => void
}> = ({ accountId, siliconId, onActivated, onSwitchAccount }) => {
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState('')
  const [msgCls, setMsgCls] = useState<'err' | 'ok' | 'info'>('info')
  const [loading, setLoading] = useState(false)
  const invoke = (window as any).__TAURI__?.core?.invoke

  const friendlyError = (e: any): string => {
    const raw = String(e?.message || e || '')
    if (raw.includes('ERR_INVALID')) return '激活码无效'
    if (raw.includes('ERR_WRONG_PRODUCT')) return '此激活码不适用于当前产品'
    if (raw.includes('ERR_EXPIRED')) return '激活码已过期'
    if (raw.includes('ERR_ALREADY_ACTIVATED')) return '账号已激活'
    if (raw.includes('ERR_FORMAT')) return '激活码格式不正确'
    if (raw.includes('auth_failed')) return '账号验证失败, 请重新登录'
    if (raw.includes('激活超时')) return raw
    if (raw.includes('未登录')) return '请先注册或登录账号后再激活'
    return raw || '激活失败, 请重试'
  }

  const handleSubmit = async () => {
    const c = code.trim()
    if (!c) { setMsg('请输入激活码'); setMsgCls('err'); return }
    if (!invoke) { setMsg('运行环境未就绪'); setMsgCls('err'); return }
    setLoading(true)
    setMsg('激活中, 请稍候...')
    setMsgCls('info')
    try {
      const resp = await invoke('account_activate', { code: c })
      // Android 适配层 resolve {plan, activated:true, tunnel:null}; 桌面 Tauri 返回同构数据
      if (resp?.tunnel) {
        try { await invoke('start_tunnel', { config: resp.tunnel }) } catch (te) {
          console.warn('[ActivationGate] tunnel start failed:', te)
        }
      }
      const plan = resp?.plan || 'basic'
      try { localStorage.setItem('siliconmate_activated', '1') } catch {}
      setMsg('激活成功 ✓')
      setMsgCls('ok')
      onActivated(plan)
    } catch (e: any) {
      setMsg(friendlyError(e))
      setMsgCls('err')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#0f1115', border: '1px solid #333',
    borderRadius: '10px', padding: '13px 16px', color: '#e6e6e6',
    fontSize: '15px', outline: 'none', marginBottom: '14px',
    boxSizing: 'border-box', letterSpacing: '1px',
  }

  const lockedItems = [
    { icon: '💬', name: '云端 AI 聊天' },
    { icon: '🦐', name: '虾群好友 / 私聊' },
    { icon: '👥', name: '群聊' },
    { icon: '🎙️', name: '语音聊天' },
    { icon: '📱', name: '远程任务执行(截图/OCR/操控)' },
  ]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', padding: '16px',
      overflowY: 'auto', background: '#0f1115', color: '#e6e6e6',
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    }}>
      <div style={{
        background: '#1a1d25', borderRadius: '16px', padding: '32px 24px',
        width: '380px', maxWidth: '100%',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}>
        <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '6px', textAlign: 'center' }}>
          🔒 需要激活
        </h1>
        <p style={{ fontSize: '13px', color: '#7a8aa0', marginBottom: '4px', textAlign: 'center' }}>
          输入 GL 激活码解锁硅侣全部能力
        </p>
        <p title={`构建 ${__BUILD_TIME__}`} style={{ fontSize: '11px', color: '#4a5568', marginBottom: '20px', textAlign: 'center' }}>
          硅侣 v{__APP_VERSION__}
        </p>

        {/* 账号信息 */}
        <div style={{
          background: '#141821', borderRadius: '10px', padding: '12px 14px',
          marginBottom: '18px', border: '1px solid #262b36',
        }}>
          <div style={{ fontSize: '12px', color: '#7a8aa0', marginBottom: '4px' }}>账号</div>
          <div style={{ fontSize: '14px', color: '#e6e6e6', marginBottom: '8px', wordBreak: 'break-all' }}>
            {accountId ? accountId.slice(0, 18) + (accountId.length > 18 ? '…' : '') : '—'}
          </div>
          <div style={{ fontSize: '12px', color: '#7a8aa0', marginBottom: '4px' }}>硅侣号 (SM-ID)</div>
          <div
            onClick={() => { if (siliconId) { try { navigator.clipboard?.writeText(siliconId) } catch {} } }}
            style={{ fontSize: '14px', color: '#4fc3f7', cursor: siliconId ? 'pointer' : 'default' }}
            title={siliconId ? '点击复制' : ''}
          >
            {siliconId || '—'}
          </div>
        </div>

        {/* 激活码输入 */}
        <input
          type="text"
          placeholder="GL-XXXX-XXXX"
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !loading && handleSubmit()}
          style={inputStyle}
          disabled={loading}
        />
        <button
          onClick={handleSubmit}
          disabled={loading}
          style={{
            width: '100%', background: loading ? '#1d3a8f' : '#2a5cff', color: '#fff',
            border: 'none', borderRadius: '10px', padding: '13px', fontSize: '16px',
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? '激活中...' : '激活'}
        </button>

        {msg && (
          <p style={{
            marginTop: '14px', fontSize: '13px', textAlign: 'center',
            color: msgCls === 'err' ? '#e74c3c' : msgCls === 'ok' ? '#2ecc71' : '#7a8aa0',
          }}>
            {msg}
          </p>
        )}

        {/* 功能锁定清单 */}
        <div style={{
          marginTop: '20px', paddingTop: '16px', borderTop: '1px solid #262b36',
        }}>
          <div style={{ fontSize: '12px', color: '#7a8aa0', marginBottom: '10px' }}>
            激活后解锁:
          </div>
          {lockedItems.map(item => (
            <div key={item.name} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '13px', color: '#8a94a6', padding: '5px 0',
            }}>
              <span>{item.icon}</span>
              <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{item.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#e67e22' }}>🔒 需要激活</span>
            </div>
          ))}
        </div>

        <button
          onClick={onSwitchAccount}
          style={{
            width: '100%', marginTop: '18px', background: 'transparent', color: '#7a8aa0',
            border: '1px solid #333', borderRadius: '10px', padding: '10px',
            fontSize: '13px', cursor: 'pointer',
          }}
        >
          切换账号
        </button>
      </div>
    </div>
  )
}

export const App: React.FC = () => {
  const [view, setView] = useState<AppView>(IS_DEV ? 'chat' : 'login')
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'thinking' | 'deep_thinking' | 'streaming' | 'error'>('idle')
  const [sessionId, setSessionId] = useState<string>('')
  const [chatgptSession, setChatgptSession] = useState<{ access_token: string; cookies: any; expires: string } | null>(null)
  const [isVoiceMode, setIsVoiceMode] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 移动端自适应：窄屏(<=480px)时侧栏变为抽屉式
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 480)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  // T015: 激活态持久化 — 重启 App 从 localStorage 恢复(登录后以服务端为准覆盖)
  const [activated, setActivated] = useState(() => {
    try { return localStorage.getItem('siliconmate_activated') === '1' } catch { return false }
  })
  const [activationPlan, setActivationPlan] = useState<string | null>(null)
  const [deepThinkProgress, setDeepThinkProgress] = useState<string>('')
  const [serverConnected, setServerConnected] = useState(false)
  const [serverConnecting, setServerConnecting] = useState(false)
  const [smcpReady, setSmcpReady] = useState(false)
  const [mySiliconId, setMySiliconId] = useState<string>('')
  const [accountName, setAccountName] = useState<string>('')
  const [taskApprovalRequest, setTaskApprovalRequest] = useState<{
    task_id: string
    from_agent: string
    capability: string
    params: any
  } | null>(null)
  // T025: 好友申请红点计数(Kotlin smcp-friend-request 事件 + Sidebar 面板回写)
  const [friendReqCount, setFriendReqCount] = useState(0)
  // T024: 好友申请系统通知点击 → 拉起好友面板信号
  const [friendsOpenSignal, setFriendsOpenSignal] = useState(0)
  const invoke = (window as any).__TAURI__?.core?.invoke
  const listen = (window as any).__TAURI__?.event?.listen

  const activeConversation = conversations.find(c => c.id === activeConvId) || null
  const activeMessages: Message[] = activeConversation?.messages || []

  // Persist conversations on change
  useEffect(() => {
    saveConversations(conversations)
  }, [conversations])

  // v4.1.1: 会话恢复 — 冷启动从localStorage读sessionId免二次登录
  // fail-open哲学: SMCP初始化失败不踢回登录页(网络波动自愈), session真失效由后续请求报错兜底
  useEffect(() => {
    if (IS_DEV) return
    let savedSid = ''
    try { savedSid = localStorage.getItem('siliconmate_session_id') || '' } catch {}
    if (!savedSid) return
    let savedSiliconId = ''
    try { savedSiliconId = localStorage.getItem('siliconmate_silicon_id') || '' } catch {}
    let savedAccName = ''
    try { savedAccName = localStorage.getItem('siliconmate_account_name') || '' } catch {}
    setSessionId(savedSid)
    if (savedSiliconId) setMySiliconId(savedSiliconId)
    if (savedAccName) setAccountName(savedAccName)
    setView('chat')
    // v4.2.1: 老会话升级补齐 — localStorage 无 account_name 时从服务端拉取
    if (!savedAccName && invoke) {
      invoke('account_info', { accountId: savedSid }).then((info: any) => {
        if (!info) return
        const an = info.account_name || ''
        const sid = info.silicon_id || ''
        if (an) { try { localStorage.setItem('siliconmate_account_name', an) } catch {} ; setAccountName(an) }
        if (sid && !savedSiliconId) { try { localStorage.setItem('siliconmate_silicon_id', sid) } catch {} ; setMySiliconId(sid) }
      }).catch((e: any) => console.warn('[硅侣] 冷启动拉取账号信息失败:', e))
    }
    smcpInit(savedSid).then(smcpOk => {
      if (!smcpOk) return
      setSmcpReady(true)
      // T023: Android Kotlin权威轮询(activated由useState从localStorage恢复)
      const NB = (window as any).NativeBridge
      if (NB?.smcpStart && getMyAgentId()) {
        try { NB.smcpStart(savedSid, getMyAgentId()) } catch (e) { console.warn('[硅侣] smcpStart failed:', e) }
      }
      startPolling((msg: SmcpMessage) => {
        handleSmcpIncomingMessage(msg)
      })
    }).catch(e => {
      console.warn('[硅侣] 会话恢复SMCP初始化失败:', e)
    })
  }, [])

  // 移动端自适应：监听窗口宽度变化
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth <= 480
      setIsMobile(mobile)
      if (!mobile) setMobileDrawerOpen(false)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Start heartbeat on login
  useEffect(() => {
    if (sessionId && invoke) {
      const interval = setInterval(async () => {
        try {
          const st = await invoke('heartbeat', { sessionId })
          if (st !== 'alive') {
            console.warn('Session stale, re-fetching...')
            await invoke('apply_session')
          }
        } catch (e) {
          console.error('Heartbeat failed:', e)
        }
      }, 30000)
      return () => clearInterval(interval)
    }
  }, [sessionId, invoke])

  // Android通知点击跳转 — 监听smcp-notification-chat事件
  useEffect(() => {
    const handler = (e: Event) => {
      const { fromUser } = (e as CustomEvent).detail
      if (!fromUser) return
      // 找到对应对话并切换
      const targetConv = conversations.find(c =>
        c.smcpTarget?.userId === fromUser || c.smcpTarget?.agentId?.includes(fromUser.slice(0, 8))
      )
      if (targetConv) {
        setActiveConvId(targetConv.id)
      }
      console.log('[硅侣] 通知跳转到对话:', fromUser)
    }
    window.addEventListener('smcp-notification-chat', handler)
    return () => window.removeEventListener('smcp-notification-chat', handler)
  }, [conversations])

  // T028/T029: 连接状态持续心跳 — 每10s健康检查, 断网→离线, 重连→恢复(FR-014)
  // Android connect_server 返回 {status, activated}; 桌面 Tauri 返回 'ok' 字符串 — 归一化处理
  useEffect(() => {
    if (view !== 'chat' || !invoke) return

    let cancelled = false
    const checkHealth = async () => {
      if (cancelled) return
      setServerConnecting(true)
      try {
        const result: any = await invoke('connect_server')
        // Android: {status:'connected'}; 桌面: 返回server_host字符串(如'locatenotify.online') — 非空即已连接
        const connected = typeof result === 'object'
          ? result?.status === 'connected'
          : typeof result === 'string' && result.length > 0
        if (!cancelled) {
          if (!connected) console.warn('[硅侣] 服务端心跳失败(离线)')
          setServerConnected(connected)
          setServerConnecting(false)
        }
      } catch {
        if (!cancelled) {
          setServerConnected(false)
          setServerConnecting(false)
        }
      }
    }

    // First check immediately, then keep polling every 10s (both states —
    // 连接成功后继续心跳以感知断网, 恢复网络后自动回到已连接)
    checkHealth()
    const interval = setInterval(checkHealth, 10000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [view, invoke])

  // US3/T017: 云端聊天历史合并 — 激活后异步拉取(fail-open), 服务端历史与本地对话去重合并
  useEffect(() => {
    if (view !== 'chat' || !invoke || !activated) return
    let cancelled = false
    ;(async () => {
      try {
        const hist = await invoke('chat_history') as {
          messages?: { role: string; text: string; time: number }[]
        }
        if (cancelled || !hist?.messages?.length) return
        const serverMsgs: Message[] = hist.messages
          .filter(m => (m.text || '').trim())
          .map((m, i) => ({
            id: `hist_${i}_${Math.floor((m.time || 0) * 1000)}`,
            role: m.role === 'user' ? 'user' as const : 'assistant' as const,
            content: m.text,
            isStreaming: false,
            timestamp: Math.floor((m.time || 0) * 1000),
          }))
        setConversations(prev => {
          // 目标: 本地 AI 对话(smcpTarget==null) — 优先已有, 无则新建"云端助手"
          const idx = prev.findIndex(c => !c.smcpTarget && !c.smcpGroupTarget)
          let conv: Conversation
          if (idx >= 0) {
            conv = prev[idx]
          } else {
            conv = {
              id: `conv_cloud_${Date.now()}`,
              title: '云端助手',
              messages: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              smcpTarget: null,
            }
          }
          // 去重合并: 本地已有相同 role+content 的消息跳过(服务端与本地双写场景)
          const localKeys = new Set(conv.messages.map(m => `${m.role}|${m.content}`))
          const serverOnly = serverMsgs.filter(m => !localKeys.has(`${m.role}|${m.content}`))
          if (!serverOnly.length) return prev
          const serverKeys = new Set(serverMsgs.map(m => `${m.role}|${m.content}`))
          const localOnly = conv.messages.filter(m => !serverKeys.has(`${m.role}|${m.content}`))
          const merged = [...serverOnly, ...localOnly].sort((a, b) => a.timestamp - b.timestamp)
          const updated = { ...conv, messages: merged, updatedAt: Date.now() }
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = updated
            return next
          }
          return [updated, ...prev]
        })
        console.log('[硅侣] 云端历史已合并:', hist.messages.length, '条')
      } catch (e) {
        console.warn('[硅侣] 云端历史加载失败(不阻塞):', e)
      }
    })()
    return () => { cancelled = true }
  }, [view, invoke, activated])

  // Check agent health when entering chat
  useEffect(() => {
    if (view === 'chat' && invoke) {
      invoke('check_agent_health').then((ok: boolean) => {
        if (!ok) {
          console.warn('[硅侣] zhipu-bridge不可用，请确认 :15731 运行中')
        }
      }).catch(console.error)
    }
  }, [view, invoke])

  // Listen for deep-think-progress events (streaming progress from AgentChat)
  useEffect(() => {
    if (!listen) return
    let unlisten: (() => void) | null = null
    listen('deep-think-progress', (event: any) => {
      const data = event.payload
      if (data?.phase === 'thinking' && data?.message) {
        setDeepThinkProgress(data.message)
      } else if (data?.phase === 'done') {
        setDeepThinkProgress('')
      } else if (data?.phase === 'started') {
        setDeepThinkProgress('深度思考启动中…')
      } else if (data?.phase === 'error') {
        setDeepThinkProgress('')
      }
    }).then((fn: () => void) => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
  }, [listen])

  // Listen for task-approval-request events (from remote task received by smcp_poll)
  useEffect(() => {
    if (!listen) return
    let unlisten: (() => void) | null = null
    listen('task-approval-request', (event: any) => {
      const data = event.payload
      if (data?.task_id && data?.capability) {
        setTaskApprovalRequest({
          task_id: data.task_id,
          from_agent: data.from_agent || '',
          capability: data.capability,
          params: data.params || {},
        })
      }
    }).then((fn: () => void) => { unlisten = fn })
    return () => { if (unlisten) unlisten() }
  }, [listen])

  const handleLoginSuccess = async (sid: string, session?: { access_token: string; cookies: any; expires: string }, isActivated?: boolean, plan?: string, siliconId?: string, accName?: string) => {
    setSessionId(sid)
    if (session) setChatgptSession(session)
    // v4.1.1: 会话持久化 — 冷启动免二次登录
    try { localStorage.setItem('siliconmate_session_id', sid) } catch {}
    if (siliconId) { try { localStorage.setItem('siliconmate_silicon_id', siliconId) } catch {} }
    if (accName) { try { localStorage.setItem('siliconmate_account_name', accName) } catch {} }
    // T015: 服务端 activated 为权威状态 — 与 localStorage 双向同步
    const serverActivated = isActivated ?? false
    setActivated(serverActivated)
    try {
      if (serverActivated) {
        localStorage.setItem('siliconmate_activated', '1')
      } else {
        localStorage.removeItem('siliconmate_activated')
      }
    } catch {}
    setActivationPlan(plan ?? null)
    if (siliconId) setMySiliconId(siliconId)
    if (accName) setAccountName(accName)

    // P0 FIX: 先渲染UI，connect_server由useEffect异步轮询(fail-open，不阻塞)
    setView('chat')

    // SMCP: 注册Agent + 启动消息轮询(异步，不阻塞)
    smcpInit(sid).then(smcpOk => {
      if (smcpOk) {
        setSmcpReady(true)
        // T023: Android 上启动 Kotlin 权威轮询服务(仅已激活 — 遵守 US1 门禁)
        const NB = (window as any).NativeBridge
        if (NB?.smcpStart && serverActivated && getMyAgentId()) {
          try { NB.smcpStart(sid, getMyAgentId()) } catch (e) { console.warn('[硅侣] smcpStart failed:', e) }
        }
        startPolling((msg: SmcpMessage) => {
          handleSmcpIncomingMessage(msg)
        })
        // 启动远程task超时检查（每5分钟检查一次）
        if (invoke) {
          const timeoutInterval = setInterval(async () => {
            try {
              const expired = await invoke('task_check_timeouts') as string[]
              if (expired && expired.length > 0) {
                console.log('[TaskEngine] 超时任务已清理:', expired)
              }
            } catch (e) {
              console.warn('[TaskEngine] 超时检查失败:', e)
            }
          }, 5 * 60 * 1000) // 5分钟
          // Store for cleanup (note: in production, would need proper cleanup)
          ;(window as any).__taskTimeoutChecker = timeoutInterval
        }
      }
    }).catch(e => {
      console.warn('[硅侣] SMCP初始化失败:', e)
    })
  }

  const handleActivate = useCallback((plan: string) => {
    setActivated(true)
    setActivationPlan(plan)
    // T023: 激活成功 → 确保 Kotlin 消息服务已启动(登录时未激活则未启动)
    const NB = (window as any).NativeBridge
    if (NB?.smcpStart && sessionId) {
      // 与 smcpInit 公式一致: A-{accountId前8位}-{role前8位}, role默认 siliconmate → siliconm
      const agentId = getMyAgentId() || `A-${sessionId.slice(0, 8)}-siliconm`
      try {
        if (!NB.smcpIsRunning || !NB.smcpIsRunning()) {
          NB.smcpStart(sessionId, agentId)
        }
      } catch (e) { console.warn('[硅侣] 激活后启动消息服务失败:', e) }
    }
  }, [sessionId])

  /** 处理远程任务审批：允许/始终允许/拒绝 */
  const handleTaskApproval = useCallback(async (action: 'allow' | 'always' | 'reject') => {
    if (!taskApprovalRequest || !invoke) return
    const { task_id, from_agent, capability, params } = taskApprovalRequest

    // 移除挂起的远程task（无论结果如何）
    await taskRemovePendingRemote(task_id)

    if (action === 'reject') {
      // 回传拒绝结果
      await taskResultSend(from_agent, '', task_id, 'rejected', {}, [], 'none', 0, '用户拒绝执行')
      setTaskApprovalRequest(null)
      return
    }

    // 始终允许 → 更新权限策略
    if (action === 'always') {
      await permissionSet(from_agent, capability, 'allow')
    }

    // 执行任务
    setTaskApprovalRequest(null)
    try {
      const result = await taskExecute(capability, params)

      // 截图转base64（如果执行了screenshot）
      let screenshots: string[] = result.screenshots || []
      if (capability === 'screenshot' && result.status === 'success') {
        if (result.data?.path) {
          try {
            const b64 = await invoke('read_file_base64', { path: result.data.path }) as string
            screenshots = [b64]
          } catch (e) {
            console.warn('[TaskApproval] screenshot base64 read failed:', e)
          }
        }
      }

      // 回传结果
      await taskResultSend(
        from_agent, '',
        task_id, result.status, result.data,
        screenshots, result.execution_tier, result.duration_ms,
        result.error_message || '',
      )
    } catch (e: any) {
      // 执行失败，回传错误
      await taskResultSend(from_agent, '', task_id, 'error', {}, [], 'none', 0, String(e))
    }
  }, [taskApprovalRequest, invoke])

  const updateConversation = useCallback((id: string, updater: (c: Conversation) => Conversation) => {
    setConversations(prev => prev.map(c => c.id === id ? updater(c) : c))
  }, [])

  /** SMCP: 打开/创建与某好友的对话 */
  const handleOpenSmcpChat = useCallback((target: { userId: string; agentId: string; role: string; myAgentId: string }) => {
    // 查找是否已有该好友的对话
    const existing = conversations.find(c =>
      c.smcpTarget && c.smcpTarget.userId === target.userId
    )
    if (existing) {
      setActiveConvId(existing.id)
      return
    }
    // 创建新SMCP对话
    const smcpTarget: SmcpTarget = {
      userId: target.userId,
      agentId: target.agentId,
      role: target.role,
      myAgentId: target.myAgentId,
    }
    const conv = createConversation(undefined, smcpTarget)
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [conversations])

  /** SMCP: 点击群聊打开群对话 */
  const handleOpenGroupChat = useCallback((groupId: string, groupName: string) => {
    const existing = conversations.find(c =>
      c.smcpGroupTarget && c.smcpGroupTarget.groupId === groupId
    )
    if (existing) {
      setActiveConvId(existing.id)
      return
    }
    const smcpGroupTarget: SmcpGroupTarget = { groupId, groupName }
    const conv = createConversation(undefined, undefined, smcpGroupTarget)
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [conversations])

  /** v4.1.1: 好友消息agent消费 — 硅侣最大亮点闭环
   * 人发来的私聊文本消息 → 云端agent代答 → 回发好友(带agent_reply标记)
   * 指令消息: agent输出[EXEC:screenshot]等标记 → 本机执行 → 结果回传
   * 防环: 对方agent代答带agent_reply:true → 不再触发对方消费(硅侣互聊死循环)
   * 防风暴: msg_id去重 + 串行锁(一次只消费一条) */
  const consumedMsgIdsRef = useRef<Set<string>>(new Set())
  const consumingRef = useRef(false)
  const consumeFriendMessage = useCallback(async (msg: SmcpMessage, text: string, fromAgentId: string) => {
    const inv = (window as any).__TAURI__?.core?.invoke
    if (!inv) return
    if (consumedMsgIdsRef.current.has(msg.msg_id)) return
    consumedMsgIdsRef.current.add(msg.msg_id)
    if (consumedMsgIdsRef.current.size > 300) consumedMsgIdsRef.current.clear()
    if (consumingRef.current) return
    consumingRef.current = true
    try {
      const senderName = msg.params?.from_name || fromAgentId.slice(0, 8)
      // 工具清单动态注入 — LLM 按清单自主选择工具, 新增能力无需改 prompt
      let toolManifest = ''
      let capNames: string[] = []
      try {
        const caps = await listCapabilities()
        ;(window as any).__TAURI__?.core?.invoke?.('js_log', { msg: `代答: listCapabilities返回${Array.isArray(caps) ? caps.length : '非数组:' + typeof caps}个` })
        if (Array.isArray(caps) && caps.length > 0) {
          const avail = caps.filter(c => c.available !== false)
          capNames = avail.map(c => String(c.name))
          toolManifest = '\n本机可用工具清单(仅可调用以下工具, 勿编造):\n'
            + avail.map(c => `- ${c.name}: ${c.description}`).join('\n')
        }
      } catch (e) { (window as any).__TAURI__?.core?.invoke?.('js_log', { msg: `代答: listCapabilities异常 ${String(e).slice(0, 80)}` }) }
      const buildPrompt = () => `【硅侣代答】好友「${senderName}」给你的主人发来消息：「${text}」
请你代主人处理这条消息。规则(必须严格遵守):
1) 纯问候/闲聊/提问 → 直接输出简短回复(80字内), 不带任何标记。
2) 任何操作请求(打开应用/截图/读文件/执行命令/剪贴板等) → 只输出一行工具调用, 格式严格为: [EXEC:{"capability":"工具名","params":{参数}}]
3) 严禁嘴上说"已打开/已执行"却不输出工具调用标记 — 不输出EXEC标记就等于什么都没做, 这是虚假承诺, 绝对禁止。
4) 工具名必须从下方清单选, params按消息语义推断(打开应用用{"app_name":"应用名"})。${toolManifest ? '' : '\n(本机当前无工具, 只能文字回复)'}

示例:
消息「打开网易云」→ 输出: [EXEC:{"capability":"app.open","params":{"app_name":"网易云"}}]
消息「帮我截个屏」→ 输出: [EXEC:{"capability":"screenshot","params":{}}]
消息「你吃了吗」→ 输出: 还没呢, 主人在忙, 我是他的硅侣数字人~${toolManifest ? '\n' + toolManifest : ''}`
      const stripWatermark = (s: string) => s.replace(/🤖\s*Generated with\s*\[?[Cc]laude[ -]?[Cc]ode\]?\s*(\([^)]*\))?/g, '').trim()
      const reply = await inv('send_message', { message: buildPrompt() }) as string
      if (!reply || typeof reply !== 'string' || !reply.trim()) return
      let finalText = stripWatermark(reply)
      ;(window as any).__TAURI__?.core?.invoke?.('js_log', { msg: `代答: LLM原始输出(${finalText.length}字): ${finalText.slice(0, 150).replace(/\n/g, ' ')}` })
      // EXEC 解析三级: JSON格式 → 旧格式[EXEC:xxx] → 裸能力名(清单内全匹配)
      const parseExec = (s: string): { capability: string; params: any } | null => {
        const jsonMatch = s.match(/\[EXEC:\s*(\{[\s\S]*?\})\s*\]/)
        if (jsonMatch) {
          try {
            const call = JSON.parse(jsonMatch[1])
            if (call?.capability) return { capability: String(call.capability).toLowerCase(), params: call.params || {} }
          } catch { /* JSON坏了走legacy */ }
        }
        const legacyMatch = s.match(/\[EXEC:([a-z_.]+)\]/i)
        if (legacyMatch) return { capability: legacyMatch[1].toLowerCase(), params: {} }
        const bare = s.trim().toLowerCase()
        if (capNames.length > 0 && capNames.some(n => n.toLowerCase() === bare)) {
          return { capability: bare, params: {} }
        }
        return null
      }
      let parsed = parseExec(finalText)
      // 兜底重试: 无EXEC但消息含操作意图词 → LLM嘴上答应的虚假承诺, 强硬重试一次
      const opIntent = /打开|开启|截屏|截图|读取|读一下|执行|运行|复制|粘贴|剪贴板|发飞书/.test(text)
      if (!parsed && opIntent && toolManifest) {
        ;(window as any).__TAURI__?.core?.invoke?.('js_log', { msg: '代答: 无EXEC但检测到操作意图, 强硬重试' })
        const retry = await inv('send_message', { message: `你上一次回复"${finalText.slice(0, 60)}"是虚假承诺 — 你没有执行任何操作, 因为回复里没有工具调用标记。这条消息是明确的操作请求, 你必须输出工具调用。

再次强调: 操作请求只允许输出一行, 格式: [EXEC:{"capability":"工具名","params":{参数}}], 严禁输出任何其他文字, 严禁再次声称"已打开/已执行"。

可用工具: ${capNames.join(' / ')}

原始消息:「${text}」
现在, 只输出那一行工具调用:` }) as string
        if (retry && typeof retry === 'string' && retry.trim()) {
          finalText = stripWatermark(retry)
          ;(window as any).__TAURI__?.core?.invoke?.('js_log', { msg: `代答: 重试输出(${finalText.length}字): ${finalText.slice(0, 120).replace(/\n/g, ' ')}` })
          parsed = parseExec(finalText)
        }
      }
      let execCapability = ''
      let execParams: any = {}
      if (parsed) { execCapability = parsed.capability; execParams = parsed.params }
      if (execCapability) {
        const capability = execCapability
        try {
          const result = await taskExecute(capability, execParams) as TaskResult
          finalText = result?.status === 'success'
            ? `✅ 已为你执行 ${capability}` + (result.data?.text ? `：${String(result.data.text).slice(0, 120)}` : (execParams?.app_name ? `（${String(execParams.app_name)}）` : '（结果已生成）'))
            : `⚠️ 执行 ${capability} 失败: ${result?.error_message || '未知原因'}`
        } catch (e: any) {
          finalText = `⚠️ 执行 ${capability} 失败: ${String(e?.message || e)}`
        }
      }
      const sendResult = await smcpSendMessage(fromAgentId, msg.from_user || '', finalText, { agent_reply: true })
      if (sendResult?.error) console.warn('[SMCP] agent reply send failed:', sendResult.error)
      // 本地对话留痕
      const agentMsg: Message = {
        id: `agent_reply_${msg.msg_id}`,
        role: 'assistant',
        content: `🤖 已代答 → ${senderName}: ${finalText}`,
        isStreaming: false,
        timestamp: Date.now(),
      }
      setConversations(prev => {
        const targetConv = prev.find(c => c.smcpTarget && c.smcpTarget.agentId === fromAgentId)
        if (!targetConv) return prev
        return prev.map(c => c.id === targetConv.id ? addMessage(c, agentMsg) : c)
      })
    } catch (e) {
      console.warn('[SMCP] consumeFriendMessage error:', e)
    } finally {
      consumingRef.current = false
    }
  }, [])

  /** SMCP: 收到中继消息，放入对应对话 */
  const handleSmcpIncomingMessage = useCallback((msg: SmcpMessage) => {
    const msgType = msg.type || msg.msg_type || 'notify'

    // Task/Result消息：特殊处理
    if (msgType === 'task') {
      // 收到远程任务请求 → 触发审批流程
      const capability = msg.params?.capability || ''
      const taskId = msg.params?.task_id || ''
      const from = msg.params?.from || msg.from_agent || ''
      setTaskApprovalRequest({
        task_id: taskId,
        from_agent: from,
        capability,
        params: msg.params?.params || {},
      })
      return // 不进入聊天UI
    }

    if (msgType === 'result') {
      // 收到远程任务结果 → 放入对应对话
      const taskId = msg.params?.task_id || ''
      const status = msg.params?.status || 'unknown'
      const data = msg.params?.data || {}
      const tier = msg.params?.execution_tier || 'unknown'
      const durationMs = msg.params?.duration_ms || 0
      const fromAgent = msg.from_agent || ''
      const screenshots = msg.params?.screenshots || []

      let resultContent = ''
      if (status === 'success') {
        resultContent = `✅ 远程任务完成 (${tier}层, ${durationMs < 1000 ? durationMs + 'ms' : (durationMs / 1000).toFixed(1) + '秒'})`
        if (data?.stdout) resultContent += `\n${data.stdout}`
        if (data?.text) resultContent += `\n${data.text}`
        if (data?.path) resultContent += `\n截图: ${data.path}`
      } else if (status === 'rejected') {
        resultContent = `🚫 远程任务被拒绝`
      } else if (status === 'timeout') {
        resultContent = `⏰ 远程任务审批超时`
      } else {
        resultContent = `❌ 远程任务失败: ${msg.params?.error_message || '未知错误'}`
      }

      const resultMsg: Message = {
        id: `result_${taskId}_${Date.now()}`,
        role: 'assistant',
        content: resultContent,
        isStreaming: false,
        timestamp: Date.now(),
        is_task_result: true,
        execution_tier: tier,
        task_status: status,
        screenshots,
        duration_ms: durationMs,
        error_message: msg.params?.error_message || undefined,
      }

      // 找到对应好友对话放入结果
      setConversations(prev => {
        const targetConv = prev.find(c =>
          c.smcpTarget && c.smcpTarget.agentId === fromAgent
        )
        if (targetConv) {
          return prev.map(c =>
            c.id === targetConv.id ? addMessage(c, resultMsg) : c
          )
        } else {
          // 创建新对话放结果
          const smcpTarget: SmcpTarget = {
            userId: '',
            agentId: fromAgent,
            role: fromAgent,
            myAgentId: '',
          }
          const conv = createConversation(undefined, smcpTarget)
          const updatedConv = addMessage(conv, resultMsg)
          return [updatedConv, ...prev]
        }
      })
      return
    }

    const fromAgentId = msg.from_agent || ''
    const groupId = msg.params?.group_id
    const text = msg.params?.text || msg.params?.content || msg.params?.message || ''
    const fileId = msg.params?.file_id
    const fileName = msg.params?.filename || fileId

    // 构建显示内容
    let displayText = ''
    if (fileId) {
      const fileUrl = `https://locatenotify.online/v1/smcp/file/download/${fileId}`
      displayText = groupId
        ? `👥 📎 [${fileName}](${fileUrl})` + (text ? `\n👥 ${text}` : '')
        : `🦐 📎 [${fileName}](${fileUrl})` + (text ? `\n🦐 ${text}` : '')
    } else {
      displayText = groupId ? `👥 ${text}` : `🦐 ${text}`
    }

    // Android推送通知
    const NB = (window as any).NativeBridge
    const notifTitle = groupId ? '👥 群聊消息' : '🦐 虾群消息'
    const notifBody = fileId ? `📎 ${fileName}` + (text ? ` - ${text.slice(0, 60)}` : '') : text.slice(0, 100)
    if (NB?.showNotification) {
      try { NB.showNotification(notifTitle, notifBody) } catch (e) { console.warn('[SMCP] showNotification error:', e) }
    }

    const botMsg: Message = {
      id: `smcp_${msg.msg_id}`,
      role: 'assistant',
      content: displayText,
      isStreaming: false,
      timestamp: Date.now(),
    }

    // 用函数式更新避免闭包过期 — 始终拿到最新conversations
    setConversations(prev => {
      const currentConvId = activeConvId  // 闭包捕获当前活跃对话ID
      // 群聊消息：找对应群对话
      if (groupId) {
        const groupConv = prev.find(c =>
          c.smcpGroupTarget && c.smcpGroupTarget.groupId === groupId
        )
        if (groupConv) {
          const isNotActive = groupConv.id !== currentConvId
          return prev.map(c => {
            if (c.id !== groupConv.id) return c
            const updated = addMessage(c, botMsg)
            if (isNotActive) updated.unreadCount = (updated.unreadCount || 0) + 1
            return updated
          })
        } else {
          // 新群对话
          const groupTarget: SmcpGroupTarget = { groupId, groupName: groupId }
          const conv = createConversation(undefined, undefined, groupTarget)
          const updatedConv = addMessage(conv, botMsg)
          updatedConv.unreadCount = 1
          return [updatedConv, ...prev]
        }
      }
      // 私聊消息
      const targetConv = prev.find(c =>
        c.smcpTarget && c.smcpTarget.agentId === fromAgentId
      )
      if (targetConv) {
        const isNotActive = targetConv.id !== currentConvId
        return prev.map(c => {
          if (c.id !== targetConv.id) return c
          const updated = addMessage(c, botMsg)
          if (isNotActive) updated.unreadCount = (updated.unreadCount || 0) + 1
          return updated
        })
      } else {
        const smcpTarget: SmcpTarget = {
          userId: '',
          agentId: fromAgentId,
          role: fromAgentId,
          myAgentId: '',
        }
        const conv = createConversation(undefined, smcpTarget)
        const updatedConv = addMessage(conv, botMsg)
        return [updatedConv, ...prev]
      }
    })

    // v4.1.1: 人发来的私聊文本消息 → agent自动消费代答(硅侣最大亮点);
    // 群聊/文件/agent_reply消息不触发, 防环防风暴见consumeFriendMessage
    if (!groupId && !fileId && text && msg.params?.agent_reply !== true) {
      consumeFriendMessage(msg, text, fromAgentId)
    }
  }, [consumeFriendMessage])

  // T023: Android Kotlin 推送通道 — 消息与远程任务审批事件接线
  useEffect(() => {
    const onNativeMessages = (e: Event) => {
      const msgs = (e as CustomEvent).detail?.messages as SmcpMessage[]
      if (Array.isArray(msgs)) {
        msgs.forEach(m => handleSmcpIncomingMessage(m))
      }
    }
    const onTaskRequest = (e: Event) => {
      const task = (e as CustomEvent).detail?.task
      if (task && task.task_id) {
        setTaskApprovalRequest({
          task_id: task.task_id,
          from_agent: task.from_agent || '',
          capability: task.capability || '',
          params: task.params || {},
        })
      } else {
        // task=null: 任务已超时/已处理 → 关闭审批弹窗
        setTaskApprovalRequest(null)
      }
    }
    window.addEventListener('smcp-native-messages', onNativeMessages)
    window.addEventListener('smcp-task-request', onTaskRequest)
    // T024/T025: 好友申请事件 — Kotlin 后台轮询红点 + 系统通知点击拉起面板
    const onFriendRequest = (e: Event) => {
      setFriendReqCount((e as CustomEvent).detail?.count || 0)
    }
    const onOpenFriends = () => {
      // 移动端好友面板在抽屉侧栏内 — 信号到达时确保抽屉可见
      if (window.innerWidth <= 480) setMobileDrawerOpen(true)
      setFriendsOpenSignal(s => s + 1)
    }
    window.addEventListener('smcp-friend-request', onFriendRequest)
    window.addEventListener('smcp-open-friends', onOpenFriends)
    return () => {
      window.removeEventListener('smcp-native-messages', onNativeMessages)
      window.removeEventListener('smcp-task-request', onTaskRequest)
      window.removeEventListener('smcp-friend-request', onFriendRequest)
      window.removeEventListener('smcp-open-friends', onOpenFriends)
    }
  }, [handleSmcpIncomingMessage])

  // T026: 主界面好友入口 — 打开好友面板(移动端先拉出抽屉)
  const handleOpenFriendsPanel = useCallback(() => {
    if (window.innerWidth <= 480) setMobileDrawerOpen(true)
    setFriendsOpenSignal(s => s + 1)
  }, [])

  const handleNewConversation = useCallback(() => {
    const conv = createConversation()
    setConversations(prev => [conv, ...prev])
    setActiveConvId(conv.id)
  }, [])

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConvId(id)
    // 切换对话时清零未读数
    setConversations(prev => prev.map(c =>
      c.id === id ? { ...c, unreadCount: 0 } : c
    ))
  }, [])

  const handleDeleteConversation = useCallback((id: string) => {
    setConversations(prev => deleteConversation(prev, id))
    if (activeConvId === id) {
      setActiveConvId(null)
    }
  }, [activeConvId])

  const handleSendMessage = useCallback(async (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean, mentions?: string[], taskCapability?: string, taskParams?: any) => {
    if (!text.trim() && (!attachments || attachments.length === 0)) return

    let convId = activeConvId
    if (!convId) {
      const conv = createConversation(text.trim())
      convId = conv.id
      setConversations(prev => [conv, ...prev])
      setActiveConvId(convId)
    }

    // 检查是否SMCP对话
    const currentConv = conversations.find(c => c.id === convId)
    const smcpTarget = currentConv?.smcpTarget
    const smcpGroupTarget = currentConv?.smcpGroupTarget

    let displayContent = text
    if (attachments && attachments.length > 0) {
      const fileNames = attachments.map(a => a.name).join(', ')
      if (text.trim()) {
        displayContent = `📷 ${fileNames}\n${text}`
      } else {
        displayContent = `📷 ${fileNames}`
      }
    }

    const userMsg: Message = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: displayContent,
      isStreaming: false,
      timestamp: Date.now(),
    }
    updateConversation(convId, c => addMessage(c, userMsg))

    // --- SMCP群聊: 走群消息API ---
    if (smcpGroupTarget) {
      setStatus('thinking')
      try {
        // 如果有附件，先读文件转base64再上传
        let fileParams: any = {}
        if (attachments && attachments.length > 0) {
          const att = attachments[0]
          let base64Data = att.data
          if (!base64Data && att.path) {
            try {
              const inv = (window as any).__TAURI__?.invoke
              if (inv) {
                const readResult = await inv('read_file_base64', { path: att.path })
                base64Data = readResult
              }
            } catch (e) { console.warn('[SMCP] read file base64 failed:', e) }
          }
          if (base64Data) {
            const uploadResult = await uploadFile(att.name, base64Data, att.type || 'image/png')
            if (uploadResult.ok && uploadResult.file_id) {
              fileParams = { file_id: uploadResult.file_id, filename: uploadResult.filename, file_size: uploadResult.size }
            }
          }
        }
        const result = await sendGroupMessage(smcpGroupTarget.groupId, { content: text, ...fileParams, ...(mentions && mentions.length > 0 ? { mentions } : {}) })
        if (result?.error) {
          const errMsg: Message = {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 发送失败: ${result.error}`,
            isStreaming: false,
            timestamp: Date.now(),
          }
          updateConversation(convId, c => addMessage(c, errMsg))
        }
        setStatus('idle')
        return
      } catch (e) {
        setStatus('idle')
        return
      }
    }

    // --- SMCP对话: 走消息中继 ---
    if (smcpTarget) {
      setStatus('thinking')
      try {
        // 如果有附件，先读文件转base64再上传
        let fileParams: any = {}
        if (attachments && attachments.length > 0) {
          const att = attachments[0]
          let base64Data = att.data
          if (!base64Data && att.path) {
            try {
              const inv = (window as any).__TAURI__?.invoke
              if (inv) {
                const readResult = await inv('read_file_base64', { path: att.path })
                base64Data = readResult
              }
            } catch (e) { console.warn('[SMCP] read file base64 failed:', e) }
          }
          if (base64Data) {
            const uploadResult = await uploadFile(att.name, base64Data, att.type || 'image/png')
            if (uploadResult.ok && uploadResult.file_id) {
              fileParams = { file_id: uploadResult.file_id, filename: uploadResult.filename, file_size: uploadResult.size }
            }
          }
        }
        const result = await smcpSendMessage(
          smcpTarget.agentId,
          smcpTarget.userId,
          text,
          fileParams
        )
        if (result?.error) {
          const errMsg: Message = {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 发送失败: ${result.error}`,
            isStreaming: false,
            timestamp: Date.now(),
          }
          updateConversation(convId, c => addMessage(c, errMsg))
        }
        // 消息已发出，对方回复由poll轮询回来
        setStatus('idle')
      } catch (e: any) {
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 发送失败: ${String(e)}`,
          isStreaming: false,
          timestamp: Date.now(),
        }
        updateConversation(convId, c => addMessage(c, errMsg))
        setStatus('error')
      }
      return
    }

    // --- 本地AI对话: 原有逻辑 ---

    // 检查是否是Agent指令（task_capability由chat.tsx检测后传入）
    if (taskCapability && invoke) {
      setStatus('thinking')

      // "你能做什么"指令特殊处理
      if (taskCapability === 'list_capabilities') {
        try {
          const caps = await invoke('task_list_capabilities') as CapabilityInfo[]
          const grouped = {
            native: caps.filter(c => c.tier === 'native' && c.available),
            nuphus: caps.filter(c => c.tier === 'nuphus' && c.available),
            fallback: caps.filter(c => c.tier === 'fallback' && c.available),
          }
          let response = '🦐 我的本机能力：\n\n'
          if (grouped.native.length > 0) {
            response += '⚡ 原生直通（秒级响应）：\n'
            grouped.native.forEach(c => { response += `  • ${c.name} — ${c.description}\n` })
            response += '\n'
          }
          if (grouped.nuphus.length > 0) {
            response += '🤖 Nuphus引擎（需模型）：\n'
            grouped.nuphus.forEach(c => { response += `  • ${c.name} — ${c.description}\n` })
            response += '\n'
          }
          if (grouped.fallback.length > 0) {
            response += '⚠️ 降级命令（Nuphus不可用时）：\n'
            grouped.fallback.forEach(c => { response += `  • ${c.name} — ${c.description}\n` })
          }
          const botMsg: Message = {
            id: `bot_${Date.now()}`,
            role: 'assistant',
            content: response,
            isStreaming: false,
            timestamp: Date.now(),
            is_task_result: true,
            execution_tier: 'native',
            task_status: 'success',
          }
          updateConversation(convId!, c => addMessage(c, botMsg))
        } catch (e: any) {
          const errMsg: Message = {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 查询能力失败: ${String(e)}`,
            isStreaming: false,
            timestamp: Date.now(),
          }
          updateConversation(convId!, c => addMessage(c, errMsg))
        }
        setStatus('idle')
        return
      }

      // 执行task
      try {
        const result = await invoke('task_execute', {
          capability: taskCapability,
          params: taskParams || {},
        }) as TaskResult

        let content = ''
        if (result.status === 'success') {
          if (taskCapability === 'screenshot') content = '已截屏'
          else if (taskCapability === 'app.open') content = `已打开 ${taskParams?.app_name || '应用'}`
          else if (taskCapability === 'file.read') content = result.data?.content || '文件已读取'
          else if (taskCapability === 'shell.exec') content = result.data?.stdout || '命令已执行'
          else if (taskCapability === 'ocr') content = result.data?.text || 'OCR完成'
          else content = '执行成功'
        } else {
          content = result.error_message || '执行失败'
        }

        const botMsg: Message = {
          id: `bot_${Date.now()}`,
          role: 'assistant',
          content,
          isStreaming: false,
          timestamp: Date.now(),
          is_task_result: true,
          execution_tier: result.execution_tier,
          task_status: result.status,
          screenshots: result.screenshots,
          duration_ms: result.duration_ms,
          error_message: result.error_message || undefined,
        }
        updateConversation(convId!, c => addMessage(c, botMsg))
        setStatus('idle')
      } catch (e: any) {
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 执行失败: ${String(e)}`,
          isStreaming: false,
          timestamp: Date.now(),
          is_task_result: true,
          execution_tier: 'none',
          task_status: 'error',
        }
        updateConversation(convId!, c => addMessage(c, errMsg))
        setStatus('error')
      }
      return
    }

    let ocrContext: string | undefined
    if (attachments && attachments.length > 0) {
      const ocrParts: string[] = []
      for (const att of attachments) {
        if (att.ocr_status === 'success' && att.ocr_text) {
          ocrParts.push(`[用户上传了图片: ${att.name}]\n[图片文字识别结果]:\n${att.ocr_text}`)
        } else {
          ocrParts.push(`[用户上传了图片: ${att.name}，但文字识别未成功，请根据文件名和类型分析]`)
        }
      }
      ocrContext = ocrParts.join('\n\n')
    }

    setStatus('thinking')

    if (invoke) {
      try {
        const routeResult = await invoke('route_message', {
          message: text || '请分析上传的图片',
          attachments: attachments?.map(f => f.name) || [],
          sceneState: {
            voice_chat_active: false,
            deep_think_requested: deepThink || false,
            visual_analysis_requested: false,
            feishu_output_requested: feishuOutput || false,
          },
          serverAvailable: serverConnected,
        }) as any

        let response: string

        if (routeResult?.FeishuOutput) {
          const agent = routeResult.FeishuOutput.agent || 'glm_daily'
          if (agent === 'agentchat') {
            setStatus('deep_thinking')
            response = await invoke('call_server_deep_think', { prompt: text, skill: 'oneweb' }) as string
          } else if (agent === 'office_cli') {
            setStatus('deep_thinking')
            response = await invoke('call_server_office', {
              filePath: attachments?.[0]?.path || '',
              operation: 'document import',
            }) as string
          } else {
            response = await invoke('send_message', {
              message: text,
              ocrContext: ocrContext || null,
            }) as string
          }
          try {
            await invoke('feishu_create_doc', { title: '硅侣输出', content: response })
            response += '\n\n✅ 已输出到飞书文档'
          } catch (fe: any) {
            response += `\n\n⚠️ 飞书输出失败: ${String(fe)}`
          }
        } else if (routeResult?.ServerAgent) {
          const tool = routeResult.ServerAgent.tool
          if (tool === 'server_deep_think') {
            setStatus('deep_thinking')
            response = await invoke('call_server_deep_think', { prompt: text, skill: null }) as string
          } else if (tool === 'server_office_read') {
            setStatus('deep_thinking')
            response = await invoke('call_server_office', {
              filePath: attachments?.[0]?.path || '',
              operation: 'document import',
            }) as string
          } else {
            setStatus('deep_thinking')
            response = await invoke('call_server_agent', { prompt: text }) as string
          }
        } else if (routeResult?.ClientAgentWithDegradation) {
          const reason = routeResult.ClientAgentWithDegradation.reason || ''
          response = await invoke('send_message', {
            message: text,
            ocrContext: ocrContext || null,
          }) as string
          response = `⚠️ ${reason}\n\n${response}`
        } else if (routeResult?.ObscuraBridge) {
          response = '语音聊天模式已激活'
        } else if (routeResult?.TaskRoute) {
          // Task路由：执行Agent能力
          const capability = routeResult.TaskRoute.capability || ''
          setStatus('thinking')
          try {
            // 构建task params
            let taskParams: any = {}
            if (capability === 'app.open') {
              const appName = text.replace(/打开|开启|启动/gi, '').trim()
              taskParams = { app_name: appName }
            } else if (capability === 'shell.exec') {
              const cmdMatch = text.match(/(?:执行|运行|跑一下)\s*(.+)/)
              taskParams = { command: cmdMatch ? cmdMatch[1].trim() : text }
            } else if (capability === 'file.read') {
              const pathMatch = text.match(/读(?:取)?文件?\s*(.+)/)
              taskParams = { path: pathMatch ? pathMatch[1].trim() : '' }
            }

            const result = await invoke('task_execute', {
              capability,
              params: taskParams,
            }) as TaskResult

            if (result.status === 'success') {
              if (capability === 'screenshot') response = '已截屏'
              else if (capability === 'app.open') response = `已打开 ${taskParams.app_name || '应用'}`
              else if (capability === 'file.read') response = result.data?.content || '文件已读取'
              else if (capability === 'shell.exec') response = result.data?.stdout || '命令已执行'
              else response = '执行成功'
            } else {
              response = result.error_message || '执行失败'
            }

            // Add as task result message with tier info
            const taskBotMsg: Message = {
              id: `bot_${Date.now()}`,
              role: 'assistant',
              content: response,
              isStreaming: false,
              timestamp: Date.now(),
              is_task_result: true,
              execution_tier: result.execution_tier,
              task_status: result.status,
              screenshots: result.screenshots,
              duration_ms: result.duration_ms,
              error_message: result.error_message || undefined,
            }
            updateConversation(convId!, c => addMessage(c, taskBotMsg))
            setStatus('idle')
            return // skip the generic bot message below
          } catch (e: any) {
            response = `⚠️ 执行失败: ${String(e)}`
          }
        } else if (routeResult?.ShrimpAgent) {
          const agentId = routeResult.ShrimpAgent.agent_id || 'goutou'
          const task = routeResult.ShrimpAgent.task || text
          try {
            const hubResp = await fetch('http://127.0.0.1:4196/jsonrpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'dispatch',
                params: { target_agent: agentId, task, sender: 'siliconmate' },
                id: 1,
              }),
            })
            if (hubResp.ok) {
              const hubData = await hubResp.json()
              response = hubData?.result?.response || `已派发给${agentId}，等待回复…`
            } else {
              response = `⚠️ 虾群Hub不可用(${hubResp.status})，任务: ${task}`
            }
          } catch {
            response = `⚠️ 虾群Hub未连接，请确认A2A Hub(:4196)运行中。任务: ${task}`
          }
        } else {
          const messageToSend = text || '请分析上传的图片内容'
          response = await invoke('send_message', {
            message: messageToSend,
            ocrContext: ocrContext || null,
          }) as string
        }

        const botMsg: Message = {
          id: `bot_${Date.now()}`,
          role: 'assistant',
          content: response || '(无回复)',
          isStreaming: false,
          timestamp: Date.now(),
        }
        updateConversation(convId, c => addMessage(c, botMsg))
        setStatus('idle')
      } catch (e: any) {
        console.error('Send message error:', e)
        const errMsg: Message = {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ 错误: ${String(e)}`,
          isStreaming: false,
          timestamp: Date.now(),
        }
        updateConversation(convId, c => addMessage(c, errMsg))
        setStatus('error')
      }
    } else {
      setStatus('streaming')
      const botMsg: Message = {
        id: `bot_${Date.now()}`,
        role: 'assistant',
        content: '',
        isStreaming: true,
        timestamp: Date.now(),
      }
      updateConversation(convId, c => addMessage(c, botMsg))

      const demoText = '这是硅侣3.0的演示回复。在Tauri2环境中，此消息将由GLM-4-Flash生成。'
      let i = 0
      const cid = convId
      const interval = setInterval(() => {
        if (i < demoText.length) {
          updateConversation(cid, c => updateLastAssistantMessage(c, demoText.slice(0, i + 1), i < demoText.length - 1))
          i++
        } else {
          clearInterval(interval)
          setStatus('idle')
        }
      }, 50)
    }
  }, [invoke, activeConvId, updateConversation])

  const handleVoiceChat = useCallback(() => {
    setIsVoiceMode(prev => !prev)
    if (!isVoiceMode) {
      setView('voice')
    }
  }, [isVoiceMode])

  const handleVoiceBack = useCallback(() => {
    setIsVoiceMode(false)
    setView('chat')
  }, [])

  /** T018: 发送失败后一键重试 — 重发当前会话最后一条用户消息(纯文本, 附件需重新添加) */
  const handleRetryLast = useCallback(() => {
    setStatus('idle')
    const conv = conversations.find(c => c.id === activeConvId)
    const lastUser = conv ? [...conv.messages].reverse().find(m => m.role === 'user') : null
    if (!lastUser) return
    // 去掉显示用的附件前缀行(📷 xxx.png) — 云端重试仅重发文本部分
    const text = lastUser.content.replace(/^📷[^\n]*/, '').trim()
    if (text) handleSendMessage(text)
  }, [conversations, activeConvId, handleSendMessage])

  if (view === 'login') {
    return (
      <Login
        onLoginSuccess={handleLoginSuccess}
      />
    )
  }

  if (view === 'voice') {
    return (
      <VoiceChat
        onBack={handleVoiceBack}
        sessionId={sessionId}
        chatgptSession={chatgptSession || undefined}
      />
    )
  }

  // ===== US1 激活门禁: 未激活只见账号信息+激活入口, 其余功能全锁定 =====
  if (!activated) {
    return (
      <ActivationGate
        accountId={sessionId}
        siliconId={mySiliconId}
        onActivated={(plan) => { handleActivate(plan) }}
        onSwitchAccount={() => {
          try { stopPolling() } catch {}
          // T023: 停止 Kotlin 消息服务(登出后不再轮询)
          const NB = (window as any).NativeBridge
          try { NB?.smcpStop?.() } catch {}
          try { localStorage.removeItem('siliconmate_activated') } catch {}
          try { localStorage.removeItem('siliconmate_session_id') } catch {}
          try { localStorage.removeItem('siliconmate_silicon_id') } catch {}
          try { localStorage.removeItem('siliconmate_account_name') } catch {}
          setAccountName('')
          setSessionId('')
          setActivated(false)
          setActivationPlan(null)
          setSmcpReady(false)
          setView('login')
        }}
      />
    )
  }

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      {/* 桌面端：侧栏内联 */}
      {!isMobile && (
        <Sidebar
          conversations={conversations}
          activeId={activeConvId}
          onSelect={handleSelectConversation}
          onNew={handleNewConversation}
          onDelete={handleDeleteConversation}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
          activated={activated}
          plan={activationPlan}
          onActivate={handleActivate}
          onOpenSmcpChat={handleOpenSmcpChat}
          onOpenGroupChat={handleOpenGroupChat}
          accountId={sessionId}
          mySiliconId={mySiliconId}
          accountName={accountName}
          pendingFriendCount={friendReqCount}
          onPendingFriendCountChange={setFriendReqCount}
          openFriendsSignal={friendsOpenSignal}
        />
      )}
      {/* 移动端：抽屉式侧栏（点遮罩/选中会话自动关闭） */}
      {isMobile && mobileDrawerOpen && (
        <>
          <div
            onClick={() => setMobileDrawerOpen(false)}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.6)', zIndex: 9998,
            }}
          />
          <div style={{
            position: 'fixed', top: 0, left: 0, bottom: 0,
            width: '240px', zIndex: 9999,
            boxShadow: '4px 0 24px rgba(0,0,0,0.55)',
          }}>
            <Sidebar
              conversations={conversations}
              activeId={activeConvId}
              onSelect={(id) => { handleSelectConversation(id); setMobileDrawerOpen(false) }}
              onNew={() => { handleNewConversation(); setMobileDrawerOpen(false) }}
              onDelete={handleDeleteConversation}
              collapsed={false}
              onToggleCollapse={() => setMobileDrawerOpen(false)}
              activated={activated}
              plan={activationPlan}
              onActivate={handleActivate}
              onOpenSmcpChat={(t) => { handleOpenSmcpChat(t); setMobileDrawerOpen(false) }}
              onOpenGroupChat={(g, n) => { handleOpenGroupChat(g, n); setMobileDrawerOpen(false) }}
              accountId={sessionId}
              mySiliconId={mySiliconId}
              accountName={accountName}
              pendingFriendCount={friendReqCount}
              onPendingFriendCountChange={setFriendReqCount}
              openFriendsSignal={friendsOpenSignal}
            />
          </div>
        </>
      )}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minWidth: 0 }}>
        {/* 移动端汉堡按钮呼出抽屉 */}
        {isMobile && (
          <button
            onClick={() => setMobileDrawerOpen(true)}
            title="菜单"
            style={{
              position: 'absolute', top: '8px', left: '8px', zIndex: 100,
              width: '34px', height: '34px', borderRadius: '8px',
              background: 'rgba(42,42,58,0.92)', color: '#e6e6e6',
              border: 'none', fontSize: '16px', cursor: 'pointer',
            }}
          >
            ≡
          </button>
        )}
        {/* T026: 主界面虾群好友入口(FR-013 — 非仅抽屉; 桌面侧栏入口保留) */}
        <button
          onClick={handleOpenFriendsPanel}
          title="虾群好友"
          style={{
            position: 'absolute', top: '8px', left: isMobile ? '48px' : '8px', zIndex: 100,
            width: '34px', height: '34px', borderRadius: '8px',
            background: 'rgba(42,42,58,0.92)', color: '#e6e6e6',
            border: 'none', fontSize: '16px', cursor: 'pointer',
          }}
        >
          🦐
          {friendReqCount > 0 && (
            <span style={{
              position: 'absolute', top: '-4px', right: '-4px',
              background: '#e74c3c', color: '#fff', borderRadius: '8px',
              fontSize: '10px', padding: '1px 4px', lineHeight: 1,
              minWidth: '14px', textAlign: 'center',
            }}>{friendReqCount}</span>
          )}
        </button>
        <Chat
          onSendMessage={handleSendMessage}
          onVoiceChat={handleVoiceChat}
          status={status}
          deepThinkProgress={deepThinkProgress}
          serverConnected={serverConnected}
          serverConnecting={serverConnecting}
          activated={activated}
          messages={activeMessages}
          isVoiceMode={isVoiceMode}
          smcpTarget={activeConversation?.smcpTarget}
          smcpGroupTarget={activeConversation?.smcpGroupTarget}
          myUserId={sessionId}
          onRetryLast={handleRetryLast}
        />
      </div>
      {/* 远程任务审批弹窗 */}
      {taskApprovalRequest && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            background: '#1e1e2e',
            borderRadius: '12px',
            padding: '24px',
            minWidth: '360px',
            maxWidth: '480px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            border: '1px solid #333',
          }}>
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#fff', marginBottom: '12px' }}>
              🔔 远程任务请求
            </div>
            <div style={{ fontSize: '14px', color: '#ccc', marginBottom: '8px' }}>
              来自 <span style={{ color: '#4fc3f7', fontWeight: 600 }}>{taskApprovalRequest.from_agent}</span> 的请求
            </div>
            <div style={{
              background: '#2a2a3a',
              borderRadius: '8px',
              padding: '12px',
              marginBottom: '16px',
            }}>
              <div style={{ fontSize: '13px', color: '#aaa', marginBottom: '4px' }}>请求操作</div>
              <div style={{ fontSize: '15px', color: '#fff', fontWeight: 500 }}>
                {taskApprovalRequest.capability === 'screenshot' ? '📸 截取屏幕' :
                 taskApprovalRequest.capability === 'app.open' ? `📱 打开应用 ${taskApprovalRequest.params?.app_name || ''}` :
                 taskApprovalRequest.capability === 'file.read' ? `📄 读取文件 ${taskApprovalRequest.params?.path || ''}` :
                 taskApprovalRequest.capability === 'shell.exec' ? `💻 执行命令 ${taskApprovalRequest.params?.command || ''}` :
                 taskApprovalRequest.capability === 'ocr' ? '🔍 OCR识别' :
                 taskApprovalRequest.capability === 'device_control' ? `🕹️ 屏幕操控(${taskApprovalRequest.params?.action || 'tap'})` :
                 `🔧 ${taskApprovalRequest.capability}`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleTaskApproval('reject')}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: '1px solid #555',
                  background: '#333',
                  color: '#e74c3c',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                拒绝
              </button>
              <button
                onClick={() => handleTaskApproval('allow')}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#2a5cff',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                本次允许
              </button>
              <button
                onClick={() => handleTaskApproval('always')}
                style={{
                  padding: '8px 20px',
                  borderRadius: '6px',
                  border: 'none',
                  background: '#4CAF50',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '14px',
                }}
              >
                始终允许
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
