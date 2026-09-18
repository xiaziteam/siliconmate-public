/**
 * 硅侣2.0 — 极简交互窗口
 *
 * 设计原则:
 * - 只显示用户输入和AI最终结论
 * - 严禁显示工具调用、模型名称、中间步骤
 * - 流式显示AI回复
 * - 附件上传按钮（回形针）
 * - 语音聊天切换按钮
 * - 状态提示（"硅侣正在思考…"）
 */

import React, { useState, useRef, useEffect } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { formatTime, formatFileSize, getGroupInfo, kickGroupMember, transferGroupOwner, setGroupMemberRole, updateGroup, taskExecute, TaskResult, listCapabilities, CapabilityInfo } from './smcp'

interface ImageAttachment {
  path: string
  name: string
  ocr_text: string | null
  ocr_status: 'pending' | 'success' | 'failed' | 'not_available' | 'no_text'
  file_size: number
  data?: string // base64 for SMCP transfer
  type?: string // mime type for SMCP transfer
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming: boolean
  timestamp: number
  // Agent task result fields
  execution_tier?: string   // "native" | "nuphus" | "freecode" | "fallback"
  task_status?: string      // "success" | "error" | "rejected" | "timeout"
  screenshots?: string[]    // base64 encoded
  duration_ms?: number
  error_message?: string
  is_task_result?: boolean
  // Multi-step execution (Computer Use)
  steps?: TaskStep[]
}

interface TaskStep {
  step_num: number
  description: string
  screenshot?: string
  status: string
}

/** Agent能力tier样式配置 */
const TIER_STYLES: Record<string, { icon: string; color: string; label: string }> = {
  native: { icon: '⚡', color: '#4CAF50', label: '原生直通' },
  nuphus: { icon: '🤖', color: '#2196F3', label: 'Nuphus引擎' },
  freecode: { icon: '🧠', color: '#9C27B0', label: '深度思考' },
  fallback: { icon: '⚠️', color: '#FF9800', label: '降级命令' },
  multi_step: { icon: '🔄', color: '#00BCD4', label: '多步执行' },
  none: { icon: '❌', color: '#f44336', label: '无' },
}

function getTierStyle(tier: string) {
  return TIER_STYLES[tier] || TIER_STYLES.none
}

interface ChatProps {
  onSendMessage: (text: string, attachments?: ImageAttachment[], deepThink?: boolean, feishuOutput?: boolean, mentions?: string[], taskCapability?: string, taskParams?: any) => void
  onVoiceChat: () => void
  status: 'idle' | 'thinking' | 'deep_thinking' | 'streaming' | 'error'
  deepThinkProgress?: string
  serverConnected?: boolean
  serverConnecting?: boolean
  /** T029: 激活态 — 状态条三态(未激活/已连接/离线)判据 */
  activated?: boolean
  messages: Message[]
  isVoiceMode: boolean
  /** 如果是SMCP对话，传对方信息 */
  smcpTarget?: { userId: string; agentId: string; role: string } | null
  /** v4.4.0: 好友列表 — 头部显示好友自设用户名+备注(微信式) */
  smcpFriends?: any[] | null
  /** 如果是SMCP群聊，传群信息 */
  smcpGroupTarget?: { groupId: string; groupName: string; memberCount?: number; members?: { userId: string; role: string; accountName?: string; siliconId?: string }[] } | null
  /** 当前用户ID，用于判断群管理权限 */
  myUserId?: string
  /** T018: 发送失败后重试最后一条用户消息 */
  onRetryLast?: () => void
}

/** 高亮搜索关键词 */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !text.toLowerCase().includes(query.toLowerCase())) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  const before = text.slice(0, idx)
  const match = text.slice(idx, idx + query.length)
  const after = text.slice(idx + query.length)
  return <>
    {before}<span style={{ background: '#f39c12', color: '#000', borderRadius: '2px', padding: '0 2px' }}>{match}</span>{highlightText(after, query)}
  </>
}

