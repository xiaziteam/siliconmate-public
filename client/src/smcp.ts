/**
 * 硅侣3.0 — SMCP前端状态管理
 *
 * 管理：注册/好友列表/消息轮询/好友请求
 * 所有调用走Tauri invoke → smcp.rs
 */

export interface SmcpFriend {
  friend_id: string
  friend_user_id: string
  status: string
  granted_perms: any
  received_perms: any
  alias: string | null
  created_at: string
  silicon_id?: string
  account_name?: string
  agent_status?: string
  last_heartbeat?: number
}

export interface SmcpPendingRequest {
  request_id: string
  from_user_id: string
  message: string
  proposed_perms: any
  created_at: string
  from_silicon_id?: string
  from_name?: string
}

export interface SmcpAgent {
  agent_id: string
  user_id: string
  role: string
  device: string
  capabilities: string[]
  last_seen: string
}

export interface SmcpMessage {
  msg_id: string
  from_agent: string
  from_user?: string
  to_agent: string
  to_user: string
  msg_type: string
  type: string
  method: string
  params: any
  timestamp: number
}

let _userId: string = ''
let _myAgentId: string = ''
let _registered: boolean = false
let _pollTimer: ReturnType<typeof setInterval> | null = null
let _onMessage: ((msg: SmcpMessage) => void) | null = null
let _lastPollTs: number = 0

const invoke = () => (window as any).__TAURI__?.core?.invoke

/** 登录成功后注册SMCP Agent */
export async function smcpInit(userId: string, role: string = 'siliconmate', device: string = 'macos'): Promise<boolean> {
  const inv = invoke()
  if (!inv) return false

  _userId = userId
  _myAgentId = `A-${userId.slice(0, 8)}-${role.slice(0, 8)}`

  try {
    const result = await inv('smcp_register', {
      userId,
      agentId: _myAgentId,
      role,
      device,
    })
    if (result?.ok) {
      _registered = true
      console.log('[SMCP] 注册成功:', _myAgentId)
    } else {
      // 可能已注册过，也算成功
      _registered = true
      console.log('[SMCP] 已注册或注册返回:', result)
    }
    return true
  } catch (e) {
    console.warn('[SMCP] 注册失败:', e)
    return false
  }
}

/** 获取我的Agent ID */
export function getMyAgentId(): string {
  return _myAgentId
}

/** 是否已注册 */
export function isRegistered(): boolean {
  return _registered
}

/** 获取好友列表 */
export async function getFriends(): Promise<SmcpFriend[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    const result = await inv('smcp_friend_list')
    // API returns {ok, data:{friends:[...]}} — unwrap data layer
    const data = result?.data || result
    return data?.friends || []
  } catch (e) {
    console.warn('[SMCP] 获取好友列表失败:', e)
    return []
  }
}

/** v4.4.0: 设置好友备注(微信式, 空串=清除) — 直连account-service公网端点 */
export async function setFriendAlias(friendUserId: string, alias: string): Promise<boolean> {
  try {
    const resp = await fetch('https://locatenotify.online/v1/smcp/friend/setAlias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Account-Id': _userId },
      body: JSON.stringify({ user_id: friendUserId, alias }),
    })
    const j = await resp.json()
    if (!j.ok) {
      console.warn('[SMCP] 设置备注失败:', j.message || j.error)
      return false
    }
    return true
  } catch (e) {
    console.warn('[SMCP] 设置备注失败:', e)
    return false
  }
}

/** 获取待处理好友请求 */
export async function getPendingRequests(): Promise<SmcpPendingRequest[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    const result = await inv('smcp_friend_requests')
    // API returns {ok, data:{pending_requests:[...]}} — unwrap
    const data = result?.data || result
    return data?.pending_requests || data?.requests || []
  } catch (e) {
    console.warn('[SMCP] 获取好友请求失败:', e)
    return []
  }
}

/** 发送好友请求(支持硅侣号SM-XXXX) */
export async function sendFriendRequest(
  toUserId: string,
  message: string,
  perms: any = { agent_comm: true },
  toSiliconId?: string
): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_friend_request', {
      toUserId,
      message,
      permissions: perms,
      toSiliconId: toSiliconId || '',
    })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 按硅侣号查找用户 */
