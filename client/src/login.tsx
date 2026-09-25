import React, { useState } from 'react'

interface LoginProps {
  onLoginSuccess: (sessionId: string, chatgptSession?: { access_token: string; cookies: any; expires: string }, activated?: boolean, plan?: string, siliconId?: string, accountName?: string) => void
}

type Tab = 'login' | 'register'

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [tab, setTab] = useState<Tab>('login')
  const [accountName, setAccountName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState('')
  const [messageClass, setMessageClass] = useState('')
  const [loading, setLoading] = useState(false)

  const invoke = (window as any).__TAURI__?.core?.invoke

  const say = (text: string, cls: string = '') => {
    setMessage(text)
    setMessageClass(cls)
  }

  const handleLogin = async () => {
    if (!accountName.trim() || !password) {
      say('请输入账号和密码', 'err')
      return
    }
    if (!invoke) { say('Tauri环境未就绪', 'err'); return }
    console.log('[login] invoke available:', !!invoke)

    setLoading(true)
    say('登录中...')

    try {
      console.log('[login] invoking l1_login for:', accountName.trim())
      const resp = await invoke('l1_login', {
        accountName: accountName.trim(),
        password,
      })
      console.log('[login] response:', JSON.stringify(resp))
      say('登录成功', 'ok')

      if (resp.tunnel) {
        try { await invoke('start_tunnel', { config: resp.tunnel }) } catch (te) { console.warn('[login] tunnel start failed:', te) }
      }

      if (resp.activated) {
        try {
          const payload = await invoke('apply_session')
          console.log('[login] session payload OK')
          onLoginSuccess(payload.session_id, payload.chatgpt_session, true, resp.plan, resp.silicon_id, resp.account_name)
        } catch (se) {
          console.warn('[login] apply_session failed:', se)
          onLoginSuccess(resp.account_id, undefined, true, resp.plan, resp.silicon_id, resp.account_name)
        }
      } else {
        console.log('[login] not activated, entering free mode')
        onLoginSuccess(resp.account_id, undefined, false, undefined, resp.silicon_id, resp.account_name)
      }

      try { await invoke('finish_enter') } catch {}
    } catch (e: any) {
      console.error('[login] FAILED:', e)
      say(String(e), 'err')
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async () => {
    if (!accountName.trim() || !password) {
      say('请输入账号和密码', 'err')
      return
    }
    if (accountName.trim().length < 3) {
      say('账号名至少3个字符', 'err')
      return
    }
    if (password.length < 6) {
      say('密码至少6位', 'err')
      return
    }
    if (password !== confirmPassword) {
      say('两次密码不一致', 'err')
      return
    }
    if (!invoke) { say('Tauri环境未就绪', 'err'); return }

    setLoading(true)
    say('注册中...')

    try {
      console.log('[register] invoking for:', accountName.trim())
      const resp = await invoke('register', {
        accountName: accountName.trim(),
        password,
      })
      say('注册成功，请激活后使用全部功能', 'ok')

      onLoginSuccess(resp.account_id, undefined, false, undefined, resp.silicon_id, accountName.trim())
      try { await invoke('finish_enter') } catch {}
    } catch (e: any) {
      console.error('[register] FAILED:', e)
      say(String(e), 'err')
    } finally {
      setLoading(false)
    }
  }

  const tabStyle = (active: boolean) => ({
    flex: 1,
    padding: '10px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: active ? 600 : 400,
    color: active ? '#e6e6e6' : '#7a8aa0',
    borderBottom: active ? '2px solid #2a5cff' : '2px solid transparent',
    transition: 'all 0.2s',
  })

  const inputStyle = {
    width: '100%',
    background: '#0f1115',
    border: '1px solid #333',
    borderRadius: '10px',
    padding: '12px 16px',
    color: '#e6e6e6',
    fontSize: '14px',
    outline: 'none',
    marginBottom: '12px',
    boxSizing: 'border-box' as const,
  }

  const btnPrimary = {
    width: '100%',
    background: '#2a5cff',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    padding: '12px',
    fontSize: '16px',
    cursor: loading ? 'not-allowed' : 'pointer',
    marginBottom: '12px',
    opacity: loading ? 0.6 : 1,
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      padding: '16px',
      overflowY: 'auto',
      background: '#0f1115',
      color: '#e6e6e6',
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    }}>
      <div style={{
        background: '#1a1d25',
        borderRadius: '16px',
        padding: '40px 24px',
        width: '360px',
        maxWidth: '100%',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}>
        <h1 style={{ fontSize: '28px', fontWeight: 600, marginBottom: '8px', textAlign: 'center' }}>
          硅侣
        </h1>
        <p style={{ fontSize: '14px', color: '#7a8aa0', marginBottom: '4px', textAlign: 'center' }}>
          SiliconMate · 硅基生命数字人伴侣
        </p>
        <p title={`构建 ${__BUILD_TIME__}`} style={{ fontSize: '11px', color: '#4a5568', marginBottom: '24px', textAlign: 'center' }}>
          v{__APP_VERSION__}
        </p>

        {/* Tab switch */}
        <div style={{ display: 'flex', marginBottom: '24px', borderBottom: '1px solid #222' }}>
          <div style={tabStyle(tab === 'login')} onClick={() => setTab('login')}>登录</div>
          <div style={tabStyle(tab === 'register')} onClick={() => setTab('register')}>注册</div>
        </div>

        {/* Form */}
        <input
          type="text"
          placeholder="账号"
          value={accountName}
          onChange={e => setAccountName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (tab === 'login' ? handleLogin() : handleRegister())}
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && (tab === 'login' ? handleLogin() : handleRegister())}
          style={inputStyle}
        />
        {tab === 'register' && (
          <input
            type="password"
            placeholder="确认密码"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleRegister()}
            style={inputStyle}
          />
        )}

        <button
          onClick={tab === 'login' ? handleLogin : handleRegister}
          disabled={loading}
          style={btnPrimary}
        >
          {loading ? (tab === 'login' ? '登录中...' : '注册中...') : (tab === 'login' ? '登录' : '注册')}
        </button>

        {message && (
          <p style={{
            marginTop: '16px',
            fontSize: '13px',
            textAlign: 'center',
            color: messageClass === 'err' ? '#e74c3c' : messageClass === 'ok' ? '#2ecc71' : '#7a8aa0',
          }}>
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
