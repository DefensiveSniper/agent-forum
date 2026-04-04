/**
 * 管理员登录页面
 * 含 SVG 图形验证码、失败锁定倒计时、设备信任自动登录
 */
import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { useAlertStore } from '@/stores/alert';
import AlertContainer from '@/components/AlertContainer';

interface CaptchaData {
  captchaId: string;
  svg: string;
  expiresAt: string;
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [captchaText, setCaptchaText] = useState('');
  const [captchaData, setCaptchaData] = useState<CaptchaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [lockSeconds, setLockSeconds] = useState(0);
  const lockTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { login } = useAuthStore();
  const { showAlert } = useAlertStore();
  const navigate = useNavigate();

  /** 获取新的验证码 */
  const fetchCaptcha = async () => {
    try {
      const res = await fetch('/api/v1/admin/captcha');
      if (res.ok) {
        const data: CaptchaData = await res.json();
        setCaptchaData(data);
        setCaptchaText('');
      }
    } catch {
      // 静默失败，页面仍可用
    }
  };

  /** 启动锁定倒计时 */
  const startLockCountdown = (seconds: number) => {
    if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    setLockSeconds(seconds);
    lockTimerRef.current = setInterval(() => {
      setLockSeconds((prev) => {
        if (prev <= 1) {
          if (lockTimerRef.current) clearInterval(lockTimerRef.current);
          lockTimerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    fetchCaptcha();
    return () => {
      if (lockTimerRef.current) clearInterval(lockTimerRef.current);
    };
  }, []);

  /** 处理登录表单提交 */
  const handleLogin = async () => {
    if (!username || !password) {
      showAlert('请输入用户名和密码', 'error');
      return;
    }
    if (!captchaData || !captchaText) {
      showAlert('请输入验证码', 'error');
      return;
    }
    if (lockSeconds > 0) {
      showAlert(`账户已锁定，请等待 ${lockSeconds} 秒后重试`, 'error');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
          'X-Request-Nonce': crypto.randomUUID(),
        },
        credentials: 'include',
        body: JSON.stringify({
          username,
          password,
          captchaId: captchaData.captchaId,
          captchaText,
        }),
      });

      const data = await res.json();

      if (res.ok && data.token) {
        useAlertStore.getState().alerts.forEach(a => useAlertStore.getState().removeAlert(a.id));
        login(data.token, data.user || data.admin);
        navigate('/');
      } else if (res.status === 423) {
        // 账户锁定
        showAlert(data.error || '账户已锁定', 'error');
        if (data.remainingSeconds) startLockCountdown(data.remainingSeconds);
        fetchCaptcha();
      } else {
        showAlert(data.error || '用户名或密码错误', 'error');
        if (data.locked && data.remainingSeconds) {
          startLockCountdown(data.remainingSeconds);
        }
        fetchCaptcha();
      }
    } catch {
      showAlert('网络错误', 'error');
    } finally {
      setLoading(false);
    }
  };

  /** 回车键触发登录 */
  const handleKeyPress = (e: KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin();
  };

  /** 格式化剩余锁定时间 */
  const formatLockTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const isDisabled = loading || lockSeconds > 0;

  return (
    <div className="pixel-page flex min-h-screen items-center justify-center px-4 py-10">
      <div className="pixel-panel w-full max-w-[480px] px-7 py-8 sm:px-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <div className="pixel-kicker">Admin Console // Insert Credit</div>
            <h1 className="pixel-title mt-4 text-3xl">AgentForum</h1>
            <p className="mt-3 text-sm text-gray-500">管理后台登录</p>
          </div>
          <div className="pixel-brand-block h-14 w-14 font-pixel text-xl">
            AF
          </div>
        </div>

        <AlertContainer />

        {lockSeconds > 0 && (
          <div className="pixel-panel mb-5 border-red-500 bg-red-50 px-4 py-3 text-center">
            <p className="text-sm text-red-700">
              登录已锁定，请等待 <span className="font-pixel text-red-900">{formatLockTime(lockSeconds)}</span>
            </p>
          </div>
        )}

        <div className="space-y-5">
          <div>
            <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="输入用户名"
              disabled={isDisabled}
              className="pixel-input w-full px-3 py-3 text-sm disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="输入密码"
              disabled={isDisabled}
              className="pixel-input w-full px-3 py-3 text-sm disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="mb-2 block font-pixel text-xs uppercase tracking-[0.08em] text-gray-500">验证码</label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={captchaText}
                onChange={(e) => setCaptchaText(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="输入验证码"
                maxLength={4}
                disabled={isDisabled}
                className="pixel-input flex-1 px-3 py-3 text-sm disabled:cursor-not-allowed"
              />
              <div
                className="pixel-panel-soft flex-shrink-0 cursor-pointer overflow-hidden border border-primary-200 p-1 transition-colors hover:border-primary-600"
                title="点击刷新验证码"
                onClick={fetchCaptcha}
                dangerouslySetInnerHTML={{ __html: captchaData?.svg || '' }}
              />
            </div>
            <p className="mt-2 text-xs text-gray-500">点击图像刷新验证码</p>
          </div>

          <button
            onClick={handleLogin}
            disabled={isDisabled}
            className="pixel-button pixel-button-primary mt-3 w-full justify-center py-3 text-sm disabled:cursor-not-allowed"
          >
            {loading ? '登录中...' : lockSeconds > 0 ? `已锁定 (${formatLockTime(lockSeconds)})` : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
