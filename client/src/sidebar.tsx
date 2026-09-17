import React, { useState, useEffect } from 'react'
import { Conversation, getConversationDisplay } from './conversation'
import {
  getFriends,
  getPendingRequests,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriend,
  lookupSiliconId,
  SmcpFriend,
  SmcpPendingRequest,
  ping as smcpPing,
  getGroups,
  createGroup,
  sendGroupMessage,
  inviteToGroup,
  SmcpGroup,
  formatTime,
} from './smcp'

interface SmcpConversationTarget {
  userId: string
  agentId: string
  role: string
  myAgentId: string
}

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  activated: boolean
  plan: string | null
  onActivate: (plan: string) => void
  /** SMCP: 点击好友创建/选中SMCP对话 */
  onOpenSmcpChat: (target: SmcpConversationTarget) => void
  /** SMCP: 点击群聊打开群对话 */
  onOpenGroupChat: (groupId: string, groupName: string) => void
  /** 当前登录用户ID(用于SMCP) */
  accountId?: string
  /** 当前用户硅侣号 */
  mySiliconId?: string
  /** 当前登录用户名(注册时设置) — 显示在侧栏头部，便于多账号辨识 */
  accountName?: string
  /** v4.3.0: 修改用户名成功后回传 App 同步全局 accountName */
  onAccountNameChange?: (name: string) => void
  /** T025: 待处理好友申请数(红点数据源 — Kotlin 后台轮询事件 + 面板内操作回写) */
  pendingFriendCount?: number
  /** T025: 面板内申请列表变化时回写 App 全局红点状态 */
  onPendingFriendCountChange?: (n: number) => void
  /** T024/T025: 好友申请通知点击信号(递增计数 → 打开好友面板) */
  openFriendsSignal?: number
}