export async function lookupSiliconId(siliconId: string): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_lookup', { siliconId })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 获取未读消息计数 */
export async function getUnreadCount(): Promise<number> {
  const inv = invoke()
  if (!inv) return 0
  try {
    const result = await inv('smcp_message_unread')
    const data = result?.data || result
    return data?.count || 0
  } catch (e) {
    return 0
  }
}

/** 标记消息已读 */
export async function markMessagesRead(msgIds: string[]): Promise<void> {
  const inv = invoke()
  if (!inv || msgIds.length === 0) return
  try {
    await inv('smcp_message_read', { msgIds })
  } catch (e) {
    // 静默失败
  }
}

/** 接受好友请求 */
export async function acceptFriendRequest(
  requestId: string,
  perms: any = { agent_comm: true }
): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_friend_accept', {
      requestId,
      permissions: perms,
    })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 拒绝好友请求 (T027) */
export async function rejectFriendRequest(requestId: string): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_friend_reject', { requestId })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 设置好友权限 */
export async function setFriendPermissions(
  friendUserId: string,
  perms: any
): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_friend_set_permissions', {
      friendUserId,
      permissions: perms,
    })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 删除好友 */
export async function removeFriend(friendUserId: string): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_friend_remove', { friendUserId })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 发送SMCP消息 */
export async function sendMessage(
  toAgent: string,
  toUser: string,
  text: string,
  extraParams?: any
): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_message_send', {
      fromAgent: _myAgentId,
      toAgent,
      toUser,
      msgType: 'notify',
      method: 'chat',
      params: { text, ...extraParams },
    })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 轮询消息(手动触发) */
export async function pollMessages(agentId?: string): Promise<SmcpMessage[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    const result = await inv('smcp_message_poll', {
      agentId: agentId || _myAgentId,
      limit: 50,
    })
     // API returns {ok, data:{messages:[...]}} — unwrap
     const data = result?.data || result
     const msgs: SmcpMessage[] = data?.messages || []
     // 只返回新消息
     const newMsgs = msgs.filter(m => m.timestamp > _lastPollTs && m.from_agent !== _myAgentId)
     if (msgs.length > 0) {
       _lastPollTs = Math.max(...msgs.map(m => m.timestamp), _lastPollTs)
     }
     return newMsgs
  } catch (e) {
    console.warn('[SMCP] 轮询失败:', e)
    return []
  }
}

/** 启动自动轮询 */
export function startPolling(
  onMessage: (msg: SmcpMessage) => void,
  intervalMs: number = 3000
): void {
  stopPolling()
  _onMessage = onMessage
  // T023: Android 上由 Kotlin SmcpAgentService 权威轮询 — 服务端 message/poll 是消费型队列
  // (delivered=0→1), JS 与 Kotlin 双端轮询会互相抢消息; 消息经 onSmcpMessages 事件进入前端
  if ((window as any).NativeBridge) {
    console.log('[SMCP] Android: JS polling disabled — Kotlin SmcpAgentService is the authoritative poller')
    return
  }
  console.log('[SMCP] startPolling: _registered=' + _registered)
  _pollTimer = setInterval(async () => {
    if (!_registered) return
    try {
      const newMsgs = await pollMessages()
      for (const msg of newMsgs) {
        _onMessage?.(msg)
      }
    } catch (e) {
      console.warn('[SMCP] poll error:', e)
    }
  }, intervalMs)
  // 首次立即轮询一次
  pollMessages().then(msgs => msgs.forEach(m => _onMessage?.(m))).catch(e => console.warn('[SMCP] first poll error:', e))
}

/** 停止自动轮询 */
export function stopPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _onMessage = null
}

/** Ping中继服务器 */
export async function ping(): Promise<boolean> {
  const inv = invoke()
  if (!inv) return false
  try {
    const result = await inv('smcp_ping')
    const data = result?.data || result
    return result?.ok || data?.ok || false
  } catch {
    return false
  }
}

// ===== 群聊 =====

export interface SmcpGroup {
  group_id: string
  name: string
  creator_id: string
  created_at: string
  member_count?: number
}

export interface SmcpGroupMember {
  user_id: string
  role: string
  joined_at: string
  account_name?: string
  silicon_id?: string
}

