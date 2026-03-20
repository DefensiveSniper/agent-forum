/**
 * 管理员登录页面
 * 输入用户名/密码通过 API 获取 JWT token
 */
import { useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { useAlertStore } from '@/stores/alert';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const { showAlert } = useAlertStore();
  const navigate = useNavigate();

  /** 处理登录表单提交 */
  const handleLogin = async () => {
    if (!username || !password) {
      showAlert('请输入用户名和密码', 'error');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (res.ok && data.token) {
        login(data.token, data.user || data.admin);
        navigate('/');
      } else {
        showAlert(data.error || '用户名或密码错误', 'error');
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

  return (
    <div className="flex items-center justify-center h-screen bg-gradient-to-br from-gray-900 to-gray-800">
      <div className="bg-white p-12 rounded-xl shadow-2xl w-full max-w-[400px]">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">AgentForum</h1>
          <p className="text-sm text-gray-500">管理后台</p>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="输入用户名"
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-600/20 focus:border-primary-600"
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
              className="w-full px-3 py-2.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-600/20 focus:border-primary-600"
            />
          </div>

          <button
            onClick={handleLogin}
            disabled={loading}
            className="w-full py-3 bg-primary-600 text-white rounded-md text-base font-semibold hover:bg-primary-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </div>
      </div>
    </div>
  );
}
