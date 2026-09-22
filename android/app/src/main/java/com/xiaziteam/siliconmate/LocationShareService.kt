package com.xiaziteam.siliconmate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * v4.4.5: 实时位置共享前台服务
 * - 每30s取一次位置(WGS-84)→GCJ-02纠偏→HTTP直发SMCP消息(单聊 message/send / 群聊 group/message/send)
 * - method="location.share": 不触发 SmcpAgentService 的聊天系统通知(其过滤器只认 chat/im.send),
 *   前端 params.location_share 分支负责地图更新, 不会刷聊天流
 * - 同时把最新位置推给 WebView(__onSmcpEvent type=location_share_self)刷新发起者自己的地图标记
 * - start/end 消息由前端 JS 发送(前台时机可靠); 本服务只负责 update 上报
 */
class LocationShareService : Service() {

    companion object {
        private const val TAG = "LocationShareService"
        private const val CHANNEL_ID = "location_share"
        private const val NOTIF_ID = 10
        private const val RELAY_BASE = "https://locatenotify.online/v1/smcp"
        private const val INTERVAL_MS = 30_000L

        var isRunning = false
            private set
        var currentSessionId = ""
            private set
    }

    private val httpClient = OkHttpClient()
    private val JSON_MT = "application/json".toMediaType()
    private var locationManager: LocationManager? = null
    private var sessionId = ""
    private var target = JSONObject() // {mode:'single'|'group', to_agent, to_user, group_id}
    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val gcj = GeoUtils.wgs84ToGcj02(location.latitude, location.longitude)
            sendUpdate(gcj.first, gcj.second, location.accuracy.toDouble())
            pushSelf(gcj.first, gcj.second, location.accuracy.toDouble())
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val sid = intent?.getStringExtra("session_id") ?: ""
        val targetStr = intent?.getStringExtra("target") ?: "{}"
        if (sid.isEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }
        // 重复启动 = 换目标/换会话: 先清理旧监听
        stopLocationUpdates()
        sessionId = sid
        currentSessionId = sid
        try {
            target = JSONObject(targetStr)
        } catch (e: Exception) {
            Log.e(TAG, "bad target json: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        Log.i(TAG, "Location share started: session=$sessionId target=$targetStr")

        startAsForeground()
        requestLocationUpdates()
        // 立即报一次当前位置(不等待30s)
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val fine = ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val providers = mutableListOf(LocationManager.NETWORK_PROVIDER)
        if (fine) providers.add(LocationManager.GPS_PROVIDER)
        var fired = false
        val direct = java.util.concurrent.Executor { it.run() }
        for (p in providers) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    lm.getCurrentLocation(p, null, direct) { loc ->
                        if (loc != null && !fired) {
                            fired = true
                            val gcj = GeoUtils.wgs84ToGcj02(loc.latitude, loc.longitude)
                            sendUpdate(gcj.first, gcj.second, loc.accuracy.toDouble())
                            pushSelf(gcj.first, gcj.second, loc.accuracy.toDouble())
                        }
                    }
                } else {
                    @Suppress("DEPRECATION")
                    val loc = lm.getLastKnownLocation(p)
                    if (loc != null && !fired) {
                        fired = true
                        val gcj = GeoUtils.wgs84ToGcj02(loc.latitude, loc.longitude)
                        sendUpdate(gcj.first, gcj.second, loc.accuracy.toDouble())
                        pushSelf(gcj.first, gcj.second, loc.accuracy.toDouble())
                    }
                }
            } catch (e: Exception) {
                // provider不可用跳过
            }
        }
        isRunning = true
        return START_NOT_STICKY
    }

    private fun startAsForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = NotificationChannel(
                CHANNEL_ID, "实时位置共享", NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "位置共享进行中"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("硅侣 · 实时位置共享中")
            .setContentText("对方可在地图上看到你的位置 · 每30秒更新")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun requestLocationUpdates() {
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        locationManager = lm
        val fine = ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val providers = mutableListOf(LocationManager.NETWORK_PROVIDER)
        if (fine) providers.add(LocationManager.GPS_PROVIDER)
        for (p in providers) {
            try {
                lm.requestLocationUpdates(p, INTERVAL_MS, 0f, locationListener, mainLooper)
            } catch (e: Exception) {
                Log.w(TAG, "provider $p unavailable: ${e.message}")
            }
        }
    }

    private fun stopLocationUpdates() {
        try {
            locationManager?.removeUpdates(locationListener)
        } catch (e: Exception) {
            // ignore
        }
        locationManager = null
    }

    private fun sendUpdate(lat: Double, lng: Double, accuracy: Double) {
        try {
            if (SmcpAgentService.userId.isEmpty() || SmcpAgentService.agentId.isEmpty()) return
            val params = JSONObject()
                .put("location_share", "update")
                .put("session_id", sessionId)
                .put("lat", lat)
                .put("lng", lng)
                .put("accuracy", accuracy)
                .put("text", "📍 位置更新") // 旧客户端降级显示
            val body: org.json.JSONObject
            val mode = target.optString("mode")
            if (mode == "group") {
                body = JSONObject()
                    .put("from_agent", SmcpAgentService.agentId)
                    .put("group_id", target.optString("group_id"))
                    .put("type", "notify")
                    .put("method", "location.share")
                    .put("params", params)
            } else {
                body = JSONObject()
                    .put("from_agent", SmcpAgentService.agentId)
                    .put("to_agent", target.optString("to_agent"))
                    .put("to_user", target.optString("to_user"))
                    .put("type", "notify")
                    .put("method", "location.share")
                    .put("params", params)
            }
            val url = if (mode == "group") "$RELAY_BASE/group/message/send" else "$RELAY_BASE/message/send"
            val request = Request.Builder()
                .url(url)
                .header("X-Account-Id", SmcpAgentService.userId)
                .post(body.toString().toRequestBody(JSON_MT))
                .build()
            Thread {
                try {
                    httpClient.newCall(request).execute().use { resp ->
                        if (!resp.isSuccessful) {
                            Log.w(TAG, "share update send failed: HTTP ${resp.code}")
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "share update send error: ${e.message}")
                }
            }.start()
        } catch (e: Exception) {
            Log.e(TAG, "sendUpdate failed: ${e.message}")
        }
    }

    private fun pushSelf(lat: Double, lng: Double, accuracy: Double) {
        try {
            val payload = JSONObject()
                .put("type", "location_share_self")
                .put("session_id", sessionId)
                .put("lat", lat)
                .put("lng", lng)
                .put("accuracy", accuracy)
            MainActivity.instance?.pushSmcpEvent(payload.toString())
        } catch (e: Exception) {
            // WebView未就绪忽略
        }
    }

    override fun onDestroy() {
        stopLocationUpdates()
        isRunning = false
        currentSessionId = ""
        Log.i(TAG, "Location share stopped")
        super.onDestroy()
    }
}
