'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket, disconnectSocket } from '@/lib/socket-client';

interface UseSocketOptions {
  orgId?: string;
  autoConnect?: boolean;
}

interface UseSocketReturn {
  socket: Socket | null;
  connected: boolean;
  error: string | null;
  reconnect: () => void;
}

export function useSocket(options: UseSocketOptions = {}): UseSocketReturn {
  const { orgId, autoConnect = true } = options;
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (!autoConnect) return;

    const sock = getSocket();
    setSocket(sock);

    const onConnect = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setError(null);
      if (orgId) {
        sock.emit('join_org', { orgId });
      }
    };

    const onDisconnect = () => {
      if (!mountedRef.current) return;
      setConnected(false);
    };

    const onConnectError = (err: Error) => {
      if (!mountedRef.current) return;
      setError(err.message);
      setConnected(false);
    };

    sock.on('connect', onConnect);
    sock.on('disconnect', onDisconnect);
    sock.on('connect_error', onConnectError);

    if (sock.connected) {
      setConnected(true);
      if (orgId) {
        sock.emit('join_org', { orgId });
      }
    }

    return () => {
      mountedRef.current = false;
      sock.off('connect', onConnect);
      sock.off('disconnect', onDisconnect);
      sock.off('connect_error', onConnectError);
    };
  }, [autoConnect, orgId]);

  const reconnect = useCallback(() => {
    disconnectSocket();
    const sock = getSocket();
    setSocket(sock);
  }, []);

  return { socket, connected, error, reconnect };
}
