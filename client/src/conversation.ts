/**
 * 硅侣3.0 — IM会话管理
 *
 * 多会话管理 + localStorage持久化
 * - Conversation: 单个对话(含消息列表+标题+时间戳)
 * - ConversationStore: 所有对话的CRUD + 持久化
 */

/** v4.4.4: 位置消息数据(GCJ-02坐标) */
export interface MessageLocation {
  lat: number
  lng: number
  label?: string
  accuracy?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isStreaming: boolean
  timestamp: number
  // Agent task result fields (optional)
  is_task_result?: boolean
  execution_tier?: string   // "native" | "nuphus" | "freecode" | "fallback" | "multi_step" | "none"
  task_status?: string      // "success" | "error" | "rejected" | "timeout"
  screenshots?: string[]    // base64 encoded
  duration_ms?: number
  error_message?: string
  steps?: MessageStep[]     // Multi-step execution (Computer Use)
  location?: MessageLocation // v4.4.4: 位置消息
}

export interface MessageStep {
  step_num: number
  description: string
  screenshot?: string
  status: string
}

export interface SmcpTarget {
  /** 对方用户ID */
  userId: string
  /** 对方Agent ID (如 A-xxxx-role) */
  agentId: string
  /** 对方Agent角色/昵称 */
  role: string
  /** 我方Agent ID */
  myAgentId: string
}

export interface SmcpGroupTarget {
  /** 群ID */
  groupId: string
  /** 群名 */
  groupName: string
  /** 成员数量 */
  memberCount?: number
  /** 成员列表 */
  members?: SmcpGroupMemberSimple[]
}

export interface SmcpGroupMemberSimple {
  userId: string
  role: string
  accountName?: string
  siliconId?: string
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  /** 如果是SMCP对话，记录对方信息；null=本地AI对话 */
  smcpTarget?: SmcpTarget | null
  /** 如果是SMCP群聊，记录群信息 */
  smcpGroupTarget?: SmcpGroupTarget | null
  /** 对话列表显示名（好友昵称或群名） */
  displayName?: string
  /** 副标题（硅侣号SM-XXXX或"N名成员"） */
  displaySubtitle?: string
  /** 好友在线状态 */
  onlineStatus?: 'online' | 'offline' | null
  /** 未读消息数 */
  unreadCount?: number
}

const STORAGE_KEY = 'siliconmate_conversations'

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function generateTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim()
  if (trimmed.length <= 20) return trimmed
  return trimmed.slice(0, 20) + '…'
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  } catch {
    // storage full or unavailable — silently ignore
  }
}

export function createConversation(firstMessage?: string, smcpTarget?: SmcpTarget, smcpGroupTarget?: SmcpGroupTarget): Conversation {
  const now = Date.now()
  const title = firstMessage
    ? generateTitle(firstMessage)
    : smcpGroupTarget
      ? `👥 ${smcpGroupTarget.groupName}`
      : smcpTarget
        ? `🦐 ${smcpTarget.role}`
        : '新对话'
  return {
    id: generateId(),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
    smcpTarget: smcpTarget || null,
    smcpGroupTarget: smcpGroupTarget || null,
  }
}

export function addMessage(conversation: Conversation, msg: Message): Conversation {
  const updated: Conversation = {
    ...conversation,
    messages: [...conversation.messages, msg],
    updatedAt: Date.now(),
  }
  if (conversation.messages.length === 0 && msg.role === 'user') {
    updated.title = generateTitle(msg.content)
  }
  return updated
}

export function updateLastAssistantMessage(conversation: Conversation, content: string, isStreaming: boolean): Conversation {
  const msgs = [...conversation.messages]
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      msgs[i] = { ...msgs[i], content, isStreaming }
      break
    }
  }
  return { ...conversation, messages: msgs, updatedAt: Date.now() }
}

export function deleteConversation(conversations: Conversation[], id: string): Conversation[] {
  return conversations.filter(c => c.id !== id)
}

/** 计算对话的显示名和在线状态 */
export function getConversationDisplay(
  conv: Conversation,
  friends?: any[], // SmcpFriend[]
  groups?: any[]   // SmcpGroup[]
): {
  displayName: string
  displaySubtitle: string
  onlineStatus: 'online' | 'offline' | null
} {
  // 群聊
  if (conv.smcpGroupTarget) {
    const group = groups?.find((g: any) => g.group_id === conv.smcpGroupTarget!.groupId)
    const groupName = group?.name || conv.smcpGroupTarget.groupName || '群聊'
    const memberCount = group?.member_count || 0
    return {
      displayName: groupName,
      displaySubtitle: memberCount > 0 ? `${memberCount}名成员` : '群聊',
      onlineStatus: null,
    }
  }

  // SMCP单聊
  if (conv.smcpTarget) {
    let friend = friends?.find((f: any) => f.friend_user_id === conv.smcpTarget!.userId)
    // v4.4.0: 老会话(userId为空, 仅有agentId)按 agentId 格式 A-{userId8}-siliconm 兜底匹配
    if (!friend && conv.smcpTarget.agentId && conv.smcpTarget.agentId.startsWith('A-')) {
      friend = friends?.find((f: any) => `A-${String(f.friend_user_id).slice(0, 8)}-siliconm` === conv.smcpTarget!.agentId)
    }
    // v4.4.0: 主显对方自设用户名, 备注作微信式后缀
    const primary = friend?.account_name || friend?.alias || conv.smcpTarget.role || '好友'
    const friendName = (friend?.account_name && friend?.alias)
      ? `${friend.account_name}（${friend.alias}）`
      : primary
    const siliconId = friend?.silicon_id || ''
    const isOnline = friend?.agent_status === 'online'
    return {
      displayName: friendName,
      displaySubtitle: siliconId ? siliconId : conv.smcpTarget.agentId.slice(0, 12),
      onlineStatus: isOnline ? 'online' : 'offline',
    }
  }

  // 本地AI对话
  return {
    displayName: conv.title || '新对话',
    displaySubtitle: '',
    onlineStatus: null,
  }
}