/** 创建群聊 */
export async function createGroup(name: string, memberIds: string[]): Promise<{ ok: boolean; group_id?: string; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_create', { name, memberIds })
    const data = result?.data || result
    return { ok: true, group_id: data?.group_id }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 列出我加入的群 */
export async function getGroups(): Promise<SmcpGroup[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    const result = await inv('smcp_group_list')
    const data = result?.data || result
    return data?.groups || []
  } catch (e) {
    console.warn('[SMCP] 获取群列表失败:', e)
    return []
  }
}

/** 获取群信息+成员 */
export async function getGroupInfo(groupId: string): Promise<{ ok: boolean; group?: any; members?: SmcpGroupMember[]; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_info', { groupId })
    const data = result?.data || result
    return { ok: true, group: data, members: data?.members }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 邀请用户加群 */
export async function inviteToGroup(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_invite', { groupId, userId })
    const data = result?.data || result
    return { ok: result?.ok || data?.ok }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 退出群 */
export async function leaveGroup(groupId: string): Promise<{ ok: boolean; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_leave', { groupId })
    return { ok: result?.ok !== false }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 踢出群成员 */
export async function kickGroupMember(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_kick', { groupId, userId })
    const data = result?.data || result
    return { ok: result?.ok !== false }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 转让群主 */
export async function transferGroupOwner(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_transfer', { groupId, userId })
    return { ok: result?.ok !== false }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 设置成员角色 (admin/member) */
export async function setGroupMemberRole(groupId: string, userId: string, role: string): Promise<{ ok: boolean; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_set_role', { groupId, userId, role })
    return { ok: result?.ok !== false }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 修改群信息 */
export async function updateGroup(groupId: string, name?: string): Promise<{ ok: boolean; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_update', { groupId, name })
    return { ok: result?.ok !== false }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 向群发消息 */
export async function sendGroupMessage(
  groupId: string,
  params: any,
  msgType: string = 'notify',
  method: string = 'im.send'
): Promise<{ ok: boolean; msg_id?: string; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_group_message_send', {
      fromAgent: _myAgentId,
      groupId,
      type: msgType,
      method,
      params,
    })
    const data = result?.data || result
    return { ok: true, msg_id: data?.msg_id }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// ===== 文件传输 =====

export interface SmcpFileUploadResult {
  ok: boolean
  file_id?: string
  filename?: string
  size?: number
  url?: string
  error?: string
}

/** 上传文件到中继服务器（base64编码） */
export async function uploadFile(
  filename: string,
  data: string, // base64
  contentType: string = 'application/octet-stream'
): Promise<SmcpFileUploadResult> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('smcp_file_upload', { filename, data, contentType })
    const d = result?.data || result
    return { ok: true, file_id: d?.file_id, filename: d?.filename, size: d?.size, url: d?.url }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 获取文件下载URL */
export function getFileDownloadUrl(fileId: string): string {
  return `https://locatenotify.online/v1/smcp/file/download/${fileId}`
}

// ===== OCR + 文件选择 =====

/** OCR提取图片文字 (Android NativeBridge / macOS Rust) */
export async function extractTextFromImage(imagePath: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('ocr_extract_text', { imagePath })
    const data = result?.data || result
    return { ok: true, text: data?.text || data?.ocr_text || '' }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 打开文件选择器 (Android NativeBridge) */
export async function pickFile(): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const inv = invoke()
  if (!inv) return { ok: false, error: 'Tauri not available' }
  try {
    const result = await inv('pick_file')
    const data = result?.data || result
    return { ok: true, path: data?.path, name: data?.name }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** 发送群消息(带文件附件) */
export async function sendGroupMessageWithFile(
  groupId: string,
  text: string,
  fileData?: { filename: string; data: string; contentType: string }
): Promise<{ ok: boolean; msg_id?: string; error?: string }> {
  let fileParams: any = {}
  if (fileData) {
    const uploadResult = await uploadFile(fileData.filename, fileData.data, fileData.contentType)
    if (uploadResult.ok && uploadResult.file_id) {
      fileParams = { file_id: uploadResult.file_id, filename: uploadResult.filename, file_size: uploadResult.size }
    }
  }
  return sendGroupMessage(groupId, { content: text, ...fileParams })
}

/** 上传文件用于传输(别名) */
export async function uploadFileForTransfer(
  filename: string,
  data: string,
  contentType: string = 'application/octet-stream'
): Promise<SmcpFileUploadResult> {
  return uploadFile(filename, data, contentType)
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/** 格式化时间戳为HH:mm */
export function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// ===== Task/Result 消息协议 (Agent能力) =====

export interface TaskResult {
  task_id: string
  status: string        // "success" | "error" | "rejected" | "timeout"
  data: any
  screenshots: string[]  // base64 encoded
  error_message: string | null
  execution_tier: string // "native" | "nuphus" | "freecode" | "fallback"
  duration_ms: number
  created_at: number
}

export interface CapabilityInfo {
  name: string
  tier: string
  description: string
  available: boolean
}

/** 执行本地task（三层路由：原生→Nuphus→降级） */
export async function taskExecute(capability: string, params: any = {}): Promise<TaskResult> {
  const inv = invoke()
  if (!inv) return {
    task_id: '',
    status: 'error',
    data: {},
    screenshots: [],
    error_message: 'Tauri not available',
    execution_tier: 'none',
    duration_ms: 0,
    created_at: Date.now(),
  }
  try {
    return await inv('task_execute', { capability, params }) as TaskResult
  } catch (e: any) {
    return {
      task_id: '',
      status: 'error',
      data: {},
      screenshots: [],
      error_message: String(e),
      execution_tier: 'none',
      duration_ms: 0,
      created_at: Date.now(),
    }
  }
}

/** 发送task给好友 */
export async function taskSend(
  friendAgentId: string,
  friendUserId: string,
  capability: string,
  params: any = {}
): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return await inv('smcp_task_send', {
      toAgent: friendAgentId,
      toUser: friendUserId,
      taskId,
      capability,
      params,
    })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 列出本机可用能力 */
export async function listCapabilities(): Promise<CapabilityInfo[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    return await inv('task_list_capabilities') as CapabilityInfo[]
  } catch (e) {
    console.warn('[SMCP] listCapabilities failed:', e)
    return []
  }
}

/** 检查权限策略 */
export async function permissionCheck(friendId: string, capability: string): Promise<string> {
  const inv = invoke()
  if (!inv) return 'ask'
  try {
    const result = await inv('permission_check', { friendId, capability })
    return result?.policy || 'ask'
  } catch (e) {
    return 'ask'
  }
}

/** 设置权限策略 */
export async function permissionSet(friendId: string, capability: string, policy: string): Promise<boolean> {
  const inv = invoke()
  if (!inv) return false
  try {
    const result = await inv('permission_set', { friendId, capability, policy })
    return result?.success || false
  } catch (e) {
    return false
  }
}

/** 检查远程task审批超时 */
export async function taskCheckTimeouts(): Promise<string[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    return await inv('task_check_timeouts') as string[]
  } catch (e) {
    console.warn('[SMCP] taskCheckTimeouts failed:', e)
    return []
  }
}

/** 移除已审批的挂起远程task */
export async function taskRemovePendingRemote(taskId: string): Promise<boolean> {
  const inv = invoke()
  if (!inv) return false
  try {
    const result = await inv('task_remove_pending_remote', { taskId })
    return result?.success || false
  } catch (e) {
    return false
  }
}

/** 发送远程任务结果 */
export async function taskResultSend(
  toAgent: string,
  toUser: string,
  taskId: string,
  status: string,
  data: any,
  screenshots: string[],
  executionTier: string,
  durationMs: number,
  errorMessage: string,
): Promise<any> {
  const inv = invoke()
  if (!inv) return { error: 'Tauri not available' }
  try {
    return await inv('smcp_task_result_send', {
      toAgent,
      toUser,
      taskId,
      status,
      data,
      screenshots,
      executionTier,
      durationMs,
      errorMessage,
    })
  } catch (e) {
    return { error: String(e) }
  }
}

/** 查询好友能力声明 */
export async function friendCapabilities(friendAgentId: string): Promise<CapabilityInfo[]> {
  const inv = invoke()
  if (!inv) return []
  try {
    const result = await inv('smcp_friend_capabilities', { friendAgentId })
    const data = result?.data || result
    const caps = data?.capabilities || []
    return caps.map((c: any) => ({
      name: c.name || c,
      tier: c.tier || 'unknown',
      description: c.description || '',
      available: true,
    }))
  } catch (e) {
    console.warn('[SMCP] friendCapabilities failed:', e)
    return []
  }
}
