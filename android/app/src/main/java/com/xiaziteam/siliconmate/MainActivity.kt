package com.xiaziteam.siliconmate

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.gson.Gson
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private val httpClient = OkHttpClient()
    private val gson = Gson()
    private val scope = MainScope()

    private var tunnelConfig: TunnelConfig? = null
    private var currentPlan: String? = null
    private var isTunnelConnected = false

    // SMCP服务自愈: 后台启动限制(Android 8+)被拒时记录意图, 回前台重试
    private var smcpStartRequested = false
    private var smcpPendingUser = ""
    private var smcpPendingAgent = ""

    private fun tryStartSmcpService() {
        if (!smcpStartRequested || smcpPendingUser.isEmpty()) return
        val intent = Intent(this, SmcpAgentService::class.java).apply {
            putExtra("user_id", smcpPendingUser)
            putExtra("agent_id", smcpPendingAgent)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        } catch (e: Exception) {
            // 后台启动限制 — 等待 onResume 自愈重试
            Log.w("SiliconMate", "smcpStart deferred (background restriction): ${e.message}")
        }
    }

    companion object {
        private const val TAG = "SiliconMate"
        private const val VPN_REQUEST_CODE = 1001
        private const val NOTIF_PERMISSION_CODE = 1002
        private const val AUDIO_PERMISSION_CODE = 1003
        private const val FILE_CHOOSER_REQUEST = 1004
        var instance: MainActivity? = null
            private set
        @JvmStatic
        private var isForeground: Boolean = false
        @JvmStatic
        fun isInForeground(): Boolean = isForeground
    }

    // File picker activity result launcher
    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        uri?.let {
            val fileName = getFileNameFromUri(it)
            // Notify WebView with the selected file info
            webView.post {
                webView.evaluateJavascript(
                    "if(window.__siliconmate_native) window.__siliconmate_native.onFilePicked('${it}','${fileName?.replace("'", "\\'")}')",
                    null
                )
            }
        }
    }

    private var pendingFilePickCallback: String? = null

    // v4.1.1: 📎 WebView文件选择 — input[type=file] → onShowFileChooser → 系统选择器
    private var webFilePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    private fun getFileNameFromUri(uri: Uri): String? {
        var name: String? = null
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0) name = cursor.getString(nameIndex)
            }
        }
        return name
    }

    // --- Broadcast receiver for tunnel status + JS injection ---
    private val tunnelReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                "com.xiaziteam.siliconmate.TUNNEL_CONNECTED" -> {
                    isTunnelConnected = true
                    currentPlan = intent.getStringExtra("plan") ?: "basic"
                    webView.post {
                        webView.evaluateJavascript(
                            "if(window.__siliconmate_native) window.__siliconmate_native.onTunnelConnected('$currentPlan')", null
                        )
                    }
                    Log.i(TAG, "Tunnel connected, plan=$currentPlan")
                }
                "com.xiaziteam.siliconmate.INJECT_JS" -> {
                    val js = intent.getStringExtra("js") ?: ""
                    if (js.isNotEmpty()) {
                        webView.post {
                            webView.evaluateJavascript(js, null)
                        }
                        Log.i(TAG, "JS injected: ${js.take(80)}")
                    }
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this

        // Request notification permission (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
        }

        // 窗口自适应：让系统自动避让状态栏/挖孔/手势导航条
        // （之前的FLAG_LAYOUT_NO_LIMITS导致内容延伸到系统栏下面，显示不全）
        // targetSdk 34下decor默认fit system windows，无需edge-to-edge手动处理

        setContentView(R.layout.activity_main)

        progressBar = findViewById(R.id.progressBar)
        webView = findViewById(R.id.webView)

        // Check if launched from Agent deep link
        handleIntent(intent)

        // Configure WebView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = userAgentString + " SiliconMate/1.0"
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                // Allow only our own URLs and necessary external URLs
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("file:///android_asset/") ||
                    url.startsWith("https://locatenotify.online") ||
                    url.startsWith("http://localhost")
                ) {
                    return false
                }
                // Open other URLs in external browser
                val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))
                startActivity(intent)
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d(TAG, "JS: ${consoleMessage?.message()} (${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()})")
                return true
            }

            // v4.1.1: 📎文件选择支持 — 没有此override时input[type=file]点击无反应
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: android.webkit.ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                webFilePathCallback?.onReceiveValue(null)
                webFilePathCallback = filePathCallback
                val intent = fileChooserParams.createIntent()
                return try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                    true
                } catch (e: android.content.ActivityNotFoundException) {
                    webFilePathCallback = null
                    false
                }
            }
        }

        // JavaScript bridge for native functions
        webView.addJavascriptInterface(SiliconMateBridge(), "NativeBridge")

        // Load the React frontend from assets
        webView.loadUrl("file:///android_asset/dist/index.html")

        // Request permissions
        requestPermissions()

        // Register tunnel + JS injection broadcast receiver
        val filter = IntentFilter("com.xiaziteam.siliconmate.TUNNEL_CONNECTED")
        filter.addAction("com.xiaziteam.siliconmate.INJECT_JS")
        registerReceiver(tunnelReceiver, filter)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        // 通知点击跳转 — smcp_from_user参数
        intent?.getStringExtra("smcp_from_user")?.let { fromUser ->
            if (fromUser.isNotEmpty()) {
                webView?.evaluateJavascript(
                    "if(window.__siliconmate_native) window.__siliconmate_native.onNotificationChatOpen('$fromUser')", null
                )
                intent.removeExtra("smcp_from_user")
            }
        }
        // 深链接处理
        val action = intent?.action ?: return
        val data = intent.data ?: return
        if (action == Intent.ACTION_VIEW && data.scheme == "siliconmate") {
            when (data.host) {
                "agent" -> when (data.path) {
                    "/start" -> startAgentServiceInternal()
                    "/stop" -> stopService(Intent(this, AgentService::class.java))
                }
                // T024: 好友申请通知点击 → 拉起好友面板
                "friends" -> runOnUiThread {
                    webView?.evaluateJavascript(
                        "if(window.__siliconmate_native) window.__siliconmate_native.onNotificationFriendsOpen()", null
                    )
                }
            }
        }
    }

    private fun startAgentServiceInternal() {
        if (!AgentService.isRunning) {
            startService(Intent(this, AgentService::class.java))
        }
        Toast.makeText(this, "Agent服务已启动 :18083", Toast.LENGTH_SHORT).show()
    }

    /** SMCP消息推送给前端 */
    fun pushSmcpMessages(messagesJson: String) {
        webView.post {
            // T023修复: JSONObject.quote 产生合法双引号JS字符串字面量 — 旧实现单引号包裹,
            // 消息文本含 ' 即整批消息丢失
            webView.evaluateJavascript(
                "if(window.__siliconmate_native && window.__siliconmate_native.onSmcpMessages)" +
                    " window.__siliconmate_native.onSmcpMessages(${org.json.JSONObject.quote(messagesJson)})",
                null
            )
        }
    }

    /** T022/T023: 推送 SMCP 事件到前端 __onSmcpEvent(task_request/friend_request) */
    fun pushSmcpEvent(eventJson: String) {
        webView.post {
            webView.evaluateJavascript(
                "if(window.__onSmcpEvent) window.__onSmcpEvent(${org.json.JSONObject.quote(eventJson)})",
                null
            )
        }
    }

    private fun requestPermissions() {
        // Notification permission (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    NOTIF_PERMISSION_CODE
                )
            }
        }
        // Audio recording permission (for voice input)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                AUDIO_PERMISSION_CODE
            )
        }
    }

    // --- JavaScript Bridge ---
    inner class SiliconMateBridge {
        /** v4.1.1: ChatGPT跳转 — 系统浏览器打开(替代硅侣语音输入; 手机系统键盘自带语音) */
        @JavascriptInterface
        fun openChatgpt(): String {
            return try {
                val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://chatgpt.com")).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(intent)
                "ok"
            } catch (e: Exception) {
                Log.e(TAG, "openChatgpt failed: ${e.message}")
                "error: ${e.message}"
            }
        }

        @JavascriptInterface
        fun activate(code: String) {
            // US2: 激活必须绑定登录账号 — 未登录直接拒绝
            val account = SmcpAgentService.userId
            if (account.isEmpty()) {
                webView.post {
                    webView.evaluateJavascript(
                        "if(window.__activateReject) window.__activateReject('请先注册或登录账号后再激活')", null
                    )
                }
                return
            }
            scope.launch {
                try {
                    val result = bindActivation(account, code)
                    if (result.ok && result.data != null) {
                        currentPlan = result.data.plan
                        tunnelConfig = result.data.tunnel
                        withContext(Dispatchers.Main) {
                            // 通知前端激活成功(解除门禁); plan 用 JSON 引号安全转义
                            webView.evaluateJavascript(
                                "if(window.__activateResolve) window.__activateResolve('ok', " +
                                    org.json.JSONObject.quote(result.data.plan ?: "basic") + ")",
                                null
                            )
                            // 原生启动 VPN 隧道(前端无需再调 start_tunnel)
                            startVpnTunnel()
                        }
                    } else {
                        val reason = result.error ?: result.message ?: "激活码无效"
                        withContext(Dispatchers.Main) {
                            webView.evaluateJavascript(
                                "if(window.__activateReject) window.__activateReject(" +
                                    org.json.JSONObject.quote(reason) + ")", null
                            )
                        }
                    }
                } catch (e: Exception) {
                    val reason = e.message ?: "网络错误, 请稍后重试"
                    withContext(Dispatchers.Main) {
                        webView.evaluateJavascript(
                            "if(window.__activateReject) window.__activateReject(" +
                                org.json.JSONObject.quote(reason) + ")", null
                        )
                    }
                }
            }
        }

        @JavascriptInterface
        fun disconnectTunnel() {
            stopService(Intent(this@MainActivity, TunnelVpnService::class.java))
            isTunnelConnected = false
            webView.evaluateJavascript(
                "if(window.__siliconmate_native) window.__siliconmate_native.onTunnelDisconnected()", null
            )
        }

        @JavascriptInterface
        fun isTunnelActive(): Boolean = isTunnelConnected

        @JavascriptInterface
        fun getAppVersion(): String = "1.0.0"

        @JavascriptInterface
        fun getPlatform(): String = "android"

        // --- Agent模式API ---

        @JavascriptInterface
        fun startAgentService() {
            if (!AgentService.isRunning) {
                startService(Intent(this@MainActivity, AgentService::class.java))
            }
            // 检查无障碍服务是否开启
            if (!isAccessibilityEnabled()) {
                webView.post {
                    webView.evaluateJavascript(
                        "if(window.__siliconmate_native) window.__siliconmate_native.onAgentStatus('need_a11y')", null
                    )
                }
            } else {
                webView.post {
                    webView.evaluateJavascript(
                        "if(window.__siliconmate_native) window.__siliconmate_native.onAgentStatus('ready')", null
                    )
                }
            }
        }

        @JavascriptInterface
        fun stopAgentService() {
            stopService(Intent(this@MainActivity, AgentService::class.java))
        }

        @JavascriptInterface
        fun isAgentRunning(): Boolean = AgentService.isRunning

        @JavascriptInterface
        fun isAccessibilityEnabled(): Boolean {
            val service = "${packageName}/${packageName}.AgentAccessibilityService"
            val enabledServices = Settings.Secure.getString(
                contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: return false
            return enabledServices.contains(service)
        }

        @JavascriptInterface
        fun openAccessibilitySettings() {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }

        // --- SMCP消息API ---

        @JavascriptInterface
        fun smcpStart(userId: String, agentId: String) {
            smcpStartRequested = true
            smcpPendingUser = userId
            smcpPendingAgent = agentId
            tryStartSmcpService()
        }

        @JavascriptInterface
        fun smcpStop() {
            smcpStartRequested = false
            stopService(Intent(this@MainActivity, SmcpAgentService::class.java))
        }

        @JavascriptInterface
        fun smcpIsRunning(): Boolean = SmcpAgentService.isRunning

        // --- T020/T023: 远程任务执行桥(审批通过后前端调用) ---

        /** T023: 执行本地任务 → TaskResult JSON(与 SmcpAgentService 预授权路径共用静态执行器) */
        @JavascriptInterface
        fun taskExecute(capability: String, paramsJson: String): String {
            return SmcpAgentService.executeTask(capability, paramsJson)
        }

        /** 本机能力清单 — 代答LLM工具目录(动态注入prompt) */
        @JavascriptInterface
        fun taskListCapabilities(): String {
            val arr = org.json.JSONArray()
            arr.put(org.json.JSONObject().apply {
                put("name", "screenshot"); put("description", "截取手机当前屏幕截图"); put("tier", "native"); put("available", true)
            })
            arr.put(org.json.JSONObject().apply {
                put("name", "ocr"); put("description", "截屏并OCR识别屏幕文字, 返回text"); put("tier", "native"); put("available", true)
            })
            arr.put(org.json.JSONObject().apply {
                put("name", "device_control"); put("description", "操控手机屏幕: params.action=tap点击(x,y)/swipe滑动(x,y,x2,y2,duration)/long_press长按(x,y), 坐标为像素"); put("tier", "native"); put("available", true)
            })
            arr.put(org.json.JSONObject().apply {
                put("name", "app.open"); put("description", "打开手机上的应用, params.app_name=应用名(如:设置/微信/汽水音乐)"); put("tier", "native"); put("available", true)
            })
            return arr.toString()
        }

        /** T020: 回传远程任务结果 — 构造 type:"result" 消息经 message/send 发给发起方 */
        @JavascriptInterface
        fun smcpTaskResultSend(toAgent: String, toUser: String, taskId: String, status: String,
                               dataJson: String, screenshotsJson: String, executionTier: String,
                               durationMs: Long, errorMessage: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("from_agent", SmcpAgentService.agentId)
                    put("to_agent", toAgent)
                    put("to_user", toUser)
                    put("type", "result")
                    put("method", "task.result")
                    put("params", org.json.JSONObject().apply {
                        put("task_id", taskId)
                        put("status", status)
                        put("data", org.json.JSONObject(dataJson))
                        put("screenshots", org.json.JSONArray(screenshotsJson))
                        put("execution_tier", executionTier)
                        put("duration_ms", durationMs)
                        put("error_message", errorMessage)
                    })
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/message/send")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        /** T023: 清除待审批任务(前端审批动作后调用, 防止120s看门狗重复回传timeout) */
        @JavascriptInterface
        fun smcpTaskResolve(taskId: String): Boolean {
            return SmcpAgentService.resolvePendingTask(taskId)
        }

        /** T023: 写入权限策略(审批"始终允许"落库 → 后续同好友同能力任务自动放行) */
        @JavascriptInterface
        fun permissionSet(fromAgent: String, capability: String, policy: String): Boolean {
            return SmcpAgentService.setPermissionPolicy(fromAgent, capability, policy)
        }

        /** T023: 读取权限策略(allow/deny/ask) */
        @JavascriptInterface
        fun permissionCheck(fromAgent: String, capability: String): String {
            return SmcpAgentService.getPermissionPolicy(fromAgent, capability)
        }

        @JavascriptInterface
        fun smcpSendMessage(fromAgent: String, toAgent: String, toUser: String,
                           msgType: String, method: String, paramsJson: String): String {
            val service = SmcpAgentService::class.java
            // SmcpAgentService是单例模式，通过companion访问
            // 实际通过service实例调用
            return try {
                // 直接HTTP调用
                val json = org.json.JSONObject().apply {
                    put("from_agent", fromAgent)
                    put("to_agent", toAgent)
                    put("to_user", toUser)
                    put("type", msgType)
                    put("method", method)
                    put("params", org.json.JSONObject(paramsJson))
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/message/send")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpFriendRequest(toUserId: String, message: String, permsJson: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("to_user_id", toUserId)
                    put("message", message)
                    put("permissions", org.json.JSONObject(permsJson))
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/request")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpFriendList(): String {
            return try {
                val body = "{}".toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/list")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpFriendAccept(requestId: String, permsJson: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("request_id", requestId)
                    put("permissions", org.json.JSONObject(permsJson))
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/accept")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpFriendReject(requestId: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("request_id", requestId)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/reject")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpSetPermissions(friendUserId: String, permsJson: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("user_id", friendUserId)
                    put("permissions", org.json.JSONObject(permsJson))
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/setPermissions")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpFriendRemove(friendUserId: String): String {
            return try {
                val json = org.json.JSONObject().apply { put("user_id", friendUserId) }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/remove")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpLookup(siliconId: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("silicon_id", siliconId)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/lookup")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpPendingRequests(): String {
            return try {
                // 修复: 服务端无独立 /friend/requests 端点(404) — 复用 /friend/list 提取 pending_requests
                val body = "{}".toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/list")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                val raw = response.body?.string() ?: """{"ok":false}"""
                val parsed = org.json.JSONObject(raw)
                if (parsed.optBoolean("ok", false)) {
                    val pending = parsed.optJSONObject("data")
                        ?.optJSONArray("pending_requests") ?: org.json.JSONArray()
                    org.json.JSONObject().apply {
                        put("ok", true)
                        put("data", org.json.JSONObject().put("pending_requests", pending))
                    }.toString()
                } else raw
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpFriendRequestBySiliconId(siliconId: String, message: String, permsJson: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("to_user_id", "")
                    put("to_silicon_id", siliconId)
                    put("message", message)
                    put("permissions", org.json.JSONObject(permsJson))
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/friend/request")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        // --- 群聊API ---

        @JavascriptInterface
        fun smcpGroupCreate(name: String, memberIdsJson: String): String {
            return try {
                val memberIds = org.json.JSONArray(memberIdsJson)
                val json = org.json.JSONObject().apply {
                    put("name", name)
                    put("member_ids", memberIds)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/group/create")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpGroupList(): String {
            return try {
                val body = "{}".toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/group/list")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpGroupInfo(groupId: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("group_id", groupId)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/group/info")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpGroupLeave(groupId: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("group_id", groupId)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/group/leave")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun smcpGroupMessageSend(groupId: String, type: String, method: String, paramsJson: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("from_agent", SmcpAgentService.agentId)
                    put("group_id", groupId)
                    put("type", type)
                    put("method", method)
                    put("params", org.json.JSONObject(paramsJson))
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/group/message/send")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        // --- 文件上传API ---

        @JavascriptInterface
        fun smcpFileUpload(filename: String, base64Data: String, contentType: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("filename", filename)
                    put("data", base64Data)
                    put("content_type", contentType)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/file/upload")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        /** 通过multipart上传本地文件 */
        @JavascriptInterface
        fun smcpFileUploadByPath(filePath: String): String {
            return try {
                val file = java.io.File(filePath)
                if (!file.exists()) return """{"ok":false,"error":"File not found"}"""
                val mimeType = android.webkit.MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(file.extension) ?: "application/octet-stream"
                val requestBody = file.asRequestBody(mimeType.toMediaType())
                val multipart = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", file.name, requestBody)
                    .addFormDataPart("sender_id", SmcpAgentService.userId)
                    .build()
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/smcp/file/upload")
                    .header("X-Account-Id", SmcpAgentService.userId)
                    .post(multipart)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        // --- OCR API ---

        @JavascriptInterface
        fun ocrExtractText(imagePath: String): String {
            return try {
                // Use Google ML Kit TextRecognizer for OCR
                // ChineseTextRecognizerOptions supports both Chinese and Latin scripts
                // Requires: com.google.mlkit:text-recognition-chinese:16.0.1
                val inputImage = com.google.mlkit.vision.common.InputImage.fromFilePath(
                    this@MainActivity, android.net.Uri.parse(imagePath)
                )
                val recognizer = com.google.mlkit.vision.text.TextRecognition.getClient(
                    com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions.Builder().build()
                )
                recognizer.process(inputImage)
                    .addOnSuccessListener { result ->
                        val text = result.text
                        webView.evaluateJavascript(
                            "if(window.__siliconmate_native) window.__siliconmate_native.onOcrResult('${text.replace("'", "\\'")}')",
                            null
                        )
                    }
                    .addOnFailureListener { e ->
                        Log.w(TAG, "ML Kit OCR error: ${e.message}")
                        webView.evaluateJavascript(
                            "if(window.__siliconmate_native) window.__siliconmate_native.onOcrError('${e.message?.replace("'", "\\'")}')",
                            null
                        )
                    }
                """{"ok":true,"status":"processing"}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}","text":""}"""
            }
        }

        // --- 文件选择器 ---

        @JavascriptInterface
        fun pickFile(): String {
            return try {
                filePickerLauncher.launch(arrayOf("*/*"))
                """{"ok":true,"status":"picking"}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        /** 下载文件到app私有目录并打开 */
        @JavascriptInterface
        fun downloadAndOpenFile(fileUrl: String, fileName: String): String {
            return try {
                scope.launch(Dispatchers.IO) {
                    try {
                        val request = Request.Builder().url(fileUrl).build()
                        val response = httpClient.newCall(request).execute()
                        val responseBody = response.body ?: return@launch
                        val safeName = fileName.ifEmpty { "download_${System.currentTimeMillis()}" }
                        val outFile = java.io.File(filesDir, safeName)
                        outFile.outputStream().use { output ->
                            responseBody.byteStream().use { input ->
                                input.copyTo(output)
                            }
                        }
                        // Open file via Intent
                        withContext(Dispatchers.Main) {
                            try {
                                val uri = androidx.core.content.FileProvider.getUriForFile(
                                    this@MainActivity,
                                    "${packageName}.fileprovider",
                                    outFile
                                )
                                val intent = Intent(Intent.ACTION_VIEW).apply {
                                    setDataAndType(uri, android.webkit.MimeTypeMap.getSingleton()
                                        .getMimeTypeFromExtension(outFile.extension) ?: "*/*")
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                }
                                startActivity(intent)
                            } catch (e: Exception) {
                                Log.w(TAG, "Cannot open file, saved to: ${outFile.absolutePath}")
                                Toast.makeText(this@MainActivity, "文件已保存: ${outFile.name}", Toast.LENGTH_SHORT).show()
                            }
                        }
                    } catch (e: Exception) {
                        withContext(Dispatchers.Main) {
                            Toast.makeText(this@MainActivity, "下载失败: ${e.message}", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
                """{"ok":true}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun login(accountName: String, password: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("account_name", accountName)
                    put("password", password)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/auth/login")
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }

        @JavascriptInterface
        fun setUserId(userId: String) {
             SmcpAgentService.userId = userId
             Log.i(TAG, "NativeBridge setUserId: $userId")
         }

        @JavascriptInterface
        fun showNotification(title: String, content: String) {
            Log.d(TAG, "showNotification called: title=$title content=$content")
            try {
                val channelId = "smcp_messages"
                val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val channel = android.app.NotificationChannel(channelId, "SMCP消息", android.app.NotificationManager.IMPORTANCE_HIGH)
                    notificationManager.createNotificationChannel(channel)
                }
                val notification = android.app.Notification.Builder(this@MainActivity, channelId)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(title)
                    .setContentText(content)
                    .setAutoCancel(true)
                    .build()
                notificationManager.notify(System.currentTimeMillis().toInt(), notification)
                Log.d(TAG, "showNotification posted successfully")
            } catch (e: Exception) {
                Log.e(TAG, "showNotification error: ${e.message}")
            }
        }

        @JavascriptInterface
        fun register(accountName: String, password: String): String {
            return try {
                val json = org.json.JSONObject().apply {
                    put("account_name", accountName)
                    put("password", password)
                }
                val body = json.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("https://locatenotify.online/v1/auth/register")
                    .post(body)
                    .build()
                val response = httpClient.newCall(request).execute()
                response.body?.string() ?: """{"ok":false}"""
            } catch (e: Exception) {
                """{"ok":false,"error":"${e.message}"}"""
            }
        }
    }

    /**
     * US2: 调用云端轻量激活绑定端点。
     * 语义对齐: /v1/activate/bind = /v1/code/validate 的调用形态 +
     * /v1/account/activate 的账号绑定语义 (X-Account-Id 头认证, 免 HMAC)。
     * 成功: {ok:true, data:{plan, code_id, tunnel, activated}}
     * 失败: {ok:false, error: ERR_INVALID|ERR_WRONG_PRODUCT|ERR_EXPIRED|ERR_ALREADY_ACTIVATED|ERR_FORMAT|auth_failed}
     */
    private suspend fun bindActivation(accountId: String, code: String): BindResponse {
        return withContext(Dispatchers.IO) {
            val json = org.json.JSONObject().apply {
                put("code", code)
                put("product", "siliconmate")
            }
            val body = json.toString().toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("https://locatenotify.online/v1/activate/bind")
                .header("X-Account-Id", accountId)
                .post(body)
                .build()
            val response = httpClient.newCall(request).execute()
            val respBody = response.body?.string() ?: throw Exception("Empty response")
            val parsed = try {
                gson.fromJson(respBody, BindResponse::class.java)
            } catch (_: Exception) {
                null
            } ?: throw Exception("响应解析失败")
            if (!response.isSuccessful) {
                throw Exception(parsed.error ?: parsed.message ?: "HTTP ${response.code}")
            }
            parsed
        }
    }

    private fun startVpnTunnel() {
        val cfg = tunnelConfig ?: return
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, VPN_REQUEST_CODE)
        } else {
            launchTunnel()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST_CODE) {
            if (resultCode == RESULT_OK) {
                launchTunnel()
            } else {
                webView.evaluateJavascript(
                    "if(window.__siliconmate_native) window.__siliconmate_native.onActivateError('VPN权限被拒绝')", null
                )
            }
        }
        // v4.1.1: 📎文件选择结果回传WebView
        if (requestCode == FILE_CHOOSER_REQUEST) {
            webFilePathCallback?.onReceiveValue(
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            )
            webFilePathCallback = null
        }
    }

    private fun launchTunnel() {
        val cfg = tunnelConfig ?: return
        val intent = Intent(this, TunnelVpnService::class.java).apply {
            putExtra("server", cfg.server)
            putExtra("server_port", cfg.server_port)
            putExtra("uuid", cfg.uuid)
            putExtra("flow", cfg.flow)
            putExtra("server_name", cfg.server_name)
            putExtra("public_key", cfg.public_key)
            putExtra("short_id", cfg.short_id)
            putStringArrayListExtra("route_domains", ArrayList(cfg.route_domains))
            putExtra("plan", currentPlan ?: "basic")
        }
        startService(intent)

        webView.evaluateJavascript(
            "if(window.__siliconmate_native) window.__siliconmate_native.onTunnelConnecting()", null
        )
    }

    override fun onResume() {
        super.onResume()
        isForeground = true
        // 自愈: 后台启动限制导致 SMCP 服务未起时, 回前台重试
        if (smcpStartRequested && !SmcpAgentService.isRunning) {
            tryStartSmcpService()
        }
    }

    override fun onPause() {
        super.onPause()
        isForeground = false
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
        scope.cancel()
        try { unregisterReceiver(tunnelReceiver) } catch (_: Exception) {}
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    // --- Data classes ---
    data class TunnelConfig(
        val server: String,
        val server_port: Int,
        val uuid: String,
        val flow: String,
        val server_name: String,
        val public_key: String,
        val short_id: String,
        val route_domains: List<String>
    )

    /** /v1/activate/bind 成功 data 载荷 (tunnel 可能为 null) */
    data class BindData(
        val plan: String?,
        val code_id: String?,
        val tunnel: TunnelConfig?,
        val activated: Boolean?
    )

    /** /v1/activate/bind 响应: {ok, data} 或 {ok:false, error, message} */
    data class BindResponse(
        val ok: Boolean,
        val data: BindData?,
        val error: String?,
        val message: String?
    )
}
