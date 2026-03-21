/**
 * WebSocket 全局单例连接管理
 * 连接在 Layout 层建立一次，各页面通过 useWebSocket 订阅事件
 */
import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/auth';

interface WSMessage {
  type: string;
  payload: unknown;
  timestamp: string;
  channelId?: string;
}

type MessageHandler = (message: WSMessage) => void;

// ============ 全局单例 ============

/** 全局 WebSocket 实例 */
let globalWs: WebSocket | null = null;

/** 全局重连计时器 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** 全局事件订阅者集合 */
const subscribers = new Set<MessageHandler>();

/** 连接状态标记，防止重复连接 */
let connecting = false;

/**
 * 建立全局 WebSocket 连接（仅在尚无连接时生效）
 */
function connectGlobal() {
  const token = useAuthStore.getState().token;
  if (!token) return;

  // 已有活跃连接或正在连接中，不重复
  if (globalWs && (globalWs.readyState === WebSocket.OPEN || globalWs.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (connecting) return;
  connecting = true;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/admin?token=${encodeURIComponent(token)}`;

  try {
    const ws = new WebSocket(wsUrl);
    globalWs = ws;

    ws.onopen = () => {
      connecting = false;
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WSMessage;

        // 响应心跳
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', payload: {}, timestamp: new Date().toISOString() }));
          return;
        }

        // 通知所有订阅者
        for (const handler of subscribers) {
          handler(message);
        }
      } catch {
        // 忽略无效消息
      }
    };

    ws.onclose = () => {
      globalWs = null;
      connecting = false;
      // 自动重连（3 秒）
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectGlobal, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch {
    connecting = false;
    reconnectTimer = setTimeout(connectGlobal, 3000);
  }
}

/**
 * 关闭全局 WebSocket 连接（登出时调用）
 */
function disconnectGlobal() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (globalWs) {
    globalWs.onclose = null; // 阻止自动重连
    globalWs.close();
    globalWs = null;
  }
  connecting = false;
}

// ============ Hooks ============

/**
 * 初始化全局 WebSocket 连接（在 Layout 中调用一次）
 * 仅在已认证时建立连接，未认证时跳过
 */
export function useWebSocketInit() {
  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated) {
      connectGlobal();
    }

    // 监听认证状态变化：登录时连接，登出时断开
    const unsub = useAuthStore.subscribe((state) => {
      if (state.isAuthenticated) {
        connectGlobal();
      } else {
        disconnectGlobal();
      }
    });

    return () => {
      unsub();
    };
  }, [isAuthenticated]);
}

/**
 * 订阅 WebSocket 事件（各页面组件中调用）
 * 组件卸载时自动取消订阅，不影响全局连接
 * @param onMessage - 消息回调，接收所有非 ping 事件
 */
export function useWebSocket(onMessage?: MessageHandler) {
  // 用 ref 始终指向最新的回调，避免闭包陈旧
  const handlerRef = useRef<MessageHandler | undefined>(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    // 包装一层，确保始终调用最新的回调
    const wrapper: MessageHandler = (msg) => {
      handlerRef.current?.(msg);
    };

    subscribers.add(wrapper);

    return () => {
      subscribers.delete(wrapper);
    };
  }, []); // 空依赖：仅挂载/卸载时执行
}
