/**
 * 硅侣2.0 — 语音聊天（Obscura ChatGPT透传）
 *
 * 功能：
 * - 点击语音聊天按钮切换到Obscura透传视图
 * - 加载chatgpt.html（ChatGPT iframe + CDP screencast）
 * - 启动Obscura sidecar → 等待CDP就绪 → 注入cookies → 加载页面
 * - 返回按钮切回日常对话模式
 *
 * 依赖：obscura.rs (start_obscura, stop_obscura, inject_cookies, obscura_status)
 */

import React, { useState, useEffect, useCallback } from 'react'

interface VoiceChatProps {
  onBack: () => void
  sessionId?: string
  chatgptSession?: { access_token: string; cookies: any; expires: string }
}

type VoiceStatus = 'idle' | 'starting_obscura' | 'waiting_cdp' | 'injecting_cookies' | 'ready' | 'error'

export const VoiceChat: React.FC<VoiceChatProps> = ({ onBack, sessionId, chatgptSession }) => {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const invoke = (window as any).__TAURI__?.core?.invoke
  const listen = (window as any).__TAURI__?.event?.listen

  // Start CDP browser and transition through states
  const startVoiceChat = useCallback(async () => {
    if (!invoke) {
      setErrorMsg('Tauri环境未就绪')
      setStatus('error')
      return
    }

    // Use native webview instead of CDP+Chrome
    try {
      await invoke('open_chatgpt_webview')
      setStatus('ready')
    } catch (e: any) {
      setErrorMsg(String(e))
      setStatus('error')
      console.error('[voice] webview failed:', e)
    }
  }, [invoke, chatgptSession])

  // Listen for CDP ready event
  useEffect(() => {
    if (!listen) return

    const unlistenReady = listen('obscura-ready', async (event: any) => {
      const port = event.payload || 9222
      console.log('[voice] obscura-ready, port:', port)
      if (invoke) {
        try {
          await invoke('obscura_set_ready', { port })
        } catch (e) {
          console.warn('[voice] set_ready failed:', e)
        }
      }
      setStatus('injecting_cookies')

      if (invoke && chatgptSession) {
        try {
          await invoke('inject_chatgpt_session', {
            cookiesJson: chatgptSession.cookies,
            accessToken: chatgptSession.access_token,
          })
        } catch (e) {
          console.warn('[voice] Cookie injection failed:', e)
        }
      }

      // Wait 2s for cookies to settle and navigation to complete, then show iframe
      await new Promise(r => setTimeout(r, 2000))
      setStatus('ready')
    })

    const unlistenError = listen('obscura-error', (event: any) => {
      const msg = String(event.payload || 'CDP浏览器启动失败')
      setErrorMsg(msg)
      setStatus('error')
      console.error('[voice] obscura-error:', msg)
    })

    return () => {
      // Cleanup listeners
      if (typeof unlistenReady === 'function') unlistenReady()
      if (typeof unlistenError === 'function') unlistenError()
    }
  }, [listen, invoke, sessionId])

  // Auto-start on mount
  useEffect(() => {
    if (status === 'idle') {
      startVoiceChat()
    }
  }, [status, startVoiceChat])

  // Handle back button
  const handleBack = useCallback(async () => {
    if (invoke) {
      try {
        await invoke('stop_obscura')
      } catch (e) {
        console.warn('[voice] Stop obscura failed:', e)
      }
    }
    onBack()
  }, [invoke, onBack])

  // Status display
  const statusDisplay = (() => {
    switch (status) {
      case 'starting_obscura':
        return { icon: '⏳', text: '正在启动浏览器…', color: '#7a8aa0' }
      case 'waiting_cdp':
        return { icon: '⏳', text: '等待浏览器就绪…', color: '#7a8aa0' }
      case 'injecting_cookies':
        return { icon: '🔑', text: '注入认证信息…', color: '#f39c12' }
      case 'ready':
        return { icon: '🎤', text: 'ChatGPT 语音聊天就绪', color: '#2ecc71' }
      case 'error':
        return { icon: '⚠️', text: errorMsg || '启动失败', color: '#e74c3c' }
      default:
        return { icon: '🎤', text: '准备中…', color: '#7a8aa0' }
    }
  })()

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: '#0f1115',
      color: '#e6e6e6',
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    }}>
      {/* Header bar */}
      <header style={{
        padding: '10px 20px',
        background: 'linear-gradient(90deg, #1a2a4a, #0f1115)',
        borderBottom: '1px solid #222',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}>
        <button
          onClick={handleBack}
          style={{
            background: '#1c2030',
            color: '#e6e6e6',
            border: '1px solid #333',
            borderRadius: '8px',
            padding: '6px 14px',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          ← 返回
        </button>
        <span style={{ fontSize: '16px', fontWeight: 600 }}>语音聊天</span>
        <span style={{
          fontSize: '12px',
          color: statusDisplay.color,
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          {statusDisplay.icon} {statusDisplay.text}
        </span>
      </header>

      {/* Content area */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '20px',
        padding: '20px',
      }}>
        {status === 'ready' ? (
          <div style={{
            width: '100%',
            height: '100%',
            borderRadius: '12px',
            overflow: 'hidden',
            border: '1px solid #333',
          }}>
            <iframe
              src={(window as any).__TAURI__ ? "http://localhost:5174/chatgpt.html" : "about:blank"}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
              }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              allow="microphone; camera"
            />
          </div>
        ) : status === 'error' ? (
          /* Error view */
          <div style={{
            textAlign: 'center',
            padding: '40px',
            background: '#1c2030',
            borderRadius: '12px',
            border: '1px solid #e74c3c',
            maxWidth: '400px',
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
            <div style={{ color: '#e74c3c', fontSize: '16px', marginBottom: '8px' }}>
              语音聊天启动失败
            </div>
            <div style={{ color: '#7a8aa0', fontSize: '13px', marginBottom: '20px' }}>
              {errorMsg}
            </div>
            <div style={{ color: '#555', fontSize: '12px', marginBottom: '16px' }}>
              请确保已安装 Google Chrome 浏览器
            </div>
            <button
              onClick={handleBack}
              style={{
                background: '#2a5cff',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '10px 20px',
                cursor: 'pointer',
                fontSize: '14px',
              }}
            >
              返回日常对话
            </button>
          </div>
        ) : (
          /* Loading view */
          <div style={{
            textAlign: 'center',
            padding: '40px',
          }}>
            <div style={{
              width: '40px',
              height: '40px',
              border: '3px solid #333',
              borderTop: '3px solid #2a5cff',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 20px',
            }} />
            <div style={{ color: '#7a8aa0', fontSize: '14px' }}>
              {statusDisplay.text}
            </div>
            <div style={{ color: '#555', fontSize: '12px', marginTop: '8px' }}>
              首次启动可能需要较长时间
            </div>
          </div>
        )}
      </div>

      {/* Animations */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
