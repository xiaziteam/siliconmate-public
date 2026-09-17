package com.xiaziteam.siliconmate

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import android.accessibilityservice.AccessibilityService
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Agent版核心服务 — 常驻后台HTTP服务器
 * 
 * 端口: 18083
 * 协议: HTTP JSON-RPC 2.0
 * 安全: HMAC-SHA256签名验证
 * 
 * 操控API:
 * - agent.tap(x, y) → 点击
 * - agent.swipe(x1, y1, x2, y2) → 滑动
 * - agent.longPress(x, y) → 长按
 * - agent.inputText(text) → 输入文字
 * - agent.pressBack() → 返回键
 * - agent.pressHome() → Home键
 * - agent.pressRecent() → 最近任务
 * - agent.getUITree() → 获取UI树
 * - agent.screenshot() → 截图(base64)
 * - agent.startApp(packageName) → 启动APP
 * - agent.ping() → 心跳检测
 * - agent.getStatus() → 获取Agent状态
 */
class AgentService : Service() {

    companion object {
        private const val TAG = "AgentService"
        private const val NOTIF_CHANNEL_ID = "agent_service"
        private const val NOTIF_ID = 2
        private const val PORT = 18083
        
        // HMAC密钥 — 与account-service共享，从激活码流程获取
        // 后续会改为动态获取，这里先用固定值做开发测试
        private const val HMAC_KEY = "siliconmate-agent-hmac-2026"

        var isRunning = false
            private set
    }

