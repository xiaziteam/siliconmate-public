package com.xiaziteam.siliconmate

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ResolveInfo
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.util.Base64
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * SMCP Agent Service — 消息收发 + 定时轮询
 *
 * 重构自旧的AgentService(操控API) → 现在是消息总线节点
 *
 * 功能:
 * - Agent注册/上线
 * - 定时轮询中继服务器拿消息
 * - 收到消息后通过WebView JS接口推送给前端
 * - 前端通过NativeBridge发送消息
 * - T022: type:"task" 任务处理回路(去重/权限策略/审批/执行/回传/120s超时)
 */
class SmcpAgentService : Service() {

    companion object {
        private const val TAG = "SmcpAgent"
        private const val NOTIF_CHANNEL_ID = "smcp_agent"
        private const val NOTIF_ID = 3
        private const val TASK_CHANNEL_ID = "smcp_task"
        private const val TASK_NOTIF_ID = 4
        private const val TASK_NOTIF_REQUEST_CODE = 2001
        private const val FRIEND_CHANNEL_ID = "smcp_friend"
        private const val FRIEND_NOTIF_ID = 5
        private const val FRIEND_NOTIF_REQUEST_CODE = 2002
        private const val RELAY_BASE = "https://locatenotify.online/v1/smcp"
        private const val POLL_INTERVAL_SEC = 3L
        private const val PREFS_PERMS = "smcp_permissions"
        private const val PREFS_NOTIFIED = "smcp_notified_ids"
        private const val PREFS_TASK_STATE = "smcp_task_state"

        /** T022: 待审批任务超时(120s) */
        private const val TASK_TIMEOUT_MS = 120_000L

        var isRunning = false
            private set
        var userId: String = ""
        var agentId: String = ""
            private set

        /** 应用上下文(供静态执行器使用: ML Kit OCR 等) */
        private var appContext: Context? = null

        /** T022: 已处理的 task_id 去重表 */
        private val handledTaskIds = HashSet<String>()

        /** T022: 当前待审批任务(单槽位; null=无) */
        private var pendingTask: JSONObject? = null
        private val pendingLock = Any()

        /** T022: 清除待审批任务(前端审批/拒绝/超时后调用) — @return 是否确有清除 */
        @JvmStatic
        fun resolvePendingTask(taskId: String): Boolean = synchronized(pendingLock) {
            val pt = pendingTask
            if (pt != null && pt.optString("task_id") == taskId) {
                pendingTask = null
                persistPendingTask(null)
                true
            } else false
        }

        /** 待审批任务持久化(通知点击冷启动/服务重启不丢审批现场) */
        private fun persistPendingTask(task: JSONObject?) {
            try {
                val ctx = appContext ?: return
                ctx.getSharedPreferences(PREFS_TASK_STATE, Context.MODE_PRIVATE).edit().apply {
                    if (task != null) putString("pending_task", task.toString())
                    else remove("pending_task")
                }.apply()
            } catch (_: Exception) {}
        }

        /** 恢复持久化的待审批任务(服务 onCreate 时调用) */
        private fun restorePendingTask(): JSONObject? {
            try {
                val ctx = appContext ?: return null
                val saved = ctx.getSharedPreferences(PREFS_TASK_STATE, Context.MODE_PRIVATE)
                    .getString("pending_task", null) ?: return null
                val pt = JSONObject(saved)
                // 超过审批窗口的不再恢复(发起方已按超时处理)
                if (System.currentTimeMillis() - pt.optLong("received_at", 0) > TASK_TIMEOUT_MS) {
                    persistPendingTask(null)
                    return null
                }
                return pt
            } catch (_: Exception) { return null }
        }

        /** T022: 读取权限策略(本地 SharedPreferences; 未设置默认 ask) */
        @JvmStatic
        fun getPermissionPolicy(fromAgent: String, capability: String): String {
            val ctx = appContext ?: return "ask"
            return ctx.getSharedPreferences(PREFS_PERMS, Context.MODE_PRIVATE)
                .getString("$fromAgent|$capability", "ask") ?: "ask"
        }

        /** T022: 写入权限策略(审批"始终允许"/好友面板调用) */
        @JvmStatic
        fun setPermissionPolicy(fromAgent: String, capability: String, policy: String): Boolean {
            val ctx = appContext ?: return false
            ctx.getSharedPreferences(PREFS_PERMS, Context.MODE_PRIVATE).edit()
                .putString("$fromAgent|$capability", policy).apply()
            Log.i(TAG, "permission policy: $fromAgent|$capability -> $policy")
            return true
        }

        /** 构造 TaskResult JSON(对齐前端 smcp.ts TaskResult 契约) */
        private fun taskResultJson(status: String, data: JSONObject, screenshots: JSONArray,
                                   tier: String, durationMs: Long, errorMessage: String): String {
            return JSONObject().apply {
                put("task_id", "")
                put("status", status)
                put("data", data)
                put("screenshots", screenshots)
                put("error_message", errorMessage)
                put("execution_tier", tier)
                put("duration_ms", durationMs)
                put("created_at", System.currentTimeMillis())
            }.toString()
        }

        /**
         * T022: 任务执行器分发(静态, 供本服务预授权路径与 MainActivity taskExecute 桥共用)
         * - screenshot → T019 无障碍截图(JPEG base64 直接入 screenshots)
         * - ocr → 截图(高分辨率) + ML Kit 中文识别
         * - device_control → tap/swipe/long_press
         * - 其他 → not_supported
         */
        @JvmStatic
        fun executeTask(capability: String, paramsJson: String): String {
            val start = System.currentTimeMillis()
            val params = try { JSONObject(paramsJson) } catch (_: Exception) { JSONObject() }
            val elapsed = { System.currentTimeMillis() - start }
            val a11y = AgentAccessibilityService.instance
                ?: return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                    "无障碍服务未开启, 请在系统设置中开启硅侣无障碍服务")
            try {
                when (capability) {
                    "screenshot" -> {
                        val b64 = a11y.takeScreenshotBase64()
                            ?: return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                                "截图失败(无障碍服务未开启或截图超时)")
                        return taskResultJson("success",
                            JSONObject().put("format", "jpeg_base64"),
                            JSONArray().put(b64), "native", elapsed(), "")
                    }
                    "ocr" -> {
                        val b64 = a11y.takeScreenshotBase64(maxEdge = 1080, quality = 80)
                            ?: return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                                "截图失败, 无法执行OCR")
                        val bytes = Base64.decode(b64, Base64.NO_WRAP)
                        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            ?: return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                                "截图解码失败")
                        val text = ocrBitmapSync(bitmap)
                        bitmap.recycle()
                        if (text == null) {
                            return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                                "OCR识别失败")
                        }
                        return taskResultJson("success",
                            JSONObject().put("text", text), JSONArray(), "native", elapsed(), "")
                    }
                    "app.open" -> {
                        val appName = params.optString("app_name", params.optString("name", "")).trim()
                        if (appName.isBlank()) return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                            "缺少app_name参数")
                        val pm = a11y.packageManager
                        val mainIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                        val apps: List<ResolveInfo> = pm.queryIntentActivities(mainIntent, 0)
                        var matched: ResolveInfo? = null
                        for (a in apps) {
                            val label = a.loadLabel(pm)?.toString() ?: continue
                            if (label.equals(appName, ignoreCase = true)) { matched = a; break }
                        }
                        if (matched == null) for (a in apps) {
                            val label = a.loadLabel(pm)?.toString() ?: continue
                            if (label.contains(appName, ignoreCase = true) || appName.contains(label, ignoreCase = true)) { matched = a; break }
                        }
                        if (matched == null) return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                            "未找到应用: $appName")
                        val launchIntent = pm.getLaunchIntentForPackage(matched.activityInfo.packageName)
                            ?: return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                                "应用无启动入口: $appName")
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        a11y.startActivity(launchIntent)
                        return taskResultJson("success",
                            JSONObject().put("app_name", appName).put("package", matched.activityInfo.packageName),
                            JSONArray(), "native", elapsed(), "")
                    }
                    "device_control" -> {
                        val action = params.optString("action", "tap")
                        val ok = when (action) {
                            "tap" -> a11y.tap(params.optInt("x"), params.optInt("y"))
                            "swipe" -> a11y.swipe(params.optInt("x"), params.optInt("y"),
                                params.optInt("x2"), params.optInt("y2"),
                                params.optLong("duration", 300))
                            "long_press" -> a11y.longPress(params.optInt("x"), params.optInt("y"))
                            else -> false
                        }
                        if (!ok) {
                            return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                                if (action in listOf("tap", "swipe", "long_press")) "操控手势分发失败" else "不支持的操控动作: $action")
                        }
                        return taskResultJson("success",
                            JSONObject().put("action", action), JSONArray(), "native", elapsed(), "")
                    }
                    else -> return taskResultJson("not_supported", JSONObject(), JSONArray(), "none", elapsed(),
                        "不支持的能力: $capability")
                }
            } catch (e: Exception) {
                return taskResultJson("error", JSONObject(), JSONArray(), "none", elapsed(),
                    e.message ?: "执行异常")
            }
        }

        /** ML Kit 同步 OCR(阻塞等待, 需在后台线程调用) */
        private fun ocrBitmapSync(bitmap: android.graphics.Bitmap): String? {
            val ctx = appContext ?: return null
            val latch = CountDownLatch(1)
            val ref = AtomicReference<String?>(null)
            var recognizer: com.google.mlkit.vision.text.TextRecognizer? = null
            try {
                val inputImage = com.google.mlkit.vision.common.InputImage.fromBitmap(bitmap, 0)
                recognizer = com.google.mlkit.vision.text.TextRecognition.getClient(
                    com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions.Builder().build())
                recognizer.process(inputImage)
                    .addOnSuccessListener { r -> ref.set(r.text); latch.countDown() }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "OCR fail: ${e.message}"); latch.countDown() }
                latch.await(15, TimeUnit.SECONDS)
            } catch (e: Exception) {
                Log.e(TAG, "ocr error", e)
            } finally {
                try { recognizer?.close() } catch (_: Exception) {}
            }
            return ref.get()
        }
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()
    private val JSON_MT = "application/json".toMediaType()
    private var scheduler: ScheduledExecutorService? = null

    // T024: 好友申请轮询节流计数(前台每5tick=15s / 后台每20tick=60s)
    private var tickCount = 0L
    private var lastFriendCount = -1
    // v4.4.2: 断网自愈 — 注册成功标志, 失败后由轮询tick自动补注册
    @Volatile private var registered = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        appContext = applicationContext
        createNotificationChannel()
        // T022加固: 恢复持久化的待审批任务(通知点击冷启动/服务重启不丢审批现场)
        val restored = synchronized(pendingLock) { pendingTask = restorePendingTask(); pendingTask }
        val notif = android.app.Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("硅侣Agent")
            .setContentText("消息服务运行中")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        isRunning = true
        startPolling()
        if (restored != null) {
            Log.i(TAG, "Pending task restored: ${restored.optString("task_id")}")
            // onStartCommand 设置 userId/agentId 后再推; 此处先推一次(WebView通常已就绪),
            // 前端审批不依赖 userId, 回传走 MainActivity 桥用 companion userId
            pushTaskRequestToFrontend()
        }
        Log.i(TAG, "SmcpAgentService created, polling started")
    }

    override fun onDestroy() {
        stopPolling()
        // 清理待审批任务(避免悬挂状态)
        synchronized(pendingLock) { pendingTask = null }
        // 通知下线(同样避免主线程网络异常)
        if (userId.isNotEmpty()) {
            Thread {
                try {
                    val json = JSONObject().apply {
                        put("user_id", userId)
                        put("agent_id", agentId)
                    }
                    val req = Request.Builder()
                        .url("$RELAY_BASE/agent/unregister")
                        .header("X-Account-Id", userId)
                        .post(json.toString().toRequestBody(JSON_MT))
                        .build()
                    httpClient.newCall(req).execute()
                } catch (_: Exception) {}
            }.start()
        }
        isRunning = false
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let {
            userId = it.getStringExtra("user_id") ?: ""
            agentId = it.getStringExtra("agent_id") ?: ""
        }
        // 修复: 前端传的agent_id与桌面端同款, 手机上线会把桌面agent顶掉(INSERT OR REPLACE)。
        // Android端强制追加设备后缀保证端唯一, 主控端经agent/list(role=mobile)仍可寻址。
        if (agentId.isNotEmpty() && !agentId.endsWith("-android")) {
            agentId = "$agentId-android"
        }
        // 注册到中继
        if (userId.isNotEmpty()) {
            registerAgent()
        }
        return START_STICKY
    }

    // --- Agent注册 ---

    private fun registerAgent() {
        // 修复: 主线程同步HTTP抛NetworkOnMainThreadException导致注册从未成功, 移到后台线程
        Thread {
            try {
                val json = JSONObject().apply {
                    put("user_id", userId)
                    put("agent_id", agentId)
                    put("role", "mobile")
                    put("device", "android")
                    // T021/FR-015: capabilities 扩展 — 好友端可见手机可执行能力
                    put("capabilities", JSONArray().apply {
                        put("im"); put("tunnel"); put("notify")
                        put("screenshot"); put("ocr"); put("device_control")
                    })
                }
                val req = Request.Builder()
                    .url("$RELAY_BASE/agent/register")
                    .header("X-Account-Id", userId)
                    .post(json.toString().toRequestBody(JSON_MT))
                    .build()
                val resp = httpClient.newCall(req).execute()
                if (resp.isSuccessful) {
                    registered = true
                    Log.i(TAG, "Agent registered: $agentId")
                } else {
                    Log.w(TAG, "Agent register failed: ${resp.code}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Agent register error", e)
            }
        }.start()
    }

    // --- 消息轮询 ---

    private fun startPolling() {
        scheduler = Executors.newSingleThreadScheduledExecutor()
        scheduler?.scheduleAtFixedRate({
            if (userId.isEmpty() || agentId.isEmpty()) return@scheduleAtFixedRate
            // T022: 待审批任务 120s 超时看门狗(每tick检查, 开销可忽略)
            checkTaskWatchdog()
            // T024: 好友申请轮询节流 — 前台15s / 后台60s(与消息轮询同调度器)
            tickCount++
            val friendEvery = if (MainActivity.isInForeground()) 5L else 20L
            if (tickCount % friendEvery == 0L) pollFriendRequests()
            // v4.4.2: 断网自愈 — 注册失败(启动瞬间断网)后每6tick(~18s)自动补注册
            if (!registered && tickCount % 6L == 0L) registerAgent()
            try {
                // Poll direct messages
                val json = JSONObject().apply {
                    put("agent_id", agentId)
                    put("limit", 50)
                }
                val req = Request.Builder()
                    .url("$RELAY_BASE/message/poll")
                    .header("X-Account-Id", userId)
                    .post(json.toString().toRequestBody(JSON_MT))
                    .build()
                val resp = httpClient.newCall(req).execute()
                val body = resp.body?.string() ?: return@scheduleAtFixedRate
                val result = JSONObject(body)
                if (result.optBoolean("ok", false)) {
                    val messages = result.optJSONObject("data")?.optJSONArray("messages")
                    if (messages != null && messages.length() > 0) {
                        Log.i(TAG, "Received ${messages.length()} direct messages")
                        // T022: type:"task" 由本服务处理(权限/审批/执行/回传), 其余推前端
                        val forward = JSONArray()
                        for (i in 0 until messages.length()) {
                            val msg = messages.optJSONObject(i) ?: continue
                            val mtype = msg.optString("msg_type", msg.optString("type", ""))
                            if (mtype == "task") {
                                handleTaskMessage(msg)
                            } else {
                                forward.put(msg)
                            }
                        }
                        if (forward.length() > 0) pushMessagesToFrontend(forward)
                    }
                }

                // Poll group messages
                try {
                    val groupListResult = getGroupListInternal()
                    if (groupListResult != null) {
                        val groups = groupListResult.optJSONArray("groups")
                        if (groups != null) {
                            for (i in 0 until groups.length()) {
                                val group = groups.getJSONObject(i)
                                val groupId = group.optString("group_id", "")
                                if (groupId.isEmpty()) continue
                                val groupMsgJson = JSONObject().apply {
                                    put("group_id", groupId)
                                    put("limit", 20)
                                }
                                val groupMsgReq = Request.Builder()
                                    .url("$RELAY_BASE/group/message/poll")
                                    .header("X-Account-Id", userId)
                                    .post(groupMsgJson.toString().toRequestBody(JSON_MT))
                                    .build()
                                val groupMsgResp = httpClient.newCall(groupMsgReq).execute()
                                val groupMsgBody = groupMsgResp.body?.string()
                                if (groupMsgBody != null) {
                                    val groupMsgResult = JSONObject(groupMsgBody)
                                    if (groupMsgResult.optBoolean("ok", false)) {
                                        val groupMessages = groupMsgResult.optJSONObject("data")?.optJSONArray("messages")
                                        if (groupMessages != null && groupMessages.length() > 0) {
                                            Log.i(TAG, "Received ${groupMessages.length()} group messages for $groupId")
                                            // Inject group_id into each message for frontend routing
                                            for (j in 0 until groupMessages.length()) {
                                                val msg = groupMessages.getJSONObject(j)
                                                val params = msg.optJSONObject("params")
                                                if (params == null) {
                                                    msg.put("params", JSONObject().apply { put("group_id", groupId) })
                                                } else {
                                                    params.put("group_id", groupId)
                                                }
                                            }
                                            pushMessagesToFrontend(groupMessages)
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.d(TAG, "Group poll error: ${e.message}")
                }
            } catch (e: Exception) {
                Log.d(TAG, "Poll error: ${e.message}")
            }
        }, POLL_INTERVAL_SEC, POLL_INTERVAL_SEC, TimeUnit.SECONDS)
    }

    /** 内部获取群列表(用于轮询群消息) */
    private fun getGroupListInternal(): JSONObject? {
        return try {
            val req = Request.Builder()
                .url("$RELAY_BASE/group/list")
                .header("X-Account-Id", userId)
                .post("{}".toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            val body = resp.body?.string() ?: return null
            val result = JSONObject(body)
            if (result.optBoolean("ok", false)) {
                result.optJSONObject("data")
            } else null
        } catch (e: Exception) {
            null
        }
    }

    private fun stopPolling() {
        scheduler?.shutdownNow()
        scheduler = null
    }

    // --- T022: 任务处理回路 ---

    /**
     * 处理 type:"task" 消息: 去重 → 权限策略 → allow直接执行 / deny回传拒绝 / ask弹审批
     */
    private fun handleTaskMessage(msg: JSONObject) {
        val params = msg.optJSONObject("params") ?: return
        val taskId = params.optString("task_id", "")
        if (taskId.isEmpty() || !handledTaskIds.add(taskId)) return // 去重
        val capability = params.optString("capability", "")
        val fromAgent = msg.optString("from_agent", "")
        val taskParams = params.optJSONObject("params") ?: JSONObject()
        Log.i(TAG, "Task received: id=$taskId capability=$capability from=$fromAgent")

        when (getPermissionPolicy(fromAgent, capability)) {
            "allow" -> {
                // 预授权 → 直接执行并回传
                val resultJson = executeTask(capability, taskParams.toString())
                val result = JSONObject(resultJson)
                sendTaskResult(taskId, fromAgent, result.optString("status"),
                    result.optJSONObject("data") ?: JSONObject(),
                    result.optJSONArray("screenshots") ?: JSONArray(),
                    result.optString("execution_tier", "none"),
                    result.optLong("duration_ms", 0),
                    result.optString("error_message", ""))
            }
            "deny" -> {
                sendTaskResult(taskId, fromAgent, "rejected", JSONObject(), JSONArray(), "none", 0,
                    "用户已拒绝该能力")
            }
            else -> {
                // ask → 弹审批(系统通知 + WebView事件), 等待前端审批后经桥执行
                val occupied = synchronized(pendingLock) {
                    if (pendingTask != null) true else {
                        pendingTask = JSONObject().apply {
                            put("task_id", taskId)
                            put("capability", capability)
                            put("from_agent", fromAgent)
                            put("params", taskParams)
                            put("received_at", System.currentTimeMillis())
                        }
                        persistPendingTask(pendingTask)
                        false
                    }
                }
                if (occupied) {
                    sendTaskResult(taskId, fromAgent, "rejected", JSONObject(), JSONArray(), "none", 0,
                        "已有任务待审批, 请稍后再发")
                    return
                }
                showTaskNotification(taskId, capability, fromAgent)
                pushTaskRequestToFrontend()
            }
        }
    }

    /** T024: 好友申请轮询 — 复用 /friend/list 提取 pending_requests; 新申请系统通知(去重仅一次),
     *  count 变化推 __onSmcpEvent 供前端红点 */
    private fun pollFriendRequests() {
        try {
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/list")
                .header("X-Account-Id", userId)
                .post(JSONObject().toString().toRequestBody(JSON_MT))
                .build()
            httpClient.newCall(req).execute().use { resp ->
                val body = resp.body?.string() ?: return
                val result = JSONObject(body)
                if (!result.optBoolean("ok", false)) return
                val pending = result.optJSONObject("data")
                    ?.optJSONArray("pending_requests") ?: JSONArray()
                val count = pending.length()
                // FR-012: 系统通知去重 — 同一 request_id 仅通知一次;
                // 每次以当前 pending 集合覆写, 自动清理已处理的旧 ID
                val prefs = getSharedPreferences(PREFS_NOTIFIED, Context.MODE_PRIVATE)
                val notified = prefs.getStringSet("ids", emptySet()) ?: emptySet()
                val currentIds = mutableSetOf<String>()
                val newIds = mutableListOf<String>()
                for (i in 0 until count) {
                    val rid = pending.optJSONObject(i)?.optString("request_id", "") ?: ""
                    if (rid.isEmpty()) continue
                    currentIds.add(rid)
                    if (rid !in notified) newIds.add(rid)
                }
                if (newIds.isNotEmpty()) showFriendRequestNotification(count)
                prefs.edit().putStringSet("ids", currentIds).apply()
                // count 变化(新申请/已处理) → 前端红点同步
                if (count != lastFriendCount) {
                    Log.i(TAG, "Pending friend requests: $count (was $lastFriendCount)")
                    lastFriendCount = count
                    MainActivity.instance?.pushSmcpEvent(JSONObject().apply {
                        put("type", "friend_request")
                        put("count", count)
                    }.toString())
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "Friend poll error: ${e.message}")
        }
    }

    /** FR-012: 好友申请系统通知(channel smcp_friend, 点击拉起 App 好友面板) */
    private fun showFriendRequestNotification(count: Int) {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                data = android.net.Uri.parse("siliconmate://friends")
            }
            val pi = PendingIntent.getActivity(this, FRIEND_NOTIF_REQUEST_CODE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notif = android.app.Notification.Builder(this, FRIEND_CHANNEL_ID)
                .setContentTitle("🦐 虾群好友申请")
                .setContentText("你有 $count 个待处理的好友申请 — 点击查看")
                .setSmallIcon(android.R.drawable.ic_menu_add)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            nm.notify(FRIEND_NOTIF_ID, notif)
        } catch (e: Exception) {
            Log.d(TAG, "Friend notification error: ${e.message}")
        }
    }

    /** 待审批任务超时检查: >120s 回传 timeout 并通知前端关闭弹窗 */
    private fun checkTaskWatchdog() {
        val expired = synchronized(pendingLock) {
            val pt = pendingTask ?: return
            if (System.currentTimeMillis() - pt.optLong("received_at", 0) <= TASK_TIMEOUT_MS) return
            pendingTask = null
            persistPendingTask(null)
            pt
        }
        Log.w(TAG, "Task approval timeout: ${expired.optString("task_id")}")
        sendTaskResult(expired.optString("task_id"), expired.optString("from_agent"),
            "timeout", JSONObject(), JSONArray(), "none", TASK_TIMEOUT_MS,
            "审批超时(120秒)")
        pushTaskRequestToFrontend()
    }

    /** 构造 type:"result" 消息经 message/send 回传发起方 */
    private fun sendTaskResult(taskId: String, toAgent: String, status: String,
                               data: JSONObject, screenshots: JSONArray, tier: String,
                               durationMs: Long, errorMessage: String) {
        try {
            val json = JSONObject().apply {
                put("from_agent", agentId)
                put("to_agent", toAgent)
                put("to_user", "")
                put("type", "result")
                put("method", "task.result")
                put("params", JSONObject().apply {
                    put("task_id", taskId)
                    put("status", status)
                    put("data", data)
                    put("screenshots", screenshots)
                    put("execution_tier", tier)
                    put("duration_ms", durationMs)
                    put("error_message", errorMessage)
                })
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/message/send")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            httpClient.newCall(req).execute()
            Log.i(TAG, "Task result sent: id=$taskId status=$status to=$toAgent")
        } catch (e: Exception) {
            Log.e(TAG, "sendTaskResult error", e)
        }
    }

    /** 审批请求系统通知(channel smcp_task, 点击拉起App) */
    private fun showTaskNotification(taskId: String, capability: String, fromAgent: String) {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                data = android.net.Uri.parse("siliconmate://task?task_id=$taskId")
            }
            val pi = PendingIntent.getActivity(this, TASK_NOTIF_REQUEST_CODE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notif = android.app.Notification.Builder(this, TASK_CHANNEL_ID)
                .setContentTitle("🦐 远程任务请求")
                .setContentText("[$capability] 来自 $fromAgent — 点击审批")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build()
            nm.notify(TASK_NOTIF_ID, notif)
        } catch (e: Exception) {
            Log.e(TAG, "showTaskNotification error", e)
        }
    }

    /** 推送审批请求到前端: __onSmcpEvent({type:'task_request', task:{...}|null}) */
    private fun pushTaskRequestToFrontend() {
        val pt = synchronized(pendingLock) { pendingTask }
        val payload = JSONObject().apply {
            put("type", "task_request")
            if (pt != null) put("task", pt) else put("task", JSONObject.NULL)
        }
        MainActivity.instance?.pushSmcpEvent(payload.toString())
            ?: Log.w(TAG, "MainActivity not available, task request not pushed")
    }

    // --- 推送消息到前端 ---

    private fun pushMessagesToFrontend(messages: JSONArray) {
        // 通过MainActivity的WebView推送给React前端
        MainActivity.instance?.pushSmcpMessages(messages.toString()) ?: run {
            Log.w(TAG, "MainActivity not available, messages queued")
        }
        // 发送Android通知
        if (!MainActivity.isInForeground()) {
            for (i in 0 until messages.length()) {
                val msg = messages.optJSONObject(i) ?: continue
                val fromUser = msg.optString("from_user", "")
                val method = msg.optString("method", "")
                val params = msg.optJSONObject("params")
                val text = params?.optString("text") ?: params?.optString("content") ?: params?.optString("message") ?: ""
                if (method == "chat" || method == "im.send") {
                    showMessageNotification(fromUser, text, msg.optString("from_agent", ""))
                }
            }
        }
    }

    private fun showMessageNotification(fromUser: String, text: String, fromAgent: String) {
        val nm = getSystemService(NotificationManager::class.java)
        val notifId = (System.currentTimeMillis() % 100000).toInt()

        // 点击通知跳转到MainActivity
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("smcp_from_user", fromUser)
            putExtra("smcp_from_agent", fromAgent)
            data = android.net.Uri.parse("siliconmate://chat?from_user=$fromUser")
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notifId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = android.app.Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("新消息 - $fromUser")
            .setContentText(if (text.length > 50) text.substring(0, 50) + "…" else text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        nm.notify(notifId, notif)
    }

    // --- 发送消息（供NativeBridge调用）---

    fun sendMessage(fromAgent: String, toAgent: String, toUser: String,
                    msgType: String, method: String, paramsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("from_agent", fromAgent)
                put("to_agent", toAgent)
                put("to_user", toUser)
                put("type", msgType)
                put("method", method)
                put("params", JSONObject(paramsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/message/send")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false,"error":"empty response"}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    // --- 好友操作 ---

    fun friendRequest(toUserId: String, message: String, permsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("to_user_id", toUserId)
                put("message", message)
                put("permissions", JSONObject(permsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/request")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendAccept(requestId: String, permsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("request_id", requestId)
                put("permissions", JSONObject(permsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/accept")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendList(): String {
        return try {
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/list")
                .header("X-Account-Id", userId)
                .post("{}".toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendSetPermissions(friendUserId: String, permsJson: String): String {
        return try {
            val json = JSONObject().apply {
                put("user_id", friendUserId)
                put("permissions", JSONObject(permsJson))
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/setPermissions")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    fun friendRemove(friendUserId: String): String {
        return try {
            val json = JSONObject().apply {
                put("user_id", friendUserId)
            }
            val req = Request.Builder()
                .url("$RELAY_BASE/friend/remove")
                .header("X-Account-Id", userId)
                .post(json.toString().toRequestBody(JSON_MT))
                .build()
            val resp = httpClient.newCall(req).execute()
            resp.body?.string() ?: """{"ok":false}"""
        } catch (e: Exception) {
            """{"ok":false,"error":"${e.message}"}"""
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID,
                "SMCP消息服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Agent消息收发服务"
                setShowBadge(false)
            }
            // T022: 任务审批通道(高优先级 — 有声/横幅, 点击拉起App审批)
            val taskChannel = NotificationChannel(
                TASK_CHANNEL_ID,
                "远程任务审批",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "好友硅侣下发的远程任务审批请求"
            }
            // T024: 好友申请通道(默认优先级, 点击拉起App好友面板)
            val friendChannel = NotificationChannel(
                FRIEND_CHANNEL_ID,
                "虾群好友申请",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "收到的好友申请通知"
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
            nm.createNotificationChannel(taskChannel)
            nm.createNotificationChannel(friendChannel)
        }
    }
}
