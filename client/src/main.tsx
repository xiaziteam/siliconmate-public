/**
 * 硅侣3.0 — 入口
 * 
 * 平台适配: macOS用Tauri invoke, Android用NativeBridge
 * 在Android上注入__TAURI__适配层，让前端代码无需修改
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'

// Android NativeBridge适配: 注入__TAURI__.core.invoke
if (!(window as any).__TAURI__ && (window as any).NativeBridge) {
  const NB = (window as any).NativeBridge
  const accountStore: { accountId: string; siliconId: string; apiKey: string; activated: boolean } = { accountId: '', siliconId: '', apiKey: '', activated: false }

  // v4.1.1: 会话恢复 — 冷启动从localStorage回灌accountStore(内存态), 并同步Kotlin侧userId
  // 无此步骤时 connect_server/send_message 判"未登录", 用户被迫二次登录
  try {
    const savedId = localStorage.getItem('siliconmate_session_id') || ''
    if (savedId) {
      accountStore.accountId = savedId
      accountStore.siliconId = localStorage.getItem('siliconmate_silicon_id') || ''
      accountStore.activated = localStorage.getItem('siliconmate_activated') === '1'
      NB.setUserId(savedId)
      console.log('[NativeBridge] 会话恢复:', savedId.slice(0, 8), 'activated:', accountStore.activated)
    }
  } catch (e) {
    console.warn('[NativeBridge] 会话恢复失败:', e)
  }

  ;(window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any = {}) => {
        // 适配Tauri命令到NativeBridge方法
        switch (cmd) {
          // Account
          case 'l1_login': {
            const r = JSON.parse(NB.login(args.accountName, args.password))
            if (r.ok && r.data) {
              accountStore.accountId = r.data.account_id
              accountStore.siliconId = r.data.silicon_id || ''
              accountStore.apiKey = r.data.api_key || ''
              accountStore.activated = r.data.activated === true
              NB.setUserId(r.data.account_id)
            }
            return r.data
          }
          case 'register': {
            const r = JSON.parse(NB.register(args.accountName, args.password))
            if (r.ok && r.data) {
              accountStore.accountId = r.data.account_id
              accountStore.siliconId = r.data.silicon_id || ''
              NB.setUserId(r.data.account_id)
            }
            return r.data
          }
          case 'guest_enter': throw new Error('访客模式已停用, 请注册或登录账号')
          case 'finish_enter': return {}
          case 'apply_session': return { session_id: accountStore.accountId }
          case 'account_info': {
            // v4.2.1: 冷启动恢复拉取账号信息(用户名/硅侣号) — 直连account-service公网端点
            const resp = await fetch('https://locatenotify.online/v1/account/info', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ account_id: args.accountId || accountStore.accountId }),
            })
            const j = await resp.json()
            if (!j.ok) throw new Error(j.error || '账号信息获取失败')
            return j.data
          }
          case 'account_change_password': {
            // v4.2.2: 修改密码(旧密码验证式)
            const resp = await fetch('https://locatenotify.online/v1/auth/change_password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                account_id: accountStore.accountId,
                old_password: args.oldPassword,
                new_password: args.newPassword,
              }),
            })
            const j = await resp.json()
            if (!j.ok) throw new Error(j.message || j.error || '修改密码失败')
            return j.data
          }
          case 'account_change_username': {
            // v4.3.0: 修改用户名(旧密码验证, 硅侣号不变)
            const resp = await fetch('https://locatenotify.online/v1/auth/change_username', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                account_id: accountStore.accountId,
                old_password: args.oldPassword,
                new_username: args.newUsername,
              }),
            })
            const j = await resp.json()
            if (!j.ok) throw new Error(j.message || j.error || '修改用户名失败')
            return j.data
          }
          case 'account_activate': {
            // US2: Promise 回调模式 — Kotlin 异步调 /v1/activate/bind,
            // 完成后注入 window.__activateResolve('ok', plan) / __activateReject(reason)
            return await new Promise((resolve, reject) => {
              let timer: any = null
              const cleanup = () => {
                if (timer) clearTimeout(timer)
                delete (window as any).__activateResolve
                delete (window as any).__activateReject
              }
              timer = setTimeout(() => {
                cleanup()
                reject(new Error('激活超时: 请检查网络后重试'))
              }, 45000)
              ;(window as any).__activateResolve = (status: string, plan?: string) => {
                cleanup()
                if (status === 'ok') {
                  // T029: 激活成功同步登录态(状态条三态判据)
                  accountStore.activated = true
                  // Android 端隧道由 Kotlin 原生启动, tunnel 返回 null
                  resolve({ plan: plan || 'basic', activated: true, tunnel: null })
                } else {
                  reject(new Error('激活失败: ' + String(status)))
                }
              }
              ;(window as any).__activateReject = (reason: string) => {
                cleanup()
                reject(new Error(String(reason || '激活失败')))
              }
              try {
                NB.activate(String(args.code))
              } catch (e: any) {
                cleanup()
                reject(new Error('激活请求发送失败: ' + String(e?.message || e)))
              }
            })
          }
          case 'heartbeat': return 'alive'
          // T028: 连接状态真实化 — 登录态 + 服务端心跳双驱动(FR-014),
          // 返回 {status:'connected'|'offline', activated}; 不再抛错(离线是合法态)
          case 'connect_server': {
            try {
              const ctrl = new AbortController()
              const timer = setTimeout(() => ctrl.abort(), 8000)
              const resp = await fetch('https://locatenotify.online/v1/smcp/ping', { signal: ctrl.signal })
              clearTimeout(timer)
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
              const json = await resp.json()
              if (!json?.ok) throw new Error('服务端返回异常')
              return {
                status: accountStore.accountId ? 'connected' : 'offline',
                activated: accountStore.activated,
              }
            } catch {
              return { status: 'offline', activated: accountStore.activated }
            }
          }
          case 'check_agent_health': return true

          // Agent (US3: 云端 AI 聊天, opencode 多轮上下文由服务端 session 维持)
          case 'send_message': {
            // T016/T030: 真实云端聊天 — 95s 客户端中止: 服务端 OPENCODE_MSG_TIMEOUT=90s
            // 会先返回结构化 504(ai_timeout), 客户端取 95s 避免同点竞态; 仍 < nginx 120s
            const message = String(args?.message || '')
            const ocrContext = args?.ocrContext ? String(args.ocrContext) : ''
            const fullMessage = ocrContext ? `${message}\n\n[图片OCR内容]\n${ocrContext}` : message
            if (!message.trim()) throw new Error('消息为空')
            if (!accountStore.accountId) throw new Error('未登录, 无法发送消息')
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 95000)
            try {
              const resp = await fetch('https://locatenotify.online/v1/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ message: fullMessage }),
                signal: ctrl.signal,
              })
              if (resp.status === 401) throw new Error('账号验证失败, 请重新登录')
              if (resp.status === 403) throw new Error('账号未激活, 请先激活')
              if (resp.status === 429) throw new Error('请求过于频繁, 请稍后再试')
              if (resp.status === 504) throw new Error('AI 响应超时, 请重试')
              if (!resp.ok) throw new Error(`服务异常 (HTTP ${resp.status})`)
              const json = await resp.json()
              if (!json?.ok || !json?.data?.reply) throw new Error(json?.error || '服务端返回异常')
              return json.data.reply as string
            } catch (e: any) {
              if (e?.name === 'AbortError') throw new Error('AI 响应超时(95秒), 请检查网络后重试')
              throw e
            } finally {
              clearTimeout(timer)
            }
          }
          case 'chat_history': {
            // T017: 云端聊天历史 — GET /v1/chat/history (fail-open, 不阻塞 UI)
            const empty = { messages: [], count: 0 }
            if (!accountStore.accountId) return empty
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 10000)
            try {
              const resp = await fetch('https://locatenotify.online/v1/chat/history', {
                headers: { 'X-Account-Id': accountStore.accountId },
                signal: ctrl.signal,
              })
              if (!resp.ok) return empty
              const json = await resp.json()
              if (json?.ok && Array.isArray(json?.data?.messages)) {
                return { messages: json.data.messages, count: json.data.count ?? json.data.messages.length }
              }
              return empty
            } catch {
              return empty
            } finally {
              clearTimeout(timer)
            }
          }
          case 'route_message': return { ClientAgent: {} }
          case 'start_tunnel': return 'ok'
          case 'process_image': {
            // On Android, try OCR via NativeBridge first
            if (NB.ocrExtractText) {
              try {
                const r = JSON.parse(NB.ocrExtractText(args.imagePath))
                const data = r?.data || r
                return {
                  path: args.imagePath,
                  name: args.imagePath.split('/').pop() || 'image',
                  ocr_text: data?.text || null,
                  ocr_status: data?.text ? 'success' : (data?.error ? 'failed' : 'no_text'),
                  file_size: 0,
                }
              } catch (e) {
                return { path: args.imagePath, name: 'image', ocr_text: null, ocr_status: 'failed', file_size: 0 }
              }
            }
            return { path: '', name: '', ocr_text: null, ocr_status: 'not_available', file_size: 0 }
          }
          case 'open_chatgpt_safari': return 'ChatGPT模式暂不可用'

          // SMCP
          case 'smcp_register': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/agent/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ user_id: args.userId, agent_id: args.agentId, role: args.role, device: args.device, capabilities: args.capabilities || ['im', 'tunnel', 'notify'] }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { ok: true }
            }
          }
          case 'smcp_agent_list': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/agent/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ user_id: accountStore.accountId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { agents: [] }
            }
          }
          case 'smcp_message_send': {
            const r = JSON.parse(NB.smcpSendMessage(args.fromAgent, args.toAgent, args.toUser, args.msgType, args.method, JSON.stringify(args.params)))
            return r?.data || r
          }
          case 'smcp_message_poll': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/message/poll', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ agent_id: args.agentId, limit: args.limit || 50 }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { messages: [] }
            }
          }
          case 'smcp_friend_request': {
            if (args.toSiliconId) {
              const r = JSON.parse(NB.smcpFriendRequestBySiliconId(args.toSiliconId, args.message, JSON.stringify(args.permissions || {})))
              return r?.data || r
            }
            const r = JSON.parse(NB.smcpFriendRequest(args.toUserId || '', args.message, JSON.stringify(args.permissions || {})))
            return r?.data || r
          }
          case 'smcp_friend_accept': {
            const r = JSON.parse(NB.smcpFriendAccept(args.requestId, JSON.stringify(args.permissions || {})))
            return r?.data || r
          }
          case 'smcp_friend_reject': {
            const r = JSON.parse(NB.smcpFriendReject(args.requestId))
            return r?.data || r
          }
          case 'smcp_friend_list': {
            const r = JSON.parse(NB.smcpFriendList())
            return r?.data || r
          }
          case 'smcp_friend_set_permissions': {
            const r = JSON.parse(NB.smcpSetPermissions(args.friendUserId, JSON.stringify(args.permissions || {})))
            return r?.data || r
          }
          case 'smcp_friend_remove': {
            const r = JSON.parse(NB.smcpFriendRemove(args.friendUserId))
            return r?.data || r
          }
          case 'smcp_friend_requests': {
            const r = NB.smcpPendingRequests()
            const parsed = JSON.parse(r)
            // API returns {ok, data:{pending_requests:[...]}} but frontend expects {requests:[...]}
            if (parsed?.data?.pending_requests) {
              return { requests: parsed.data.pending_requests }
            }
            return parsed?.data || parsed
          }
          case 'smcp_ping': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/ping', {
                method: 'GET',
                headers: { 'X-Account-Id': accountStore.accountId },
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { ok: false }
            }
          }
          case 'smcp_lookup': {
            const r = JSON.parse(NB.smcpLookup(args.siliconId))
            return r?.data || r
          }
          case 'smcp_message_unread': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/message/unread', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({}),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { count: 0 }
            }
          }
          case 'smcp_message_read': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/message/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ msg_ids: args.msgIds || [] }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) {
              return { updated: 0 }
            }
          }
          // ===== 群聊 =====
          case 'smcp_group_create': {
            if (NB.smcpGroupCreate) {
              try {
                const r = JSON.parse(NB.smcpGroupCreate(args.name, JSON.stringify(args.memberIds || [])))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            // Fallback to fetch for macOS
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/group/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ name: args.name, member_ids: args.memberIds || [] }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_list': {
            if (NB.smcpGroupList) {
              try {
                const r = JSON.parse(NB.smcpGroupList())
                return r?.data || r
              } catch (e) { return { groups: [] } }
            }
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/group/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({}),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { groups: [] } }
          }
          case 'smcp_group_info': {
            if (NB.smcpGroupInfo) {
              try {
                const r = JSON.parse(NB.smcpGroupInfo(args.groupId))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/group/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ group_id: args.groupId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_invite': {
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/group/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ group_id: args.groupId, user_id: args.userId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_leave': {
            if (NB.smcpGroupLeave) {
              try {
                const r = JSON.parse(NB.smcpGroupLeave(args.groupId))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/group/leave', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({ group_id: args.groupId }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_group_message_send': {
            if (NB.smcpGroupMessageSend) {
              try {
                const r = JSON.parse(NB.smcpGroupMessageSend(args.groupId, args.type || 'notify', args.method || 'im.send', JSON.stringify(args.params || {})))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/group/message/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({
                  from_agent: args.fromAgent,
                  group_id: args.groupId,
                  type: args.type || 'notify',
                  method: args.method || 'im.send',
                  params: args.params || {},
                }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_file_upload': {
            if (NB.smcpFileUpload) {
              try {
                const r = JSON.parse(NB.smcpFileUpload(args.filename, args.data, args.contentType || 'application/octet-stream'))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            try {
              const resp = await fetch('https://locatenotify.online/v1/smcp/file/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountStore.accountId },
                body: JSON.stringify({
                  filename: args.filename,
                  data: args.data,
                  content_type: args.contentType || 'application/octet-stream',
                }),
              })
              const json = await resp.json()
              return json?.data || json
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'smcp_file_upload_by_path': {
            if (NB.smcpFileUploadByPath) {
              try {
                const r = JSON.parse(NB.smcpFileUploadByPath(args.filePath))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            return { ok: false, error: 'Not available on this platform' }
          }
          case 'download_and_open_file': {
            if (NB.downloadAndOpenFile) {
              try {
                const r = JSON.parse(NB.downloadAndOpenFile(args.fileUrl, args.fileName || ''))
                return r?.data || r
              } catch (e) { return { ok: false, error: String(e) } }
            }
            // macOS: open URL in browser
            try {
              window.open(args.fileUrl, '_blank')
              return { ok: true }
            } catch (e) { return { ok: false, error: String(e) } }
          }
          // ===== OCR + 文件选择 =====
          case 'ocr_extract_text': {
            if (NB.ocrExtractText) {
              try {
                const r = JSON.parse(NB.ocrExtractText(args.imagePath))
                return r?.data || r
              } catch (e) { return { ok: false, text: '', error: String(e) } }
            }
            // macOS fallback: invoke Rust OCR
            return null
          }
          case 'pick_file': {
            if (NB.pickFile) {
              try {
                const r = NB.pickFile()
                const parsed = typeof r === 'string' ? JSON.parse(r) : r
                return parsed?.data || parsed
              } catch (e) { return { ok: false, error: String(e) } }
            }
            return null
          }
          // ===== T023: 远程任务协议桥(US7 任务执行闭环) =====
          case 'task_execute': {
            // 执行本地任务 → TaskResult JSON(静态执行器与 Kotlin 预授权路径共用)
            try {
              const r = NB.taskExecute(String(args?.capability || ''), JSON.stringify(args?.params || {}))
              return typeof r === 'string' ? JSON.parse(r) : r
            } catch (e) {
              return { task_id: '', status: 'error', data: {}, screenshots: [], error_message: String(e), execution_tier: 'none', duration_ms: 0, created_at: Date.now() }
            }
          }
          case 'task_list_capabilities': {
            // 本机能力清单 — 代答LLM工具目录
            try {
              const r = NB.taskListCapabilities()
              return typeof r === 'string' ? JSON.parse(r) : r
            } catch (e) {
              return []
            }
          }
          case 'smcp_task_result_send': {
            // T020: 回传 type:"result" 消息给发起方
            try {
              const r = NB.smcpTaskResultSend(
                String(args?.toAgent || ''), String(args?.toUser || ''), String(args?.taskId || ''),
                String(args?.status || 'error'), JSON.stringify(args?.data || {}),
                JSON.stringify(args?.screenshots || []), String(args?.executionTier || 'none'),
                Number(args?.durationMs || 0), String(args?.errorMessage || ''),
              )
              return typeof r === 'string' ? JSON.parse(r) : r
            } catch (e) { return { ok: false, error: String(e) } }
          }
          case 'task_remove_pending_remote': {
            // 清除 Kotlin 侧待审批任务(防120s看门狗重复回传timeout)
            try {
              return { success: NB.smcpTaskResolve(String(args?.taskId || '')) }
            } catch (e) { return { success: false, error: String(e) } }
          }
          case 'permission_set': {
            try {
              return { success: NB.permissionSet(String(args?.friendId || ''), String(args?.capability || ''), String(args?.policy || 'ask')) }
            } catch (e) { return { success: false, error: String(e) } }
          }
          case 'permission_check': {
            try {
              return { policy: NB.permissionCheck(String(args?.friendId || ''), String(args?.capability || '')) }
            } catch (e) { return { policy: 'ask' } }
          }
          case 'task_check_timeouts': {
            // Android: 超时由 Kotlin 120s看门狗负责, 前端5分钟例行检查为no-op
            return []
          }
          // v4.1.1: 诊断桥 — App.tsx js_log打点落 logcat(onConsoleMessage → "JS:" 行)
          case 'js_log': {
            console.log('[js_log]', String(args?.msg || ''))
            return true
          }
          // v4.1.1: ChatGPT跳转 — Android系统浏览器打开(桌面版仍走Tauri open_chatgpt_safari)
          case 'open_chatgpt_safari': {
            if (!NB.openChatgpt) throw new Error('本机不支持打开ChatGPT')
            return String(NB.openChatgpt())
          }
          default:
            console.warn('[NativeBridge] unhandled command:', cmd)
            return null
        }
      },
    },
    event: {
      listen: async () => () => {},
    },
  }
  console.log('[NativeBridge] __TAURI__适配层已注入')

  // T022/T023: Kotlin SmcpAgentService 事件入口(任务审批/好友申请)
  ;(window as any).__onSmcpEvent = (payload: string) => {
    try {
      const ev = typeof payload === 'string' ? JSON.parse(payload) : payload
      if (ev?.type === 'task_request') {
        // task=null 表示任务已超时/已处理 → 通知前端关闭审批弹窗
        window.dispatchEvent(new CustomEvent('smcp-task-request', { detail: { task: ev.task || null } }))
      } else if (ev?.type === 'friend_request') {
        window.dispatchEvent(new CustomEvent('smcp-friend-request', { detail: { count: ev.count || 0 } }))
      }
    } catch (e) {
      console.warn('[NativeBridge] __onSmcpEvent parse error:', e)
    }
  }

  // Android通知点击回调
  ;(window as any).__siliconmate_native = {
    onNotificationChatOpen: (fromUser: string) => {
      console.log('[NativeBridge] notification chat open:', fromUser)
      // 触发自定义事件让App.tsx处理
      window.dispatchEvent(new CustomEvent('smcp-notification-chat', { detail: { fromUser } }))
    },
    // T024: 好友申请通知点击 → 拉起好友面板
    onNotificationFriendsOpen: () => {
      console.log('[NativeBridge] notification friends open')
      window.dispatchEvent(new CustomEvent('smcp-open-friends', { detail: {} }))
    },
    onOcrResult: (text: string) => {
      console.log('[NativeBridge] OCR result:', text?.substring(0, 50))
      window.dispatchEvent(new CustomEvent('ocr-result', { detail: { text } }))
    },
    onOcrError: (error: string) => {
      console.log('[NativeBridge] OCR error:', error)
      window.dispatchEvent(new CustomEvent('ocr-error', { detail: { error } }))
    },
    // T023: Kotlin 消息轮询推送入口(此前缺失 → Kotlin 推送全部丢失;
    // Android 上 JS 轮询已禁用, 本回调是消息进入前端的唯一通道)
    onSmcpMessages: (messagesJson: string) => {
      try {
        const msgs = typeof messagesJson === 'string' ? JSON.parse(messagesJson) : messagesJson
        if (Array.isArray(msgs) && msgs.length > 0) {
          window.dispatchEvent(new CustomEvent('smcp-native-messages', { detail: { messages: msgs } }))
        }
      } catch (e) {
        console.warn('[NativeBridge] onSmcpMessages parse error:', e)
      }
    },
    // ===== US2 激活/隧道回调 (Kotlin 注入, 之前缺失会导致 JS 报错) =====
    onActivateError: (msg: string) => {
      // 激活成功后的 VPN 阶段失败为软警告, 不影响激活态
      console.warn('[NativeBridge] activate/tunnel error:', msg)
      window.dispatchEvent(new CustomEvent('siliconmate:tunnel-error', { detail: { message: msg } }))
    },
    onTunnelConnecting: () => {
      console.log('[NativeBridge] tunnel connecting')
      window.dispatchEvent(new CustomEvent('siliconmate:tunnel-connecting', {}))
    },
    onTunnelConnected: (plan: string) => {
      console.log('[NativeBridge] tunnel connected, plan:', plan)
      window.dispatchEvent(new CustomEvent('siliconmate:tunnel-connected', { detail: { plan } }))
    },
    onTunnelDisconnected: () => {
      console.log('[NativeBridge] tunnel disconnected')
      window.dispatchEvent(new CustomEvent('siliconmate:tunnel-disconnected', {}))
    },
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
