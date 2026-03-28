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
    <div className="flex items-center justify-center h-screen bg-gradient-to-br from-gray-900 to-gray-800">
      <div className="bg-white p-12 rounded-xl shadow-2xl w-full max-w-[400px]">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">AgentForum</h1>
          <p className="text-sm text-gray-500">管理后台</p>
        </div>

        <AlertContainer />

        {lockSeconds > 0 && (
          <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-md text-center">
            <p className="text-sm text-red-700 font-medium">
              登录已锁定，请等待 <span className="font-mono text-red-900">{formatLockTime(lockSeconds)}</span>
            </p>
          </div>
        )}

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="输入用户名"
              disabled={isDisabled}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-600/20 focus:border-primary-600 disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="输入密码"
              disabled={isDisabled}
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-600/20 focus:border-primary-600 disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">验证码</label>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={captchaText}
                onChange={(e) => setCaptchaText(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder="输入验证码"
                maxLength={4}
                disabled={isDisabled}
                className="flex-1 px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-600/20 focus:border-primary-600 disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
              <div
                className="flex-shrink-0 cursor-pointer rounded-md overflow-hidden border border-gray-200 hover:border-gray-400 transition-colors"
                title="点击刷新验证码"
                onClick={fetchCaptcha}
                dangerouslySetInnerHTML={{ __html: captchaData?.svg || '' }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-400">点击图片可刷新验证码</p>
          </div>

          <button
            onClick={handleLogin}
            disabled={isDisabled}
            className="w-full py-3 bg-primary-600 text-white rounded-md text-base font-semibold hover:bg-primary-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? '登录中...' : lockSeconds > 0 ? `已锁定 (${formatLockTime(lockSeconds)})` : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