export const Chat: React.FC<ChatProps> = ({
  onSendMessage,
  onVoiceChat,
  status,
  deepThinkProgress,
  serverConnected,
  serverConnecting,
  activated,
  messages,
  isVoiceMode,
  smcpTarget,
  smcpFriends,
  smcpGroupTarget,
  myUserId,
  onRetryLast,
}) => {
  const isSmcp = !!(smcpTarget || smcpGroupTarget)
  // v4.4.0: SMCP单聊头部名 — 主显好友自设用户名, 备注后缀; 老会话按agentId兜底匹配
  let smcpFriend: any = null
  if (smcpTarget) {
    smcpFriend = smcpFriends?.find((f: any) => f.friend_user_id === smcpTarget.userId) || null
    if (!smcpFriend && smcpTarget.agentId && smcpTarget.agentId.startsWith('A-')) {
      smcpFriend = smcpFriends?.find((f: any) => `A-${String(f.friend_user_id).slice(0, 8)}-siliconm` === smcpTarget.agentId) || null
    }
  }
  const smcpHeaderBase = smcpFriend?.account_name || smcpFriend?.alias || smcpTarget?.role || '好友'
  const smcpHeaderName = (smcpFriend?.account_name && smcpFriend?.alias)
    ? `${smcpFriend.account_name}（${smcpFriend.alias}）`
    : smcpHeaderBase
  const [input, setInput] = useState('')
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [isProcessingImage, setIsProcessingImage] = useState(false)
  const [deepThinkMode, setDeepThinkMode] = useState(false)
  const [feishuOutput, setFeishuOutput] = useState(false)
  const [showGroupMembers, setShowGroupMembers] = useState(false)
  const [groupMembers, setGroupMembers] = useState<{ userId: string; role: string; accountName?: string; siliconId?: string }[]>([])
  const [showGroupManage, setShowGroupManage] = useState(false) // 群管理面板
  const [editingGroupName, setEditingGroupName] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showMention, setShowMention] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [showCapabilities, setShowCapabilities] = useState(false)
  const [capabilities, setCapabilities] = useState<CapabilityInfo[]>([])
  const [taskApprovalRequest, setTaskApprovalRequest] = useState<any>(null)
  const [activeMultiStepTask, setActiveMultiStepTask] = useState<string | null>(null)
  const [multiStepSteps, setMultiStepSteps] = useState<TaskStep[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const invoke = (window as any).__TAURI__?.core?.invoke
  const listen = (window as any).__TAURI__?.event?.listen

  // Microphone availability check via Web Speech API
  const [isRecording, setIsRecording] = useState(false)

  const handleMicInput = () => {
    // macOS系统听写：Fn两下 或 系统偏好→键盘→听写 开启
    // 聚焦输入框后用户按Fn两下即可语音输入
    inputRef.current?.focus()
    // Visual feedback - pulse the input
    setIsRecording(true)
    setTimeout(() => setIsRecording(false), 1500)
  }

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Listen for task-result events from Tauri backend
  useEffect(() => {
    if (!listen || isSmcp) return

    let unlistenTaskResult: (() => void) | null = null
    let unlistenRemoteResult: (() => void) | null = null
    let unlistenApproval: (() => void) | null = null
    let unlistenTaskStep: (() => void) | null = null

    // Local task execution result
    listen('task-result', (event: any) => {
      const result: TaskResult = event.payload
      console.log('[chat] task-result event:', result)
    }).then((fn: () => void) => { unlistenTaskResult = fn })

    // Remote task result
    listen('remote-task-result', (event: any) => {
      const result = event.payload
      console.log('[chat] remote-task-result:', result)
    }).then((fn: () => void) => { unlistenRemoteResult = fn })

    // Task approval request
    listen('task-approval-request', (event: any) => {
      const request = event.payload
      setTaskApprovalRequest(request)
    }).then((fn: () => void) => { unlistenApproval = fn })

    // Multi-step task progress (Computer Use)
    listen('task-step', (event: any) => {
      const { task_id, step } = event.payload
      if (task_id && step) {
        setActiveMultiStepTask(task_id)
        setMultiStepSteps(prev => [...prev, {
          step_num: step.step_num,
          description: step.action || step.capability,
          screenshot: step.screenshot,
          status: step.status,
        }])
      }
    }).then((fn: () => void) => { unlistenTaskStep = fn })

    return () => {
      if (unlistenTaskResult) unlistenTaskResult()
      if (unlistenRemoteResult) unlistenRemoteResult()
      if (unlistenApproval) unlistenApproval()
      if (unlistenTaskStep) unlistenTaskStep()
    }
  }, [listen, isSmcp])

  const handleSend = () => {
    const text = input.trim()
    if (!text && imageAttachments.length === 0) return
    // 提取@提及的成员名
    const mentions = text.match(/@(\S+)/g)?.map(m => m.slice(1)) || []

    // Agent指令识别：检测task关键词，拦截到task_execute
    const taskCapability = detectAgentCommand(text)
    if (taskCapability && !isSmcp && invoke) {
      // 构建task params
      const taskParams = buildTaskParams(taskCapability, text)
      // 执行task，由App.tsx的onSendMessage处理路由
      onSendMessage(text, imageAttachments.length > 0 ? imageAttachments : undefined, deepThinkMode, feishuOutput, mentions.length > 0 ? mentions : undefined, taskCapability, taskParams)
      setInput('')
      setImageAttachments([])
      return
    }

    onSendMessage(text, imageAttachments.length > 0 ? imageAttachments : undefined, deepThinkMode, feishuOutput, mentions.length > 0 ? mentions : undefined)
    setInput('')
    setImageAttachments([])
  }

  /** Agent指令识别：关键词匹配 */
  const detectAgentCommand = (text: string): string | null => {
    const lower = text.toLowerCase()
    if (lower.includes('截屏') || lower.includes('截图') || lower.includes('screenshot')) return 'screenshot'
    if (lower.includes('打开')) return 'app.open'
    if (lower.includes('读文件') || lower.includes('读取文件')) return 'file.read'
    if (lower.includes('执行') || lower.includes('运行') || lower.includes('跑一下')) return 'shell.exec'
    if (lower.includes('识别文字') || lower.includes('文字识别') || lower.includes('ocr')) return 'ocr'
    if (lower.includes('发到飞书') || lower.includes('发飞书') || lower.includes('发送飞书')) return 'feishu.send'
    if (lower.includes('你能做什么') || lower.includes('你会什么') || lower.includes('列出能力')) return 'list_capabilities'
    return null
  }

  /** 构建task参数 */
  const buildTaskParams = (capability: string, text: string): any => {
    const lower = text.toLowerCase()
    switch (capability) {
      case 'screenshot':
        return {}
      case 'app.open': {
        const appName = text.replace(/打开|开启|启动/gi, '').trim()
        return { app_name: appName }
      }
      case 'file.read': {
        const pathMatch = text.match(/读(?:取)?文件?\s*(.+)/)
        return { path: pathMatch ? pathMatch[1].trim() : '' }
      }
      case 'shell.exec': {
        const cmdMatch = text.match(/(?:执行|运行|跑一下)\s*(.+)/)
        return { command: cmdMatch ? cmdMatch[1].trim() : '' }
      }
      case 'ocr':
        return { image_path: '' }
      default:
        return {}
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileSelect = async () => {
    // v4.1.1: Android走原生<input type=file>(WebView由Kotlin onShowFileChooser拉起系统选择器)
    // 桌面Tauri的plugin-dialog在Android适配层不存在 → 之前点了没下文
    if ((window as any).NativeBridge) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        setIsProcessingImage(true)
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result || '')
          setImageAttachments(prev => [...prev, {
            path: file.name,
            name: file.name,
            ocr_text: null,
            ocr_status: 'not_available' as const,
            file_size: file.size,
            data: dataUrl.split(',')[1] || '', // base64, SMCP发送直接用
          }])
          setIsProcessingImage(false)
        }
        reader.onerror = () => {
          console.error('[file] read error:', reader.error)
          setIsProcessingImage(false)
        }
        reader.readAsDataURL(file)
      }
      input.click()
      return
    }
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: '图片文件',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg']
        }]
      })

      if (!selected) return

      const filePath = typeof selected === 'string' ? selected : String(selected)
      if (!filePath) return

      setIsProcessingImage(true)

      if (invoke) {
        try {
          const result = await invoke('process_image', { imagePath: filePath }) as ImageAttachment
          setImageAttachments(prev => [...prev, result])
        } catch (e) {
          console.error('process_image error:', e)
          const fileName = filePath.split('/').pop() || 'unknown'
          setImageAttachments(prev => [...prev, {
            path: filePath,
            name: fileName,
            ocr_text: null,
            ocr_status: 'failed',
            file_size: 0,
          }])
        }
      }

      setIsProcessingImage(false)
    } catch (e) {
      console.error('File dialog error:', e)
      setIsProcessingImage(false)
    }
  }

  const handleRemoveAttachment = (index: number) => {
    setImageAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // Status text
  const statusText = (() => {
    switch (status) {
      case 'thinking': return '硅侣正在思考…'
      case 'deep_thinking': return deepThinkProgress ? `🧠 ${deepThinkProgress}` : '硅侣正在深度思考…'
      case 'streaming': return ''
      case 'error': return '出错了，请重试'
      default: return ''
    }
  })()

  // 移动端自适应：窄屏隐藏非核心按钮，避免输入栏挤爆（横屏已锁定，宽度仅在键盘弹出外不变）
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 480

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#0f1115',
      color: '#e6e6e6',
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    }}>
      {/* Header */}
      <header style={{
        padding: '14px 20px',
        // 52px避让左上角浮层按钮区(汉堡8-42px/虾群按钮8-42px), 防止遮住标题"硅侣"
        paddingLeft: '52px',
        background: 'linear-gradient(90deg, #1a2a4a, #0f1115)',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}>
        <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>
          {smcpGroupTarget ? `👥 ${smcpGroupTarget.groupName}` : smcpTarget ? `🦐 ${smcpHeaderName}` : '硅侣'}
        </h1>
        <span style={{ fontSize: '12px', color: '#7a8aa0' }}>
          {smcpGroupTarget
            ? `${smcpGroupTarget.memberCount || groupMembers.length || 0}人 · SMCP`
            : isSmcp
            ? 'SMCP · 虾群通讯'
            : 'SiliconMate · 硅基生命数字人伴侣'}
        </span>
        {/* 群成员按钮 */}
        {smcpGroupTarget && (
          <button
            onClick={async () => {
              if (!showGroupMembers) {
                const info = await getGroupInfo(smcpGroupTarget.groupId)
                if (info.ok && info.members) {
                  setGroupMembers(info.members.map(m => ({
                    userId: m.user_id,
                    role: m.role,
                    accountName: m.account_name,
                    siliconId: m.silicon_id,
                  })))
                }
              }
              setShowGroupMembers(!showGroupMembers)
            }}
            style={{
              marginLeft: '8px',
              background: '#2a2a3a',
              color: '#ccc',
              border: '1px solid #333',
              borderRadius: '6px',
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            {showGroupMembers ? '收起' : '📋 成员'}
          </button>
        )}
        {/* 搜索按钮 */}
        <button
          onClick={() => { setShowSearch(!showSearch); setSearchQuery('') }}
          style={{
            marginLeft: '8px',
            background: showSearch ? '#2a5cff' : '#2a2a3a',
            color: '#ccc',
            border: '1px solid #333',
            borderRadius: '6px',
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          🔍
        </button>
        {/* T029: 连接状态三态 — 未激活(灰)/已连接(绿)/离线(红)+连接中(琥珀), FR-014 真实心跳驱动 */}
        {(() => {
          // 三态优先级: 未激活 > 连接中 > 已连接/离线
          const st = !activated
            ? { color: '#7a8aa0', dot: '#7a8aa0', text: '未激活 · 云端功能未启用' }
            : serverConnecting
              ? { color: '#f39c12', dot: '#f39c12', text: '连接中…' }
              : serverConnected
                ? { color: '#2ecc71', dot: '#2ecc71', text: '已连接' }
                : { color: '#e74c3c', dot: '#e74c3c', text: '离线 · 重连中…' }
          return (
            <span style={{
              fontSize: '11px',
              color: st.color,
              marginLeft: isVoiceMode ? '8px' : 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: st.dot,
                display: 'inline-block',
              }} />
              {st.text}
            </span>
          )
        })()}
      </header>

      {/* 群成员/管理面板 */}
      {smcpGroupTarget && showGroupMembers && (
        <div style={{
          padding: '8px 20px',
          background: '#141820',
          borderBottom: '1px solid #222',
          maxHeight: '200px',
          overflowY: 'auto',
        }}>
          {/* 群名编辑 */}
          {editingGroupName ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
              <input
                value={newGroupName}
                onChange={e => setNewGroupName(e.target.value)}
                style={{ flex: 1, background: '#1c2030', border: '1px solid #3a3a4a', borderRadius: '4px', color: '#fff', padding: '4px 8px', fontSize: '12px' }}
                placeholder="新群名"
              />
              <button onClick={async () => {
                if (newGroupName.trim()) {
                  const r = await updateGroup(smcpGroupTarget.groupId, newGroupName.trim())
                  if (r.ok) {
                    smcpGroupTarget.groupName = newGroupName.trim()
                    setEditingGroupName(false)
                  } else { alert(r.error || '修改失败') }
                }
              }} style={{ padding: '4px 8px', background: '#2a5cff', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '11px' }}>保存</button>
              <button onClick={() => setEditingGroupName(false)} style={{ padding: '4px 8px', background: '#333', color: '#999', border: 'none', borderRadius: '4px', fontSize: '11px' }}>取消</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ color: '#e6e6e6', fontSize: '12px', fontWeight: 600 }}>👥 {smcpGroupTarget.groupName}</span>
              {(() => {
                const myRole = groupMembers.find(m => m.userId === myUserId)?.role
                return myRole === 'owner' || myRole === 'admin' ? (
                  <button onClick={() => { setNewGroupName(smcpGroupTarget.groupName); setEditingGroupName(true) }} style={{ padding: '2px 6px', background: '#1c2030', border: '1px solid #3a3a4a', borderRadius: '4px', color: '#8ab4ff', fontSize: '10px' }}>✏️ 改名</button>
                ) : null
              })()}
            </div>
          )}
          {/* 成员列表 */}
          {groupMembers.length === 0 && (
            <span style={{ fontSize: '11px', color: '#555' }}>加载中…</span>
          )}
          {groupMembers.map(m => {
            const myRole = groupMembers.find(me => me.userId === myUserId)?.role
            const canManage = myRole === 'owner' || (myRole === 'admin' && m.role === 'member')
            const canKick = myRole === 'owner' || (myRole === 'admin' && m.role === 'member')
            const canSetAdmin = myRole === 'owner' && m.userId !== myUserId
            const canTransfer = myRole === 'owner' && m.userId !== myUserId
            
            return (
              <div key={m.userId} style={{
                background: '#1c2030',
                border: '1px solid #2a2a3a',
                borderRadius: '8px',
                padding: '4px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '11px',
                marginBottom: '4px',
              }}>
                <span style={{ color: m.role === 'owner' ? '#f39c12' : m.role === 'admin' ? '#e74c3c' : '#2a5cff', fontWeight: 600 }}>
                  {m.role === 'owner' ? '👑' : m.role === 'admin' ? '🛡️' : '👤'}
                </span>
                <span style={{ color: '#e6e6e6' }}>{m.accountName || m.userId.slice(0, 8)}</span>
                {m.siliconId && (
                  <span style={{ color: '#555', fontSize: '9px' }}>({m.siliconId})</span>
                )}
                {m.role !== 'owner' && m.role !== 'member' && m.role === 'admin' && (
                  <span style={{ color: '#e74c3c', fontSize: '9px', fontWeight: 600 }}>管理员</span>
                )}
                {/* 操作按钮 */}
                {canKick && m.userId !== myUserId && (
                  <button onClick={async () => {
                    if (confirm(`确定踢出 ${m.accountName || m.userId.slice(0, 8)}？`)) {
                      const r = await kickGroupMember(smcpGroupTarget.groupId, m.userId)
                      if (r.ok) { setGroupMembers(prev => prev.filter(x => x.userId !== m.userId)) }
                      else { alert(r.error || '踢出失败') }
                    }
                  }} style={{ marginLeft: 'auto', padding: '1px 5px', background: '#5c1a1a', border: '1px solid #e74c3c', borderRadius: '3px', color: '#e74c3c', fontSize: '9px' }}>踢出</button>
                )}
                {canSetAdmin && m.role === 'member' && (
                  <button onClick={async () => {
                    const r = await setGroupMemberRole(smcpGroupTarget.groupId, m.userId, 'admin')
                    if (r.ok) { setGroupMembers(prev => prev.map(x => x.userId === m.userId ? { ...x, role: 'admin' } : x)) }
                    else { alert(r.error || '设置失败') }
                  }} style={{ marginLeft: '4px', padding: '1px 5px', background: '#1a3c5c', border: '1px solid #3498db', borderRadius: '3px', color: '#3498db', fontSize: '9px' }}>设管理</button>
                )}
                {canSetAdmin && m.role === 'admin' && (
                  <button onClick={async () => {
                    const r = await setGroupMemberRole(smcpGroupTarget.groupId, m.userId, 'member')
                    if (r.ok) { setGroupMembers(prev => prev.map(x => x.userId === m.userId ? { ...x, role: 'member' } : x)) }
                    else { alert(r.error || '取消失败') }
                  }} style={{ marginLeft: '4px', padding: '1px 5px', background: '#3c3c1a', border: '1px solid #f39c12', borderRadius: '3px', color: '#f39c12', fontSize: '9px' }}>撤管理</button>
                )}
                {canTransfer && (
                  <button onClick={async () => {
                    if (confirm(`确定将群主转让给 ${m.accountName || m.userId.slice(0, 8)}？你将变为管理员`)) {
                      const r = await transferGroupOwner(smcpGroupTarget.groupId, m.userId)
                      if (r.ok) {
                        // 刷新成员列表
                        const info = await getGroupInfo(smcpGroupTarget.groupId)
                        if (info.members) setGroupMembers(info.members.map((mm: any) => ({ userId: mm.user_id, role: mm.role, accountName: mm.account_name, siliconId: mm.silicon_id })))
                      } else { alert(r.error || '转让失败') }
                    }
                  }} style={{ marginLeft: '4px', padding: '1px 5px', background: '#1a5c3c', border: '1px solid #2ecc71', borderRadius: '3px', color: '#2ecc71', fontSize: '9px' }}>转让</button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 消息搜索面板 */}
      {showSearch && (
        <div style={{
          padding: '6px 20px',
          background: '#141820',
          borderBottom: '1px solid #222',
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
        }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜索消息内容…"
            autoFocus
            style={{
              flex: 1,
              background: '#0f1115',
              border: '1px solid #333',
              borderRadius: '6px',
              padding: '4px 8px',
              color: '#e6e6e6',
              fontSize: '12px',
              outline: 'none',
            }}
          />
          <span style={{ fontSize: '11px', color: '#555' }}>
            {searchQuery ? `${messages.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase())).length} 条匹配` : ''}
          </span>
        </div>
      )}

       {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {messages.length === 0 && (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#7a8aa0',
            fontSize: '16px',
          }}>
            说点什么… 🦐
          </div>
        )}

        {messages.map((msg, idx) => {
          const isUser = msg.role === 'user'
          // Search filter
          const isSearchMatch = !searchQuery || msg.content.toLowerCase().includes(searchQuery.toLowerCase())
          const isSearchDim = showSearch && searchQuery && !isSearchMatch
          // Check if this is the last message in the same minute for timestamp grouping
          const msgMinute = new Date(msg.timestamp).getMinutes()
          const msgHour = new Date(msg.timestamp).getHours()
          const nextMsg = messages[idx + 1]
          const isLastInMinute = !nextMsg ||
            new Date(nextMsg.timestamp).getMinutes() !== msgMinute ||
            new Date(nextMsg.timestamp).getHours() !== msgHour ||
            nextMsg.role !== msg.role

          // Detect file message pattern
          const fileMatch = msg.content.match(/📎\s*\[([^\]]+)\]\(([^)]+)\)/)
          const isFileMsg = !!fileMatch

          // Detect group sender name (pattern: 👥 senderName: content or 🦐 prefix)
          const groupSenderMatch = isSmcp && !isUser && msg.content.match(/^(👥|🦐)\s*([^\s:：]+)[：:]\s*([\s\S]*)$/)

          // Task result message styling
          const isTaskResult = msg.is_task_result === true
          const tierIcon = msg.execution_tier === 'native' ? '⚡' :
                           msg.execution_tier === 'nuphus' ? '🤖' :
                           msg.execution_tier === 'freecode' ? '🧠' :
                           msg.execution_tier === 'fallback' ? '⚠️' : ''
          const tierBorder = msg.execution_tier === 'native' ? '#4CAF50' :
                             msg.execution_tier === 'nuphus' ? '#2196F3' :
                             msg.execution_tier === 'freecode' ? '#9C27B0' :
                             msg.execution_tier === 'fallback' ? '#FF9800' : ''

          return (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: isUser ? 'flex-end' : 'flex-start',
                maxWidth: '100%',
              }}
            >
              {/* Group sender name */}
              {groupSenderMatch && (
                <span style={{
                  fontSize: '14px',
                  color: '#aaa',
                  marginBottom: '2px',
                  marginLeft: '4px',
                }}>
                  {groupSenderMatch[2]}
                </span>
              )}
              <div
                style={{
                  maxWidth: isTaskResult ? '85%' : '70%',
                  padding: '10px 14px',
                  borderRadius: '10px',
                  lineHeight: '1.6',
                  fontSize: '14px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: isUser ? '#2a5cff' :
                             isTaskResult ? '#1a2a1a' : '#2a2a3a',
                  color: '#fff',
                  borderBottomRightRadius: isUser ? '4px' : undefined,
                  borderBottomLeftRadius: !isUser ? '4px' : undefined,
                  opacity: isSearchDim ? 0.3 : 1,
                  ...(isTaskResult && tierBorder ? { borderLeft: `3px solid ${tierBorder}` } : {}),
                }}
              >
                {isTaskResult ? (
                  /* Task result message rendering */
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '16px' }}>{tierIcon}</span>
                      <span style={{ fontWeight: 600, color: tierBorder || '#fff' }}>
                        {msg.task_status === 'success' ? '执行成功' :
                         msg.task_status === 'error' ? '执行失败' :
                         msg.task_status === 'rejected' ? '已拒绝' :
                         msg.task_status === 'timeout' ? '超时' : msg.task_status}
                      </span>
                      {msg.duration_ms != null && (
                        <span style={{ fontSize: '11px', color: '#aaa' }}>
                          ({msg.duration_ms < 1000 ? `${msg.duration_ms}ms` : `${(msg.duration_ms / 1000).toFixed(1)}秒`})
                        </span>
                      )}
                    </div>
                    <div>{msg.content}</div>
                    {/* Screenshots */}
                    {msg.screenshots && msg.screenshots.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
                        {msg.screenshots.map((src, i) => (
                          <img key={i} src={`data:image/png;base64,${src}`}
                            style={{ maxWidth: '100%', borderRadius: '4px', border: '1px solid #333' }}
                            alt={`截图 ${i + 1}`}
                          />
                        ))}
                      </div>
                    )}
                    {/* Multi-step execution */}
                    {msg.steps && msg.steps.length > 0 && (
                      <div style={{ marginTop: '6px' }}>
                        {msg.steps.map((step, i) => (
                          <div key={i} style={{
                            background: '#0f1115',
                            borderRadius: '4px',
                            padding: '4px 8px',
                            marginBottom: '4px',
                            borderLeft: '2px solid #2a5cff',
                          }}>
                            <span style={{ fontSize: '11px', color: '#7a8aa0' }}>步骤{step.step_num}:</span>
                            <span style={{ fontSize: '12px', marginLeft: '4px' }}>{step.description}</span>
                            {step.screenshot && (
                              <img src={`data:image/png;base64,${step.screenshot}`}
                                style={{ maxWidth: '100%', borderRadius: '4px', marginTop: '2px' }}
                                alt={`步骤${step.step_num}`}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.error_message && (
                      <div style={{ color: '#e74c3c', fontSize: '12px', marginTop: '4px' }}>
                        ⚠️ {msg.error_message}
                      </div>
                    )}
                  </div>
                ) : isFileMsg ? (
                  <div
                    onClick={() => {
                      if (fileMatch) {
                        const fileName = fileMatch[1]
                        const fileUrl = fileMatch[2]
  const invoke = (window as any).__TAURI__?.core?.invoke
                        if (invoke) {
                          invoke('download_and_open_file', { fileUrl, fileName }).catch(console.error)
                        } else {
                          window.open(fileUrl, '_blank')
                        }
                      }
                    }}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
                  >
                    <span style={{ fontSize: '18px' }}>📎</span>
                    <div>
                      <div style={{ fontSize: '14px', color: '#fff' }}>{fileMatch?.[1] || '文件'}</div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
                        {msg.content.match(/(\d+[BKMGT]B)/)?.[1] || '点击下载'}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {highlightText(msg.content, searchQuery)}
                    {msg.isStreaming && (
                      <span style={{
                        display: 'inline-block',
                        width: '2px',
                        height: '14px',
                        background: '#7a8aa0',
                        marginLeft: '2px',
                        animation: 'blink 1s infinite',
                      }} />
                    )}
                  </>
                )}
              </div>
              {/* Timestamp */}
              {isLastInMinute && (
                <span style={{
                  fontSize: '12px',
                  color: '#888',
                  marginTop: '2px',
                  marginRight: isUser ? '4px' : undefined,
                  marginLeft: !isUser ? '4px' : undefined,
                }}>
                  {formatTime(msg.timestamp)}
                </span>
              )}
            </div>
          )
        })}

        {/* Status indicator */}
        {statusText && (
          <div style={{
            alignSelf: 'flex-start',
            padding: '6px 12px',
            borderRadius: '8px',
            background: '#1c2030',
            color: status === 'deep_thinking' ? '#9b59b6' : '#7a8aa0',
            fontSize: '13px',
            fontStyle: 'italic',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            {statusText}
            {/* T018: 超时/断网错误 → 一键重试最后一条用户消息 */}
            {status === 'error' && onRetryLast && (
              <button
                onClick={onRetryLast}
                style={{
                  padding: '3px 12px',
                  borderRadius: '6px',
                  border: '1px solid #3d5afe',
                  background: 'rgba(61, 90, 254, 0.15)',
                  color: '#7a9bff',
                  fontSize: '12px',
                  fontStyle: 'normal',
                  cursor: 'pointer',
                }}
              >
                ↻ 重试
              </button>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Image attachment chips */}
      {(imageAttachments.length > 0 || isProcessingImage) && (
        <div style={{
          padding: '8px 20px',
          borderTop: '1px solid #222',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
        }}>
          {isProcessingImage && (
            <span style={{
              background: '#1c2030',
              border: '1px solid #444',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '12px',
              color: '#aaa',
            }}>
              📷 正在识别图片...
            </span>
          )}
          {imageAttachments.map((att, i) => (
            <span key={i} style={{
              background: '#1c2030',
              border: '1px solid #333',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}>
              📷 {att.name}
              {att.ocr_status === 'success' && (
                <span style={{ color: '#2ecc71', fontSize: '10px' }}>✓ OCR</span>
              )}
              {att.ocr_status === 'failed' && (
                <span style={{ color: '#e74c3c', fontSize: '10px' }}>OCR失败</span>
              )}
              {att.ocr_status === 'no_text' && (
                <span style={{ color: '#f39c12', fontSize: '10px' }}>无文字</span>
              )}
              {att.ocr_status === 'not_available' && (
                <span style={{ color: '#f39c12', fontSize: '10px' }}>OCR未安装</span>
              )}
              {att.ocr_status === 'pending' && (
                <span style={{ color: '#7a8aa0', fontSize: '10px' }}>处理中</span>
              )}
              <button
                onClick={() => handleRemoveAttachment(i)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#7a8aa0',
                  cursor: 'pointer',
                  padding: '0 2px',
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input bar */}
      {/* @提及弹出面板 */}
      {showMention && smcpGroupTarget && (
        <div style={{
          position: 'absolute',
          bottom: '70px',
          left: '20px',
          background: '#1c2030',
          border: '1px solid #333',
          borderRadius: '10px',
          padding: '6px 0',
          maxHeight: '200px',
          overflowY: 'auto',
          zIndex: 100,
          minWidth: '180px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <div style={{ padding: '4px 12px', fontSize: '11px', color: '#666' }}>选择要@的成员</div>
          {groupMembers
            .filter(m => {
              const name = m.accountName || m.siliconId || m.userId
              return !mentionFilter || name.toLowerCase().includes(mentionFilter.toLowerCase())
            })
            .map(m => {
              const name = m.accountName || m.siliconId || m.userId
              return (
                <div
                  key={m.userId}
                  onClick={() => {
                    // 替换@后面的文字为选中的名字
                    const lastAtIndex = input.lastIndexOf('@')
                    if (lastAtIndex >= 0) {
                      setInput(input.slice(0, lastAtIndex) + `@${name} `)
                    } else {
                      setInput(input + `@${name} `)
                    }
                    setShowMention(false)
                    setMentionFilter('')
                    inputRef.current?.focus()
                  }}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    color: '#e6e6e6',
                    fontSize: '13px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = '#252840'}
                  onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}
                >
                  <span style={{ fontSize: '10px', color: '#666' }}>{m.role === 'owner' ? '👑' : '👤'}</span>
                  <span>{name}</span>
                  {m.siliconId && <span style={{ fontSize: '10px', color: '#555' }}>{m.siliconId}</span>}
                </div>
              )
            })
          }
          {groupMembers.filter(m => {
            const name = m.accountName || m.siliconId || m.userId
            return !mentionFilter || name.toLowerCase().includes(mentionFilter.toLowerCase())
          }).length === 0 && (
            <div style={{ padding: '6px 12px', color: '#666', fontSize: '12px' }}>无匹配成员</div>
          )}
        </div>
      )}

      <div style={{
        display: 'flex',
        padding: isMobile ? '10px 10px' : '14px 20px',
        borderTop: '1px solid #222',
        gap: isMobile ? '6px' : '10px',
      }}>
        {/* SMCP标识 */}
        {isSmcp && (
          <span style={{
            background: '#1a2a1a',
            border: '1px solid #2a4a2a',
            borderRadius: '10px',
            padding: '0 12px',
            color: '#4a8',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
          }}>
            🦐 SMCP
          </span>
        )}

        {/* File upload button — for both local and SMCP chats */}
        <button
          onClick={handleFileSelect}
          title="上传文件/图片"
          disabled={isProcessingImage}
          style={{
            background: '#2a2a3a',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 16px',
            cursor: isProcessingImage ? 'wait' : 'pointer',
            fontSize: '16px',
            opacity: isProcessingImage ? 0.6 : 1,
          }}
        >
          📎
        </button>

        {/* ChatGPT button — local chat; desktop opens Safari, Android opens system browser (v4.1.1: 手机可见, 替代语音输入) */}
        {!isSmcp && (
        <button
          onClick={async () => {
            const invoke = (window as any).__TAURI__?.core?.invoke
            if (!invoke) return
            try {
              const result = await invoke('open_chatgpt_safari') as string
              console.log('[chatgpt]', result)
            } catch (e: any) {
              console.error('chatgpt error:', e)
              alert('打开ChatGPT失败: ' + String(e))
            }
          }}
          title="打开ChatGPT (需翻墙或激活码自动隧道)"
          style={{
            background: '#10a37f',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          ChatGPT
        </button>
        )}

        {/* Deep think toggle — local chat (v4.1.1: 手机放开, AgentChat在服务端执行与端无关) */}
        {!isSmcp && (
        <button
          onClick={() => {
            if (!serverConnected && !serverConnecting) {
              alert('服务端未连接，深度思考不可用。请检查网络后重新登录。')
              return
            }
            setDeepThinkMode(!deepThinkMode)
          }}
          title={!serverConnected ? '深度思考不可用(服务端未连接)' : deepThinkMode ? '关闭深度思考' : '开启深度思考(AgentChat多模型协作)'}
          disabled={serverConnecting}
          style={{
            background: !serverConnected ? '#1a1a2a' : deepThinkMode ? '#9b59b6' : '#2a2a3a',
            color: !serverConnected ? '#555' : '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
            cursor: !serverConnected || serverConnecting ? 'not-allowed' : 'pointer',
            fontSize: '13px',
            fontWeight: deepThinkMode ? 600 : 400,
            opacity: serverConnecting ? 0.5 : 1,
          }}
        >
          {serverConnecting ? '⏳ 连接中' : !serverConnected ? '🧠 ✗' : deepThinkMode ? '🧠 深度' : '🧠'}
        </button>
        )}

        {/* Feishu output toggle — only for local chat, desktop only */}
        {!isSmcp && !isMobile && (
        <button
          onClick={() => setFeishuOutput(!feishuOutput)}
          title={feishuOutput ? '关闭飞书输出' : '输出到飞书文档/消息'}
          style={{
            background: feishuOutput ? '#2ecc71' : '#2a2a3a',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: '0 12px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: feishuOutput ? 600 : 400,
          }}
        >
          {feishuOutput ? '飞书✓' : '飞书'}
        </button>
        )}

        {/* v4.1.1: 🎤语音输入按钮已移除 — 手机系统键盘自带语音输入, ChatGPT按钮替代 */}

        {/* Text input */}
        <input
          ref={inputRef}
          value={input}
          onChange={e => {
            const val = e.target.value
            setInput(val)
            // @提及触发：群聊中输入@时弹出成员列表
            if (smcpGroupTarget) {
              const lastAtIndex = val.lastIndexOf('@')
              if (lastAtIndex >= 0 && (lastAtIndex === 0 || val[lastAtIndex - 1] === ' ')) {
                const filter = val.slice(lastAtIndex + 1)
                if (!filter.includes(' ')) {
                  setMentionFilter(filter)
                  setShowMention(true)
                  return
                }
              }
              setShowMention(false)
            }
          }}
          onKeyDown={e => {
            if (showMention && e.key === 'Escape') {
              setShowMention(false)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={smcpGroupTarget ? `给 ${smcpGroupTarget.groupName} 发消息…` : smcpTarget ? `给 ${smcpHeaderName} 发消息…` : '说点什么…'}
          autoFocus
          style={{
            flex: 1,
            minWidth: 0,
            background: '#1c2030',
            border: '1px solid #333',
            borderRadius: '10px',
            padding: '10px 14px',
            color: '#e6e6e6',
            fontSize: '14px',
            outline: 'none',
          }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={status === 'thinking' || status === 'deep_thinking'}
          style={{
            background: isSmcp ? '#2a6a3a' : '#2a5cff',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            padding: isMobile ? '0 14px' : '0 22px',
            fontSize: '14px',
            cursor: (status === 'thinking' || status === 'deep_thinking') ? 'not-allowed' : 'pointer',
            opacity: (status === 'thinking' || status === 'deep_thinking') ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          {isSmcp ? '🦐 发送' : '发送'}
        </button>
      </div>

      {/* Blinking cursor animation + pulse animation */}
      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(231, 76, 60, 0); }
          100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); }
        }
      `}</style>
    </div>
  )
}
