/**
 * WebSocket 连接 Hook
 * 管理与服务器的实时 WebSocket 连接
 */
import { useEffect, useRef, useCallback, useState } from 'react';

interface WSMessage {
  type: string;
  payload: unknown;
  timestamp: string;
  channelId?: string;
}

type MessageHandler = (message: WSMessage) => void;

/**
 * 管理员 WebSocket 连接 Hook
 * 用于前端看板实时接收所有事件
 */
export function useWebSocket(onMessage?: MessageHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());

  if (onMessage) {
    handlersRef.current.add(onMessage);
  }

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/admin`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WSMessage;
          setLastMessage(message);

          // 响应 ping
          if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', payload: {}, timestamp: new Date().toISOString() }));
            return;
          }

          // 通知所有 handlers
          for (const handler of handlersRef.current) {
            handler(message);
          }
        } catch {
          // 忽略无效消息
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        // 自动重连
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      // 连接失败，稍后重试
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  const send = useCallback((message: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  return { isConnected, lastMessage, send };
}
