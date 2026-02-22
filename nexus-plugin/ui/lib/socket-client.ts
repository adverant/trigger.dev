import { io, Socket } from 'socket.io-client';

export type RunStatus =
  | 'QUEUED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED'
  | 'FROZEN'
  | 'REATTEMPTING'
  | 'WAITING_FOR_DEPLOY';

export interface RunUpdateEvent {
  runId: string;
  taskId: string;
  status: RunStatus;
  output?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunLogEvent {
  runId: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
  data?: any;
}

export interface TaskSyncEvent {
  taskId: string;
  version: string;
  action: 'registered' | 'updated' | 'removed';
}

export interface ScheduleFireEvent {
  scheduleId: string;
  taskId: string;
  runId: string;
  firedAt: string;
}

export interface WaitpointEvent {
  waitpointId: string;
  taskId: string;
  runId: string;
  type: 'created' | 'resolved' | 'expired';
}

export interface SocketEvents {
  run_update: RunUpdateEvent;
  run_log: RunLogEvent;
  task_sync: TaskSyncEvent;
  schedule_fire: ScheduleFireEvent;
  waitpoint_event: WaitpointEvent;
  connect: void;
  disconnect: void;
}

let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (socketInstance) return socketInstance;

  const wsPath = process.env.NEXT_PUBLIC_WS_PATH || '/trigger/ws';
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || (typeof window !== 'undefined' ? window.location.origin : '');

  let authToken: string | null = null;
  if (typeof window !== 'undefined') {
    authToken = localStorage.getItem('trigger_auth_token');
    if (!authToken) {
      const match = document.cookie.match(/(?:^|;\s*)trigger_token=([^;]*)/);
      authToken = match ? decodeURIComponent(match[1]) : null;
    }
  }

  socketInstance = io(baseUrl, {
    path: wsPath,
    auth: authToken ? { token: authToken } : undefined,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    timeout: 20000,
  });

  socketInstance.on('connect', () => {
    console.log('[Trigger WS] Connected:', socketInstance?.id);
  });

  socketInstance.on('disconnect', (reason) => {
    console.log('[Trigger WS] Disconnected:', reason);
  });

  socketInstance.on('connect_error', (err) => {
    console.error('[Trigger WS] Connection error:', err.message);
  });

  return socketInstance;
}

export function disconnectSocket(): void {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}