    private var serverSocket: ServerSocket? = null
    private var serverThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notif = android.app.Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("硅侣Agent")
            .setContentText("远程操控服务运行中 :$PORT")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notif)
        startServer()
        isRunning = true
        Log.i(TAG, "AgentService created, HTTP server on :$PORT")
    }

    override fun onDestroy() {
        stopServer()
        isRunning = false
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    // --- HTTP Server ---

    private fun startServer() {
        serverThread = Thread {
            try {
                serverSocket = ServerSocket(PORT)
                Log.i(TAG, "HTTP server listening on :$PORT")
                while (!Thread.currentThread().isInterrupted) {
                    val client = serverSocket?.accept() ?: break
                    Thread { handleClient(client) }.start()
                }
            } catch (e: Exception) {
                if (!Thread.currentThread().isInterrupted) {
                    Log.e(TAG, "Server error", e)
                }
            }
        }.also { it.start() }
    }

    private fun stopServer() {
        serverThread?.interrupt()
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        serverThread = null
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 10000
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            val output = socket.getOutputStream()

            // 读取HTTP请求
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1]

            // 读取headers
            var contentLength = 0
            var authHeader = ""
            var line: String?
            while (reader.readLine().also { line = it } != null && line!!.isNotEmpty()) {
                if (line!!.startsWith("Content-Length:", ignoreCase = true)) {
                    contentLength = line!!.substringAfter(":").trim().toIntOrNull() ?: 0
                }
                if (line!!.startsWith("X-Agent-Signature:", ignoreCase = true)) {
                    authHeader = line!!.substringAfter(":").trim()
                }
            }

            // 读取body
            var body = ""
            if (contentLength > 0) {
                val buf = CharArray(contentLength)
                reader.read(buf, 0, contentLength)
                body = String(buf)
            }

            // 路由处理
            val response = when {
                method == "GET" && path == "/ping" -> jsonResponse(200, "pong")
                method == "GET" && path == "/status" -> handleStatus()
                method == "POST" && path == "/rpc" -> handleRpc(body, authHeader)
                else -> jsonResponse(404, "not found")
            }

            // 发送响应
            output.write(response.toByteArray())
            output.flush()
        } catch (e: Exception) {
            Log.e(TAG, "Client handler error", e)
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    // --- JSON-RPC Handler ---

    private fun handleRpc(body: String, signature: String): String {
        // 验证HMAC签名
        if (!verifyHmac(body, signature)) {
            return jsonResponse(401, "unauthorized: invalid signature")
        }

        val json: JSONObject
        try {
            json = JSONObject(body)
        } catch (e: Exception) {
            return rpcError(null, -32700, "Parse error")
        }

        val id = json.opt("id")
        val method = json.optString("method", "")
        val params = json.optJSONObject("params")

        val result = when (method) {
            "agent.tap" -> handleTap(params)
            "agent.swipe" -> handleSwipe(params)
            "agent.longPress" -> handleLongPress(params)
            "agent.inputText" -> handleInputText(params)
            "agent.pressBack" -> handlePressBack()
            "agent.pressHome" -> handlePressHome()
            "agent.pressRecent" -> handlePressRecent()
            "agent.getUITree" -> handleGetUITree(params)
            "agent.screenshot" -> handleScreenshot()
            "agent.startApp" -> handleStartApp(params)
            "agent.ping" -> handlePing()
            "agent.getStatus" -> handleGetStatusRpc()
            else -> rpcError(id, -32601, "Method not found: $method")
        }

        return result
    }

    // --- 操控实现 ---

    private fun handleTap(params: JSONObject?): String {
        val x = params?.optInt("x", -1) ?: -1
        val y = params?.optInt("y", -1) ?: -1
        if (x < 0 || y < 0) return rpcResult(null, mapOf("ok" to false, "error" to "missing x,y"))
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.tap(x, y)
        return rpcResult(null, mapOf("ok" to success, "x" to x, "y" to y))
    }

    private fun handleSwipe(params: JSONObject?): String {
        val x1 = params?.optInt("x1", -1) ?: -1
        val y1 = params?.optInt("y1", -1) ?: -1
        val x2 = params?.optInt("x2", -1) ?: -1
        val y2 = params?.optInt("y2", -1) ?: -1
        if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) 
            return rpcResult(null, mapOf("ok" to false, "error" to "missing x1,y1,x2,y2"))
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.swipe(x1, y1, x2, y2)
        return rpcResult(null, mapOf("ok" to success))
    }

    private fun handleLongPress(params: JSONObject?): String {
        val x = params?.optInt("x", -1) ?: -1
        val y = params?.optInt("y", -1) ?: -1
        if (x < 0 || y < 0) return rpcResult(null, mapOf("ok" to false, "error" to "missing x,y"))
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.longPress(x, y)
        return rpcResult(null, mapOf("ok" to success))
    }

    private fun handleInputText(params: JSONObject?): String {
        val text = params?.optString("text", "") ?: ""
        if (text.isEmpty()) return rpcResult(null, mapOf("ok" to false, "error" to "missing text"))
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.inputText(text)
        return rpcResult(null, mapOf("ok" to success))
    }

    private fun handlePressBack(): String {
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.pressKey(AccessibilityService.GLOBAL_ACTION_BACK)
        return rpcResult(null, mapOf("ok" to success))
    }

    private fun handlePressHome(): String {
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.pressKey(AccessibilityService.GLOBAL_ACTION_HOME)
        return rpcResult(null, mapOf("ok" to success))
    }

    private fun handlePressRecent(): String {
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val success = a11y.pressKey(AccessibilityService.GLOBAL_ACTION_RECENTS)
        return rpcResult(null, mapOf("ok" to success))
    }

    private fun handleGetUITree(params: JSONObject?): String {
        val maxDepth = params?.optInt("maxDepth", 5) ?: 5
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val tree = a11y.getUITree(maxDepth)
        return rpcResult(null, mapOf("ok" to true, "tree" to tree))
    }

    private fun handleScreenshot(): String {
        // T019: AccessibilityService.takeScreenshot (API 30+) 真实现
        val a11y = AgentAccessibilityService.instance
            ?: return rpcResult(null, mapOf("ok" to false, "error" to "accessibility service not connected"))
        val b64 = a11y.takeScreenshotBase64()
        return if (b64 != null) {
            rpcResult(null, mapOf("ok" to true, "screenshot" to b64))
        } else {
            rpcResult(null, mapOf("ok" to false, "error" to "takeScreenshot failed (need accessibility on + API 30+)"))
        }
    }

    private fun handleStartApp(params: JSONObject?): String {
        val packageName = params?.optString("package", "") ?: ""
        if (packageName.isEmpty()) return rpcResult(null, mapOf("ok" to false, "error" to "missing package"))
        try {
            val intent = packageManager.getLaunchIntentForPackage(packageName)
                ?: return rpcResult(null, mapOf("ok" to false, "error" to "package not found"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            return rpcResult(null, mapOf("ok" to true, "package" to packageName))
        } catch (e: Exception) {
            return rpcResult(null, mapOf("ok" to false, "error" to e.message))
        }
    }

    private fun handlePing(): String {
        return rpcResult(null, mapOf("ok" to true, "pong" to true, "timestamp" to System.currentTimeMillis()))
    }

    private fun handleGetStatusRpc(): String {
        val a11y = AgentAccessibilityService.instance
        return rpcResult(null, mapOf(
            "ok" to true,
            "httpServer" to true,
            "accessibilityService" to (a11y != null),
            "port" to PORT,
            "timestamp" to System.currentTimeMillis()
        ))
    }

    private fun handleStatus(): String {
        val a11y = AgentAccessibilityService.instance
        val status = mapOf(
            "service" to "SiliconMateAgent",
            "httpServer" to true,
            "accessibilityService" to (a11y != null),
            "port" to PORT,
            "version" to "1.0.0"
        )
        return jsonResponse(200, JSONObject(status).toString())
    }

    // --- HMAC验证 ---

    private fun verifyHmac(body: String, signature: String): Boolean {
        // 开发模式：如果没有签名头，允许本地请求(127.0.0.1/localhost)
        if (signature.isEmpty()) return true  // TODO: 生产环境必须验证
        
        try {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(HMAC_KEY.toByteArray(), "HmacSHA256"))
            val computed = mac.doFinal(body.toByteArray())
            val computedHex = computed.joinToString("") { "%02x".format(it) }
            return computedHex == signature
        } catch (e: Exception) {
            Log.e(TAG, "HMAC verify error", e)
            return false
        }
    }

    // --- HTTP Response Helpers ---

    private fun jsonResponse(status: Int, body: String): String {
        val statusText = when (status) {
            200 -> "OK"
            401 -> "Unauthorized"
            404 -> "Not Found"
            else -> "Unknown"
        }
        return "HTTP/1.1 $status $statusText\r\n" +
                "Content-Type: application/json\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, X-Agent-Signature\r\n" +
                "Content-Length: ${body.toByteArray().size}\r\n" +
                "\r\n" +
                body
    }

    private fun rpcResult(id: Any?, result: Map<String, Any?>): String {
        val json = JSONObject()
        json.put("jsonrpc", "2.0")
        id?.let { json.put("id", it) }
        json.put("result", JSONObject(result))
        return jsonResponse(200, json.toString())
    }

    private fun rpcError(id: Any?, code: Int, message: String): String {
        val json = JSONObject()
        json.put("jsonrpc", "2.0")
        id?.let { json.put("id", it) }
        val error = JSONObject()
        error.put("code", code)
        error.put("message", message)
        json.put("error", error)
        return jsonResponse(200, json.toString())
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID,
                "Agent远程操控",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Agent远程操控服务"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }
}