export const Sidebar: React.FC<SidebarProps> = ({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  collapsed,
  onToggleCollapse,
  activated,
  plan,
  onActivate,
  onOpenSmcpChat,
  onOpenGroupChat,
  accountId,
  mySiliconId,
  accountName,
  onAccountNameChange,
  pendingFriendCount = 0,
  onPendingFriendCountChange,
  openFriendsSignal = 0,
}) => {
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [showActivateModal, setShowActivateModal] = useState(false)
  const [activateCode, setActivateCode] = useState('')
  const [activateMsg, setActivateMsg] = useState('')
  const [activateLoading, setActivateLoading] = useState(false)
  // 修改密码 (v4.2.2)
  const [showPwdModal, setShowPwdModal] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [newPwd2, setNewPwd2] = useState('')
  const [pwdChanging, setPwdChanging] = useState(false)
  const [pwdMsg, setPwdMsg] = useState('')
  // 账号菜单 + 修改用户名 (v4.3.0)
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const [showUsernameModal, setShowUsernameModal] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [nameVerifyPwd, setNameVerifyPwd] = useState('')
  const [usernameChanging, setUsernameChanging] = useState(false)
  const [usernameMsg, setUsernameMsg] = useState('')

  // SMCP state
  const [showSmcpPanel, setShowSmcpPanel] = useState(false)
  const [smcpFriends, setSmcpFriends] = useState<SmcpFriend[]>([])
  const [smcpRequests, setSmcpRequests] = useState<SmcpPendingRequest[]>([])
  const [smcpRelayOk, setSmcpRelayOk] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [addFriendId, setAddFriendId] = useState('')
  const [addFriendMsg, setAddFriendMsg] = useState('')
  const [smcpGroups, setSmcpGroups] = useState<SmcpGroup[]>([])
  const [createGroupName, setCreateGroupName] = useState('')
  const [selectedFriendIds, setSelectedFriendIds] = useState<Set<string>>(new Set())
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [inviteGroupId, setInviteGroupId] = useState<string | null>(null)
  const [inviteSelectedIds, setInviteSelectedIds] = useState<Set<string>>(new Set())

  const invoke = (window as any).__TAURI__?.core?.invoke
  const listen = (window as any).__TAURI__?.event?.listen

  // 视觉引擎设置 (v4.2.0)
  const [showVisionModal, setShowVisionModal] = useState(false)
  const [visionStatus, setVisionStatus] = useState<any>(null)
  const [visionOcrEngine, setVisionOcrEngine] = useState('auto')
  const [visionApiUrl, setVisionApiUrl] = useState('')
  const [visionApiKey, setVisionApiKey] = useState('')
  const [visionApiModel, setVisionApiModel] = useState('')
  const [visionSaveMsg, setVisionSaveMsg] = useState('')
  const [visionDownloading, setVisionDownloading] = useState(false)
  const [visionProgress, setVisionProgress] = useState('')

  // 打开面板时拉取状态
  useEffect(() => {
    if (showVisionModal) {
      setVisionSaveMsg('')
      invoke?.('vision_engine_status').then((s: any) => {
        setVisionStatus(s)
        setVisionOcrEngine(s?.config?.ocrEngine || 'auto')
        setVisionApiUrl(s?.config?.apiUrl || '')
        setVisionApiModel(s?.config?.apiModel || '')
        setVisionApiKey('')
        setVisionDownloading(!!s?.models?.downloading)
      })
    }
  }, [showVisionModal])

  // 下载进度事件流
  useEffect(() => {
    if (!listen || !showVisionModal) return
    let unlisten: (() => void) | null = null
    listen('vision:download', (event: any) => {
      const p = event.payload
      if (p.kind === 'progress') {
        const pct = p.total > 0 ? Math.round((p.downloaded / p.total) * 100) : 0
        const mb = (p.downloaded / 1024 / 1024).toFixed(1)
        setVisionProgress(`(${p.index}/${p.count}) ${p.file} ${pct > 0 ? pct + '%' : mb + 'MB'}`)
      } else if (p.kind === 'done') {
        setVisionDownloading(false)
        setVisionProgress('')
        setVisionSaveMsg('模型下载完成 ✓')
        invoke?.('vision_engine_status').then(setVisionStatus)
      } else if (p.kind === 'error') {
        setVisionDownloading(false)
        setVisionProgress('')
        setVisionSaveMsg('下载失败: ' + (p.message || '未知错误'))
      }
    }).then((fn: () => void) => { unlisten = fn })
    return () => { unlisten?.() }
  }, [listen, showVisionModal])

  const saveVisionConfig = async () => {
    try {
      const r = await invoke?.('vision_engine_set', {
        ocrEngine: visionOcrEngine,
        apiUrl: visionApiUrl,
        apiKey: visionApiKey.trim() ? visionApiKey : undefined,
        apiModel: visionApiModel,
      })
      if (r?.ok) {
        setVisionSaveMsg('已保存 ✓')
        setVisionApiKey('')
        setTimeout(() => setVisionSaveMsg(''), 2500)
        invoke?.('vision_engine_status').then(setVisionStatus)
      }
    } catch (e: any) {
      setVisionSaveMsg('保存失败: ' + String(e))
    }
  }

  const startVisionDownload = async () => {
    try {
      await invoke?.('vision_models_download')
      setVisionDownloading(true)
      setVisionSaveMsg('')
    } catch (e: any) {
      setVisionSaveMsg(String(e))
    }
  }

  // Load SMCP data when panel opens
  useEffect(() => {
    if (showSmcpPanel && accountId) {
      smcpPing().then(setSmcpRelayOk)
      getFriends().then(setSmcpFriends)
      getGroups().then(setSmcpGroups)
      getPendingRequests().then(list => {
        setSmcpRequests(list)
        // T025: 面板打开即校准全局红点计数
        onPendingFriendCountChange?.(list.length)
      })
    }
  }, [showSmcpPanel, accountId])

  // T024/T025: 好友申请系统通知点击 → 拉起好友面板
  const lastSignalRef = React.useRef(openFriendsSignal)
  useEffect(() => {
    if (openFriendsSignal > 0 && openFriendsSignal !== lastSignalRef.current) {
      lastSignalRef.current = openFriendsSignal
      setShowSmcpPanel(true)
    }
  }, [openFriendsSignal])

  // T025: 红点 = 全局事件计数(Kotlin后台轮询) 与 面板内实时列表 取大者
  const friendBadge = Math.max(pendingFriendCount, showSmcpPanel ? smcpRequests.length : 0)

  // 修改密码提交 (v4.2.2)
  const handleChangePassword = async () => {
    if (!oldPwd || !newPwd || !newPwd2) { setPwdMsg('请填写完整'); return }
    if (newPwd.length < 6) { setPwdMsg('新密码至少6位'); return }
    if (newPwd !== newPwd2) { setPwdMsg('两次新密码不一致'); return }
    setPwdChanging(true)
    setPwdMsg('提交中...')
    try {
      await invoke('account_change_password', { oldPassword: oldPwd, newPassword: newPwd })
      setPwdMsg('')
      setOldPwd(''); setNewPwd(''); setNewPwd2('')
      setShowPwdModal(false)
    } catch (e: any) {
      const s = String(e?.message || e)
      setPwdMsg(s.includes('旧密码错误') ? '旧密码错误' : s.includes('锁定') ? '尝试过多已锁定,请稍后再试' : `修改失败: ${s.slice(0, 60)}`)
    } finally {
      setPwdChanging(false)
    }
  }

  // 修改用户名提交 (v4.3.0) — 旧密码验证, 硅侣号永不变
  const handleChangeUsername = async () => {
    const name = newUsername.trim()
    if (!name || !nameVerifyPwd) { setUsernameMsg('请填写完整'); return }
    if (name.length < 3 || name.length > 20) { setUsernameMsg('用户名须3-20字符'); return }
    if (name === accountName) { setUsernameMsg('新用户名与当前相同'); return }
    setUsernameChanging(true)
    setUsernameMsg('提交中...')
    try {
      await invoke('account_change_username', { oldPassword: nameVerifyPwd, newUsername: name })
      try { localStorage.setItem('siliconmate_account_name', name) } catch {}
      onAccountNameChange?.(name)
      setUsernameMsg('')
      setNewUsername(''); setNameVerifyPwd('')
      setShowUsernameModal(false)
    } catch (e: any) {
      const s = String(e?.message || e)
      setUsernameMsg(s.includes('密码错误') ? '密码错误' : s.includes('占用') ? '该用户名已被占用'
        : s.includes('锁定') ? '尝试过多已锁定,请稍后再试' : `修改失败: ${s.slice(0, 60)}`)
    } finally {
      setUsernameChanging(false)
    }
  }

  const handleActivateSubmit = async () => {
    if (!activateCode.trim()) { setActivateMsg('请输入激活码'); return }
    setActivateLoading(true)
    setActivateMsg('激活中, 请稍候...')
    try {
      const resp = await invoke('account_activate', { code: activateCode.trim() })
      // Android 适配层 resolve {plan, activated:true, tunnel:null}(隧道原生启动);
      // 桌面 Tauri 可能返回 tunnel 配置 → 需显式启动
      if (resp.tunnel) {
        try { await invoke('start_tunnel', { config: resp.tunnel }) } catch (te) {
          console.warn('[sidebar] tunnel start failed:', te)
        }
      }
      // T015: 激活态双写 — localStorage + 服务端(bind 已落库)
      try { localStorage.setItem('siliconmate_activated', '1') } catch {}
      setActivateMsg('激活成功 ✓')
      setTimeout(() => {
        setShowActivateModal(false)
        setActivateCode('')
        setActivateMsg('')
      }, 600)
      onActivate(resp.plan)
    } catch (e: any) {
      const msg = String(e?.message || e || '')
      if (msg.includes('未登录')) {
        setActivateMsg('请先注册或登录账号后再激活')
      } else if (msg.includes('ERR_INVALID')) {
        setActivateMsg('激活码无效')
      } else if (msg.includes('ERR_WRONG_PRODUCT')) {
        setActivateMsg('此激活码不适用于当前产品')
      } else if (msg.includes('ERR_EXPIRED')) {
        setActivateMsg('激活码已过期')
      } else if (msg.includes('ERR_ALREADY_ACTIVATED')) {
        setActivateMsg('账号已激活, 无需重复激活')
      } else if (msg.includes('ERR_FORMAT')) {
        setActivateMsg('激活码格式不正确')
      } else if (msg.includes('auth_failed')) {
        setActivateMsg('账号验证失败, 请重新登录')
      } else if (msg.includes('激活超时')) {
        setActivateMsg(msg)
      } else {
        setActivateMsg(msg || '激活失败, 请重试')
      }
    } finally {
      setActivateLoading(false)
    }
  }

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  if (collapsed) {
    return (
      <div style={{
        width: '48px',
        background: '#0a0c10',
        borderRight: '1px solid #222',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '12px',
        gap: '8px',
        flexShrink: 0,
      }}>
        <button
          onClick={onToggleCollapse}
          title="展开侧边栏"
          style={{
            background: '#2a2a3a', color: '#e6e6e6', border: 'none',
            borderRadius: '8px', width: '36px', height: '36px', cursor: 'pointer', fontSize: '16px',
          }}
        >
          ≡
        </button>
        <button
          onClick={onNew}
          title="新建对话"
          style={{
            background: '#2a5cff', color: '#fff', border: 'none',
            borderRadius: '8px', width: '36px', height: '36px', cursor: 'pointer', fontSize: '18px',
          }}
        >
          +
        </button>
        <button
          onClick={() => setShowSmcpPanel(true)}
          title="虾群好友"
          style={{
            background: '#2a2a3a', color: '#e6e6e6', border: 'none',
            borderRadius: '8px', width: '36px', height: '36px', cursor: 'pointer', fontSize: '16px',
          }}
        >
          🦐
        </button>
        <div title={accountName || undefined} style={{
          fontSize: '10px', fontWeight: 600, color: '#e6e6e6', marginTop: '2px',
          maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {accountName || ''}
        </div>
        <div title={activated ? '已激活' : '未激活'} style={{
          fontSize: '14px', color: activated ? '#2ecc71' : '#e74c3c', marginTop: '4px',
        }}>
          {activated ? '🟢' : '🔴'}
        </div>
        <div title={`硅侣 v${__APP_VERSION__} · 构建 ${__BUILD_TIME__}`} style={{
          fontSize: '9px', color: '#7a8aa0', marginTop: '2px', writingMode: 'horizontal-tb',
        }}>
          v{__APP_VERSION__}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      width: '240px',
      background: '#0a0c10',
      borderRight: '1px solid #222',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      position: 'relative',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid #222',
      }}>
        <span style={{ fontSize: '14px', fontWeight: 600, color: '#e6e6e6' }}>对话</span>
        {/* 当前账号标识 — 点击弹出账号菜单(v4.3.0): 修改用户名/修改密码/复制硅侣号 */}
        <div
          title={`账号：${accountName || '未登录'}${mySiliconId ? `\n硅侣号：${mySiliconId}` : ''}\n点击修改用户名/密码`}
          onClick={() => setShowAccountMenu(v => !v)}
          style={{
            flex: 1, minWidth: 0, textAlign: 'center', lineHeight: 1.3,
            cursor: 'pointer', userSelect: 'none',
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#e6e6e6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {accountName || ''} ▾
          </div>
          {mySiliconId && (
            <div style={{ fontSize: '10px', color: '#7a8aa0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {mySiliconId}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span title={`硅侣 v${__APP_VERSION__} · 构建 ${__BUILD_TIME__}`} style={{
            fontSize: '10px', color: '#7a8aa0', background: '#1a1d26',
            border: '1px solid #2a2a3a', borderRadius: '4px', padding: '2px 5px',
          }}>
            v{__APP_VERSION__}
          </span>
          <button
            onClick={onToggleCollapse}
            title="折叠侧边栏"
            style={{
              background: '#2a2a3a', color: '#aaa', border: 'none',
              borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '14px',
            }}
          >
            ◀
          </button>
          <button
            onClick={onNew}
            title="新建对话"
            style={{
              background: '#2a5cff', color: '#fff', border: 'none',
              borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '16px',
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* 账号下拉菜单 (v4.3.0) — 点用户名弹出 */}
      {showAccountMenu && (
        <>
          <div
            onClick={() => setShowAccountMenu(false)}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 150 }}
          />
          <div style={{
            position: 'absolute', top: '48px', left: '10px', zIndex: 151,
            background: '#0f1115', border: '1px solid #333', borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)', padding: '4px', minWidth: '150px',
          }}>
            <div
              onClick={() => { setShowAccountMenu(false); setNewUsername(accountName || ''); setNameVerifyPwd(''); setUsernameMsg(''); setShowUsernameModal(true) }}
              style={{ padding: '8px 10px', fontSize: '12px', color: '#e6e6e6', cursor: 'pointer', borderRadius: '6px', whiteSpace: 'nowrap' }}
              onMouseEnter={e => e.currentTarget.style.background = '#1a1f2b'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >✏️ 修改用户名</div>
            <div
              onClick={() => { setShowAccountMenu(false); setOldPwd(''); setNewPwd(''); setNewPwd2(''); setPwdMsg(''); setShowPwdModal(true) }}
              style={{ padding: '8px 10px', fontSize: '12px', color: '#e6e6e6', cursor: 'pointer', borderRadius: '6px', whiteSpace: 'nowrap' }}
              onMouseEnter={e => e.currentTarget.style.background = '#1a1f2b'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >🔑 修改密码</div>
            {mySiliconId && (
              <div
                onClick={() => { setShowAccountMenu(false); try { navigator.clipboard.writeText(mySiliconId) } catch {} }}
                style={{ padding: '8px 10px', fontSize: '12px', color: '#9aa8bd', cursor: 'pointer', borderRadius: '6px', whiteSpace: 'nowrap' }}
                onMouseEnter={e => e.currentTarget.style.background = '#1a1f2b'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >📋 复制硅侣号</div>
            )}
            <div style={{ padding: '5px 10px 3px', fontSize: '10px', color: '#556', borderTop: '1px solid #222', marginTop: '2px' }}>
              硅侣号永不变 · 昵称密码可改
            </div>
          </div>
        </>
      )}

      {/* Activation status */}
      <div style={{
        padding: '8px 14px',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        {activated ? (
          <span style={{ fontSize: '12px', color: '#2ecc71' }}>
            🟢 已激活 · {plan || 'basic'}
          </span>
        ) : (
          <>
            <span style={{ fontSize: '12px', color: '#e74c3c' }}>
              🔴 未激活 · 仅本地对话
            </span>
            <button
              onClick={() => setShowActivateModal(true)}
              style={{
                background: '#2a5cff', color: '#fff', border: 'none',
                borderRadius: '4px', padding: '2px 8px', cursor: 'pointer', fontSize: '11px',
              }}
            >
              激活
            </button>
          </>
        )}
      </div>

      {/* SMCP 虾群好友入口 */}
      <div
        onClick={() => setShowSmcpPanel(true)}
        style={{
          padding: '8px 14px',
          borderBottom: '1px solid #222',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#141820'}
        onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
      >
        <span style={{ fontSize: '12px', color: '#7a8aa0' }}>
          🦐 {mySiliconId || '虾群好友'}
          {friendBadge > 0 && (
            <span style={{
              background: '#e74c3c', color: '#fff', borderRadius: '8px',
              fontSize: '10px', padding: '1px 5px', marginLeft: '6px',
              display: 'inline-block', minWidth: '14px', textAlign: 'center',
            }}>{friendBadge}</span>
          )}
        </span>
        <span style={{ fontSize: '12px', color: '#555' }}>›</span>
      </div>

      {/* 视觉引擎设置入口 (v4.2.0) */}
      <div
        onClick={() => setShowVisionModal(true)}
        style={{
          padding: '8px 14px',
          borderBottom: '1px solid #222',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#141820'}
        onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
      >
        <span style={{ fontSize: '12px', color: '#7a8aa0' }}>
          👁 视觉引擎
          {visionStatus?.models && !visionStatus.models.ocrReady && (
            <span style={{ color: '#f39c12', marginLeft: '6px', fontSize: '10px' }}>· 缺本地模型</span>
          )}
        </span>
        <span style={{ fontSize: '12px', color: '#555' }}>›</span>
      </div>

      {/* Conversation list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '6px',
      }}>
        {sorted.length === 0 && (
          <div style={{
            color: '#555', fontSize: '12px', textAlign: 'center', padding: '20px 0',
          }}>
            暂无对话
          </div>
        )}
        {sorted.map(conv => {
          const isActive = conv.id === activeId
          const isDeleting = conv.id === deleteConfirmId
          const lastMsg = conv.messages[conv.messages.length - 1]
          const preview = lastMsg
            ? (lastMsg.content.length > 30 ? lastMsg.content.slice(0, 30) + '…' : lastMsg.content)
            : '空对话'
          // Use getConversationDisplay for friendly names
          const display = getConversationDisplay(conv, smcpFriends, smcpGroups)
          const convDisplayName = display.displayName || conv.title
          const convSubtitle = display.displaySubtitle
          const convOnline = display.onlineStatus

          return (
            <div
              key={conv.id}
              onClick={() => { onSelect(conv.id); setDeleteConfirmId(null) }}
              style={{
                padding: '8px 10px',
                borderRadius: '8px',
                marginBottom: '2px',
                cursor: 'pointer',
                background: isActive ? '#1a2a4a' : 'transparent',
                borderLeft: isActive ? '3px solid #2a5cff' : '3px solid transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLDivElement).style.background = '#141820'
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <div style={{
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
              }}>
                {/* 头像圆圈 + 未读红点 */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: conv.smcpGroupTarget ? '#1a3a2a' : conv.smcpTarget ? '#1a2a4a' : '#2a2a3a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    border: convOnline === 'online' ? '2px solid #2ecc71' : '2px solid transparent',
                  }}>
                    {conv.smcpGroupTarget ? '👥' : conv.smcpTarget ? '🦐' : '🤖'}
                  </div>
                  {conv.unreadCount && conv.unreadCount > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: '-4px',
                      right: '-4px',
                      minWidth: '16px',
                      height: '16px',
                      borderRadius: '8px',
                      background: '#e74c3c',
                      color: '#fff',
                      fontSize: '10px',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 4px',
                      lineHeight: 1,
                    }}>
                      {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{
                      fontSize: '13px',
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? '#e6e6e6' : '#bbb',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}>
                      {convDisplayName}
                    </span>
                    <span style={{ fontSize: '10px', color: '#555', flexShrink: 0, marginLeft: '4px' }}>
                      {lastMsg ? formatTime(lastMsg.timestamp) : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {convOnline && (
                      <span style={{ fontSize: '8px' }}>
                        {convOnline === 'online' ? '🟢' : '⚫'}
                      </span>
                    )}
                    <span style={{
                      fontSize: '11px',
                      color: '#666',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}>
                      {convSubtitle && <span style={{ marginRight: '4px' }}>{convSubtitle}</span>}
                      {preview}
                    </span>
                  </div>
                </div>
                {isActive && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      if (isDeleting) {
                        onDelete(conv.id)
                        setDeleteConfirmId(null)
                      } else {
                        setDeleteConfirmId(conv.id)
                        setTimeout(() => setDeleteConfirmId(null), 3000)
                      }
                    }}
                    style={{
                      background: isDeleting ? '#e74c3c' : 'transparent',
                      color: isDeleting ? '#fff' : '#555',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '1px 5px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      marginLeft: '4px',
                    }}
                  >
                    {isDeleting ? '确认?' : '×'}
                  </button>
                )}
              </div>
              <div style={{
                fontSize: '11px',
                color: '#666',
                marginTop: '2px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {preview}
              </div>
            </div>
          )
        })}
      </div>

      {/* Activate modal */}
      {showActivateModal && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
        }}>
          <div style={{
            background: '#1a1d25',
            borderRadius: '12px',
            padding: '24px',
            width: '200px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
          }}>
            <p style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: '#e6e6e6', textAlign: 'center' }}>
              输入激活码
            </p>
            <input
              type="text"
              placeholder="GL-XXX-XXXX"
              value={activateCode}
              onChange={e => setActivateCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleActivateSubmit()}
              style={{
                width: '100%',
                background: '#0f1115',
                border: '1px solid #333',
                borderRadius: '8px',
                padding: '8px 12px',
                color: '#e6e6e6',
                fontSize: '13px',
                outline: 'none',
                marginBottom: '12px',
                boxSizing: 'border-box',
                letterSpacing: '1px',
              }}
            />
            <button
              onClick={handleActivateSubmit}
              disabled={activateLoading}
              style={{
                width: '100%',
                background: '#2a5cff',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '8px',
                fontSize: '14px',
                cursor: activateLoading ? 'not-allowed' : 'pointer',
                marginBottom: '8px',
                opacity: activateLoading ? 0.6 : 1,
              }}
            >
              {activateLoading ? '激活中...' : '激活'}
            </button>
            <button
              onClick={() => { setShowActivateModal(false); setActivateMsg(''); setActivateCode('') }}
              style={{
                width: '100%',
                background: 'transparent',
                color: '#7a8aa0',
                border: '1px solid #333',
                borderRadius: '8px',
                padding: '6px',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            {activateMsg && (
              <p style={{
                marginTop: '8px',
                fontSize: '12px',
                textAlign: 'center',
                color: activateMsg.includes('成功') ? '#2ecc71' : '#e74c3c',
              }}>
                {activateMsg}
              </p>
            )}
          </div>
        </div>
      )}

      {/* SMCP 虾群好友面板 */}
      {showSmcpPanel && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 100,
        }}>
          <div style={{
            background: '#1a1d25',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '12px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid #222',
            }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e6e6e6' }}>
                🦐 虾群好友
                {mySiliconId && <span style={{ fontSize: '11px', color: '#4a8', marginLeft: '8px' }}>{mySiliconId}</span>}
              </span>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', color: smcpRelayOk ? '#2ecc71' : '#e74c3c' }}>
                  {smcpRelayOk ? '中继✓' : '中继✗'}
                </span>
                <button
                  onClick={() => setShowSmcpPanel(false)}
                  style={{
                    background: '#2a2a3a', color: '#aaa', border: 'none',
                    borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '14px',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Add friend by silicon_id */}
            <div style={{
              padding: '10px 14px',
              borderBottom: '1px solid #222',
            }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '6px' }}>添加好友(输入硅侣号)</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  placeholder="SM-XXXX"
                  value={addFriendId}
                  onChange={e => setAddFriendId(e.target.value.toUpperCase())}
                  style={{
                    flex: 1,
                    background: '#0f1115',
                    border: '1px solid #333',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    color: '#e6e6e6',
                    fontSize: '12px',
                    outline: 'none',
                    letterSpacing: '1px',
                  }}
                />
                <button
                  onClick={async () => {
                    if (!addFriendId.trim()) return
                    setAddFriendMsg('查找中...')
                    try {
                      const lookup = await lookupSiliconId(addFriendId.trim())
                      if (lookup?.error) {
                        setAddFriendMsg('查找失败: ' + String(lookup.error))
                        setTimeout(() => setAddFriendMsg(''), 5000)
                        return
                      }
                      if (!lookup?.ok && !lookup?.data && !lookup?.account_id) {
                        setAddFriendMsg('硅侣号不存在')
                        setTimeout(() => setAddFriendMsg(''), 3000)
                        return
                      }
                      const targetName = lookup?.data?.account_name || lookup?.account_name || addFriendId.trim()
                      setAddFriendMsg('发送请求中...')
                      const result = await sendFriendRequest('', `你好，我是${mySiliconId || '硅侣用户'}，想和你成为好友`, { agent_comm: true }, addFriendId.trim())
                       if (result?.ok || result?.request_id) {
                        setAddFriendMsg(`已向 ${targetName}(${addFriendId.trim()}) 发送请求 ✓`)
                        setAddFriendId('')
                        setTimeout(() => setAddFriendMsg(''), 3000)
                      } else if (result?.error === 'EXISTS' || String(result?.message).includes('already friends')) {
                        setAddFriendMsg(`已是好友 ✓`)
                        setAddFriendId('')
                        setTimeout(() => setAddFriendMsg(''), 3000)
                      } else {
                        const errMsg = result?.error || result?.message || JSON.stringify(result) || '发送失败'
                        setAddFriendMsg('失败: ' + String(errMsg))
                        setTimeout(() => setAddFriendMsg(''), 5000)
                      }
                    } catch (e: any) {
                      setAddFriendMsg('异常: ' + String(e))
                      setTimeout(() => setAddFriendMsg(''), 5000)
                    }
                  }}
                  style={{
                    background: '#2a5cff', color: '#fff', border: 'none',
                    borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px',
                  }}
                >
                  加好友
                </button>
              </div>
              {addFriendMsg && (
                <div style={{ fontSize: '11px', color: addFriendMsg.includes('✓') ? '#2ecc71' : '#e74c3c', marginTop: '4px' }}>
                  {addFriendMsg}
                </div>
              )}
            </div>

            {/* Pending requests */}
            {smcpRequests.length > 0 && (
              <div style={{
                padding: '8px 14px',
                borderBottom: '1px solid #222',
                maxHeight: '120px',
                overflowY: 'auto',
              }}>
                <div style={{ fontSize: '11px', color: '#f39c12', marginBottom: '4px' }}>待处理请求</div>
                {smcpRequests.map(req => (
                  <div key={req.request_id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '4px 0', fontSize: '12px',
                  }}>
                    <span style={{ color: '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {req.from_name ? `${req.from_name} (${req.from_silicon_id || req.from_user_id.slice(0, 12)})` : `${req.from_user_id.slice(0, 12)}…`}: {req.message}
                    </span>
                    <button
                      onClick={async () => {
                        await acceptFriendRequest(req.request_id)
                        const next = smcpRequests.filter(r => r.request_id !== req.request_id)
                        setSmcpRequests(next)
                        onPendingFriendCountChange?.(next.length)
                        getFriends().then(setSmcpFriends)
                      }}
                      style={{
                        background: '#2ecc71', color: '#fff', border: 'none',
                        borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '11px',
                        marginLeft: '4px', flexShrink: 0,
                      }}
                    >
                      接受
                    </button>
                    <button
                      onClick={async () => {
                        await rejectFriendRequest(req.request_id)
                        const next = smcpRequests.filter(r => r.request_id !== req.request_id)
                        setSmcpRequests(next)
                        onPendingFriendCountChange?.(next.length)
                      }}
                      style={{
                        background: 'transparent', color: '#e74c3c', border: '1px solid #e74c3c',
                        borderRadius: '4px', padding: '1px 6px', cursor: 'pointer', fontSize: '11px',
                        marginLeft: '4px', flexShrink: 0,
                      }}
                    >
                      拒绝
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Friends list */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '6px',
            }}>
              <div style={{ fontSize: '11px', color: '#555', padding: '4px 6px', marginBottom: '4px' }}>
                好友列表 ({smcpFriends.length})
              </div>
              {smcpFriends.length === 0 && (
                <div style={{ color: '#555', fontSize: '12px', textAlign: 'center', padding: '20px 0' }}>
                  暂无好友，输入用户ID添加
                </div>
              )}
              {smcpFriends.map(friend => {
                // 从好友信息构造Agent ID (格式: A-{userId8}-{role8})
                const friendAgentId = `A-${friend.friend_user_id.slice(0, 8)}-siliconm`
                const friendDisplay = friend.silicon_id || friend.alias || friend.friend_user_id.slice(0, 8)
                const friendName = friend.account_name || ''
                const hasComm = friend.granted_perms?.agent_comm || friend.received_perms?.agent_comm
                const hasDelegate = friend.granted_perms?.agent_delegate || friend.received_perms?.agent_delegate
                const isOnline = friend.agent_status === 'online'
                const onlineDot = isOnline ? '🟢' : '⚫'
                return (
                  <div
                    key={friend.friend_id}
                    onClick={() => {
                      onOpenSmcpChat({
                        userId: friend.friend_user_id,
                        agentId: friendAgentId,
                        role: friendDisplay,
                        myAgentId: `A-${(accountId || '').slice(0, 8)}-siliconm`,
                      })
                      setShowSmcpPanel(false)
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      marginBottom: '2px',
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#141820'}
                    onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', color: '#e6e6e6' }}>{onlineDot} {friendDisplay}</span>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          await removeFriend(friend.friend_user_id)
                          getFriends().then(setSmcpFriends)
                        }}
                        style={{
                          background: 'transparent', color: '#555', border: 'none',
                          padding: '0 4px', cursor: 'pointer', fontSize: '12px',
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div style={{ fontSize: '10px', color: '#555', marginTop: '2px' }}>
                      {hasComm ? '💬' : '🚫'}沟通
                      {hasDelegate ? ' 🤝委派' : ''}
                      {friendName && <span style={{ color: '#7a8aa0' }}> · {friendName}</span>}
                    </div>
                  </div>
                )
              })}

              {/* 群聊区域 */}
              <div style={{ fontSize: '11px', color: '#555', padding: '8px 6px 4px', borderTop: '1px solid #222', marginTop: '8px' }}>
                群聊 ({smcpGroups.length})
              </div>
              {smcpGroups.map(group => (
                <div
                  key={group.group_id}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    marginBottom: '2px',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#141820'}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div
                      onClick={() => {
                        onOpenGroupChat(group.group_id, group.name)
                        setShowSmcpPanel(false)
                      }}
                      style={{ flex: 1 }}
                    >
                      <div style={{ fontSize: '13px', color: '#e6e6e6' }}>👥 {group.name}</div>
                      <div style={{ fontSize: '10px', color: '#555', marginTop: '2px' }}>
                        {group.member_count || 0}人
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setInviteGroupId(group.group_id)
                        setInviteSelectedIds(new Set())
                      }}
                      title="邀请好友入群"
                      style={{
                        background: 'transparent', color: '#888', border: '1px solid #333',
                        borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '10px',
                      }}
                    >
                      +邀请
                    </button>
                  </div>
                </div>
              ))}

              {/* 邀请好友入群弹窗 */}
              {inviteGroupId && (
                <div style={{ padding: '8px 6px', background: '#0a0c10', borderRadius: '6px', border: '1px solid #2a5cff', margin: '4px 0' }}>
                  <div style={{ fontSize: '11px', color: '#2a5cff', marginBottom: '6px' }}>邀请好友入群</div>
                  {smcpFriends.length === 0 && (
                    <div style={{ fontSize: '10px', color: '#555' }}>暂无好友可邀请</div>
                  )}
                  {smcpFriends.map(f => (
                    <label key={f.friend_user_id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 0', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={inviteSelectedIds.has(f.friend_user_id)}
                        onChange={() => {
                          setInviteSelectedIds(prev => {
                            const next = new Set(prev)
                            if (next.has(f.friend_user_id)) next.delete(f.friend_user_id)
                            else next.add(f.friend_user_id)
                            return next
                          })
                        }}
                        style={{ width: '12px', height: '12px' }}
                      />
                      <span style={{ fontSize: '11px', color: '#ccc' }}>{f.account_name || f.alias || f.friend_user_id}</span>
                      <span style={{ fontSize: '9px', color: '#555' }}>({f.silicon_id || ''})</span>
                    </label>
                  ))}
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                    <button
                      onClick={async () => {
                        if (inviteSelectedIds.size === 0) return
                        for (const uid of inviteSelectedIds) {
                          await inviteToGroup(inviteGroupId, uid)
                        }
                        setInviteGroupId(null)
                        setInviteSelectedIds(new Set())
                        getGroups().then(setSmcpGroups)
                      }}
                      disabled={inviteSelectedIds.size === 0}
                      style={{
                        flex: 1, background: inviteSelectedIds.size > 0 ? '#2a5cff' : '#1a1a2a',
                        color: '#fff', border: 'none', borderRadius: '4px', padding: '4px', cursor: inviteSelectedIds.size > 0 ? 'pointer' : 'not-allowed', fontSize: '11px',
                      }}
                    >
                      邀请{inviteSelectedIds.size > 0 ? ` ${inviteSelectedIds.size} 人` : ''}
                    </button>
                    <button
                      onClick={() => { setInviteGroupId(null); setInviteSelectedIds(new Set()) }}
                      style={{ background: '#1a1a2a', color: '#888', border: 'none', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px' }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {/* 创建群 */}
              <div style={{ padding: '6px' }}>
                {!showCreateGroup ? (
                  <button
                    onClick={() => { setShowCreateGroup(true); setSelectedFriendIds(new Set()) }}
                    style={{ width: '100%', background: '#1a1a2a', color: '#888', border: '1px dashed #333', borderRadius: '6px', padding: '6px', cursor: 'pointer', fontSize: '11px' }}
                  >
                    + 创建新群
                  </button>
                ) : (
                  <div style={{ background: '#0a0c10', borderRadius: '6px', border: '1px solid #2a5cff', padding: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#2a5cff', marginBottom: '6px' }}>创建新群</div>
                    <input
                      type="text"
                      placeholder="输入群名"
                      value={createGroupName}
                      onChange={e => setCreateGroupName(e.target.value)}
                      style={{
                        width: '100%', background: '#0f1115', border: '1px solid #333',
                        borderRadius: '6px', padding: '4px 8px', color: '#e6e6e6', fontSize: '11px', outline: 'none', boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ fontSize: '10px', color: '#888', margin: '6px 0 4px' }}>选择好友：</div>
                    {smcpFriends.length === 0 && (
                      <div style={{ fontSize: '10px', color: '#555' }}>暂无好友，先添加好友再建群</div>
                    )}
                    {smcpFriends.map(f => (
                      <label key={f.friend_user_id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 0', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedFriendIds.has(f.friend_user_id)}
                          onChange={() => {
                            setSelectedFriendIds(prev => {
                              const next = new Set(prev)
                              if (next.has(f.friend_user_id)) next.delete(f.friend_user_id)
                              else next.add(f.friend_user_id)
                              return next
                            })
                          }}
                          style={{ width: '12px', height: '12px' }}
                        />
                        <span style={{ fontSize: '11px', color: '#ccc' }}>{f.account_name || f.alias || f.friend_user_id}</span>
                        <span style={{ fontSize: '9px', color: '#555' }}>({f.silicon_id || ''})</span>
                      </label>
                    ))}
                    <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                      <button
                        onClick={async () => {
                          if (!createGroupName.trim()) return
                          const friendIds = Array.from(selectedFriendIds)
                          const result = await createGroup(createGroupName.trim(), friendIds)
                          if (result.ok) {
                            setCreateGroupName('')
                            setShowCreateGroup(false)
                            setSelectedFriendIds(new Set())
                            getGroups().then(setSmcpGroups)
                          }
                        }}
                        disabled={!createGroupName.trim()}
                        style={{
                          flex: 1, background: createGroupName.trim() ? '#2a5cff' : '#1a1a2a',
                          color: '#fff', border: 'none', borderRadius: '4px', padding: '4px', cursor: createGroupName.trim() ? 'pointer' : 'not-allowed', fontSize: '11px',
                        }}
                      >
                        建群{selectedFriendIds.size > 0 ? ` (${selectedFriendIds.size}人)` : ''}
                      </button>
                      <button
                        onClick={() => { setShowCreateGroup(false); setCreateGroupName(''); setSelectedFriendIds(new Set()) }}
                        style={{ background: '#1a1a2a', color: '#888', border: 'none', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '11px' }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 视觉引擎设置模态框 (v4.2.0) */}
      {showVisionModal && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
        }}>
          <div style={{
            width: '380px',
            maxHeight: '85%',
            overflowY: 'auto',
            background: '#0f1115',
            border: '1px solid #333',
            borderRadius: '10px',
            padding: '16px',
          }}>
            {/* 标题栏 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e6e6e6' }}>👁 视觉引擎</span>
              <button
                onClick={() => setShowVisionModal(false)}
                style={{ background: '#2a2a3a', color: '#aaa', border: 'none', borderRadius: '6px', width: '28px', height: '28px', cursor: 'pointer' }}
              >✕</button>
            </div>

            {/* OCR 引擎选择 */}
            <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '6px' }}>OCR 文字识别引擎</div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
              {[['auto', '自动'], ['local', '本地模型'], ['api', 'API']].map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setVisionOcrEngine(v)}
                  style={{
                    flex: 1, padding: '6px 0',
                    background: visionOcrEngine === v ? '#2a5cff' : '#1a1d26',
                    color: visionOcrEngine === v ? '#fff' : '#888',
                    border: visionOcrEngine === v ? '1px solid #2a5cff' : '1px solid #2a2a3a',
                    borderRadius: '6px', cursor: 'pointer', fontSize: '12px',
                  }}
                >{label}</button>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: '#666', marginBottom: '14px' }}>
              {visionOcrEngine === 'auto' && '自动：macOS 用系统自带识别（零模型），其他平台用本地模型'}
              {visionOcrEngine === 'local' && '本地模型：PaddleOCR，离线可用，需先下载模型'}
              {visionOcrEngine === 'api' && 'API：调云端视觉大模型，识别最准，需配置下方 API'}
            </div>

            {/* 本地模型状态 */}
            <div style={{ borderTop: '1px solid #222', paddingTop: '10px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '11px', color: '#7a8aa0' }}>本地模型（OCR 必需 / 图标检测可选）</span>
                <span style={{ fontSize: '10px', color: visionStatus?.models?.ocrReady ? '#2ecc71' : '#f39c12' }}>
                  {visionStatus?.models ? (visionStatus.models.ocrReady ? 'OCR 就绪 ✓' : '未下载') : '检测中…'}
                </span>
              </div>
              {visionStatus?.models?.missing?.length > 0 && (
                <div style={{ fontSize: '10px', color: '#888', marginBottom: '6px', wordBreak: 'break-all' }}>
                  缺失: {visionStatus.models.missing.join('、')}
                </div>
              )}
              {visionProgress && (
                <div style={{ fontSize: '10px', color: '#2a9cff', marginBottom: '6px' }}>{visionProgress}</div>
              )}
              <button
                onClick={startVisionDownload}
                disabled={visionDownloading}
                style={{
                  width: '100%', padding: '6px 0',
                  background: visionDownloading ? '#1a3a1a' : visionStatus?.models?.ocrReady ? '#2a2a3a' : '#2a5cff',
                  color: visionDownloading ? '#2ecc71' : '#fff',
                  border: 'none', borderRadius: '6px', cursor: visionDownloading ? 'default' : 'pointer',
                  fontSize: '11px',
                }}
              >
                {visionDownloading ? '下载中…' : visionStatus?.models?.ocrReady ? '重新下载/补全模型' : '下载模型 (~28MB)'}
              </button>
            </div>

            {/* API 配置 */}
            <div style={{ borderTop: '1px solid #222', paddingTop: '10px', marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '6px' }}>
                视觉 API（API 模式必需，也可用于图标感知）
              </div>
              <input
                type="text" placeholder="Base URL（如 https://api.xxx.com/v1）"
                value={visionApiUrl} onChange={e => setVisionApiUrl(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '6px 10px', color: '#e6e6e6', fontSize: '11px', outline: 'none', marginBottom: '6px' }}
              />
              <input
                type="password" placeholder={visionStatus?.config?.apiConfigured ? 'API Key（已配置，留空=不修改）' : 'API Key'}
                value={visionApiKey} onChange={e => setVisionApiKey(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '6px 10px', color: '#e6e6e6', fontSize: '11px', outline: 'none', marginBottom: '6px' }}
              />
              <input
                type="text" placeholder="视觉模型名（如 qwen-vl-plus / gpt-4o-mini）"
                value={visionApiModel} onChange={e => setVisionApiModel(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '6px 10px', color: '#e6e6e6', fontSize: '11px', outline: 'none' }}
              />
            </div>

            {/* 保存 */}
            <button
              onClick={saveVisionConfig}
              style={{
                width: '100%', padding: '8px 0', background: '#2a5cff', color: '#fff',
                border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
              }}
            >保存设置</button>
            {visionSaveMsg && (
              <div style={{ fontSize: '11px', color: visionSaveMsg.includes('✓') ? '#2ecc71' : '#e74c3c', marginTop: '6px', textAlign: 'center' }}>
                {visionSaveMsg}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 修改密码模态框 (v4.2.2) */}
      {showPwdModal && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
        }}>
          <div style={{
            width: '320px',
            background: '#0f1115',
            border: '1px solid #333',
            borderRadius: '10px',
            padding: '16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e6e6e6' }}>🔑 修改密码</span>
              <button
                onClick={() => setShowPwdModal(false)}
                style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}
              >✕</button>
            </div>
            {accountName && (
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '10px' }}>
                当前账号: <span style={{ color: '#e6e6e6' }}>{accountName}</span>
              </div>
            )}
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '4px' }}>旧密码</div>
              <input
                type="password" placeholder="当前密码"
                value={oldPwd} onChange={e => setOldPwd(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '7px 10px', color: '#e6e6e6', fontSize: '12px', outline: 'none' }}
              />
            </div>
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '4px' }}>新密码（至少6位）</div>
              <input
                type="password" placeholder="新密码"
                value={newPwd} onChange={e => setNewPwd(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '7px 10px', color: '#e6e6e6', fontSize: '12px', outline: 'none' }}
              />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '4px' }}>确认新密码</div>
              <input
                type="password" placeholder="再输入一次新密码"
                value={newPwd2} onChange={e => setNewPwd2(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '7px 10px', color: '#e6e6e6', fontSize: '12px', outline: 'none' }}
              />
            </div>
            <button
              onClick={handleChangePassword}
              disabled={pwdChanging}
              style={{
                width: '100%', padding: '8px 0',
                background: pwdChanging ? '#1a3aa0' : '#2a5cff', color: '#fff',
                border: 'none', borderRadius: '6px', cursor: pwdChanging ? 'default' : 'pointer',
                fontSize: '12px', fontWeight: 600,
              }}
            >{pwdChanging ? '提交中...' : '确认修改'}</button>
            {pwdMsg && (
              <div style={{ fontSize: '11px', color: '#e74c3c', marginTop: '8px', textAlign: 'center' }}>
                {pwdMsg}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 修改用户名 Modal (v4.3.0) — 旧密码验证, 硅侣号永不变 */}
      {showUsernameModal && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
        }}>
          <div style={{
            width: '320px',
            background: '#0f1115',
            border: '1px solid #333',
            borderRadius: '10px',
            padding: '16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#e6e6e6' }}>✏️ 修改用户名</span>
              <button
                onClick={() => setShowUsernameModal(false)}
                style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '16px', padding: '0 4px' }}
              >✕</button>
            </div>
            <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '10px', lineHeight: 1.5 }}>
              当前账号: <span style={{ color: '#e6e6e6' }}>{accountName || '未登录'}</span>
              {mySiliconId && <span> · 硅侣号 <span style={{ color: '#9aa8bd' }}>{mySiliconId}</span> 保持不变</span>}
            </div>
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '4px' }}>新用户名（3-20字符）</div>
              <input
                type="text" placeholder="输入新用户名"
                value={newUsername} onChange={e => setNewUsername(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '7px 10px', color: '#e6e6e6', fontSize: '12px', outline: 'none' }}
              />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: '#7a8aa0', marginBottom: '4px' }}>当前密码（验证身份）</div>
              <input
                type="password" placeholder="输入当前密码"
                value={nameVerifyPwd} onChange={e => setNameVerifyPwd(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', background: '#0a0c10', border: '1px solid #333', borderRadius: '6px', padding: '7px 10px', color: '#e6e6e6', fontSize: '12px', outline: 'none' }}
              />
            </div>
            <button
              onClick={handleChangeUsername}
              disabled={usernameChanging}
              style={{
                width: '100%', padding: '8px 0',
                background: usernameChanging ? '#1a3aa0' : '#2a5cff', color: '#fff',
                border: 'none', borderRadius: '6px', cursor: usernameChanging ? 'default' : 'pointer',
                fontSize: '12px', fontWeight: 600,
              }}
            >{usernameChanging ? '提交中...' : '确认修改'}</button>
            {usernameMsg && (
              <div style={{ fontSize: '11px', color: '#e74c3c', marginTop: '8px', textAlign: 'center' }}>
                {usernameMsg}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
