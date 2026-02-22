'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getSocket, RunLogEvent, RunStatus, RunUpdateEvent } from '@/lib/socket-client';

interface UseRunStreamOptions {
  runId: string;
  enabled?: boolean;
}

interface UseRunStreamReturn {
  logs: RunLogEvent[];
  status: RunStatus | null;
  output: unknown;
  error: string | null;
  isStreaming: boolean;
  clearLogs: () => void;
}

export function useRunStream({ runId, enabled = true }: UseRunStreamOptions): UseRunStreamReturn {
  const [logs, setLogs] = useState<RunLogEvent[]>([]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const mountedRef = useRef(true);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    if (!enabled || !runId) return;

    const socket = getSocket();

    const onRunUpdate = (event: RunUpdateEvent) => {
      if (!mountedRef.current || event.runId !== runId) return;
      setStatus(event.status);
      if (event.output !== undefined) setOutput(event.output);
      if (event.error) setError(event.error);

      const terminalStatuses: RunStatus[] = ['COMPLETED', 'FAILED', 'CANCELED'];
      if (terminalStatuses.includes(event.status)) {
        setIsStreaming(false);
      }
    };

    const onRunLog = (event: RunLogEvent) => {
      if (!mountedRef.current || event.runId !== runId) return;
      setLogs((prev) => [...prev, event]);
    };

    socket.emit('subscribe_run', { runId });
    setIsStreaming(true);

    socket.on('run_update', onRunUpdate);
    socket.on('run_log', onRunLog);

    return () => {
      mountedRef.current = false;
      socket.emit('unsubscribe_run', { runId });
      socket.off('run_update', onRunUpdate);
      socket.off('run_log', onRunLog);
    };
  }, [runId, enabled]);

  return { logs, status, output, error, isStreaming, clearLogs };
}
