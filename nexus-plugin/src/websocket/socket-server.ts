import { Server as SocketIOServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { WS_EVENTS } from './events';
import { createLogger } from '../utils/logger';

const logger = createLogger({ service: 'nexus-trigger', component: 'websocket' });

interface AuthenticatedSocket extends Socket {
  userId?: string;
  organizationId?: string;
  tier?: string;
}

const TIER_CONNECTION_LIMITS: Record<string, number> = {
  open_source: 5,
  teams: 20,
  government: 100,
};

const TIER_MESSAGE_LIMITS: Record<string, number> = {
  open_source: 200,
  teams: 1000,
  government: 5000,
};

const orgConnectionCounts = new Map<string, number>();
const orgMessageCounts = new Map<string, { count: number; resetAt: number }>();

export function setupSocketServer(
  io: SocketIOServer,
  authClient: any,
  redisClient?: Redis
): void {
  // Attach Redis adapter for horizontal scaling if Redis is available
  if (redisClient) {
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient) as any);
    logger.info('Socket.IO Redis adapter attached for multi-pod scaling');
  }

  // Authentication middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const user = await authClient.validateToken(token);
      if (!user) {
        return next(new Error('Invalid authentication token'));
      }

      socket.userId = user.userId;
      socket.organizationId = user.organizationId;
      socket.tier = user.tier;

      // Check connection limits
      const currentCount = orgConnectionCounts.get(user.organizationId) || 0;
      const limit = TIER_CONNECTION_LIMITS[user.tier] || TIER_CONNECTION_LIMITS.open_source;
      if (limit !== -1 && currentCount >= limit) {
        return next(new Error(`Connection limit reached (${limit} for ${user.tier} tier)`));
      }

      next();
    } catch (err: any) {
      logger.warn('WebSocket authentication failed', {
        error: err.message,
        socketId: socket.id,
      });
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const orgId = socket.organizationId!;
    const userId = socket.userId!;
    const tier = socket.tier!;

    // Track connection count
    orgConnectionCounts.set(orgId, (orgConnectionCounts.get(orgId) || 0) + 1);

    logger.info('Client connected', {
      socketId: socket.id,
      userId,
      organizationId: orgId,
      tier,
      connections: orgConnectionCounts.get(orgId),
    });

    // Auto-join organization room
    socket.join(`org:${orgId}`);

    // Handle room subscriptions
    socket.on(WS_EVENTS.JOIN, (data: { room: string }) => {
      if (!data?.room) return;
      // Only allow joining own org's rooms
      if (data.room.startsWith(`org:${orgId}`) || data.room.startsWith(`run:`)) {
        socket.join(data.room);
        logger.debug('Client joined room', { socketId: socket.id, room: data.room });
      }
    });

    socket.on(WS_EVENTS.LEAVE, (data: { room: string }) => {
      if (!data?.room) return;
      socket.leave(data.room);
      logger.debug('Client left room', { socketId: socket.id, room: data.room });
    });

    // Subscribe to specific run updates
    socket.on(WS_EVENTS.SUBSCRIBE_RUN, (data: { runId: string }) => {
      if (!data?.runId) return;
      const room = `run:${data.runId}`;
      socket.join(room);
      logger.debug('Client subscribed to run', { socketId: socket.id, runId: data.runId });
    });

    socket.on(WS_EVENTS.UNSUBSCRIBE_RUN, (data: { runId: string }) => {
      if (!data?.runId) return;
      socket.leave(`run:${data.runId}`);
    });

    // Rate limit messages
    socket.use((event, next) => {
      const now = Date.now();
      const key = orgId;
      const entry = orgMessageCounts.get(key);
      const limit = TIER_MESSAGE_LIMITS[tier] || TIER_MESSAGE_LIMITS.open_source;

      if (!entry || now > entry.resetAt) {
        orgMessageCounts.set(key, { count: 1, resetAt: now + 60000 });
        return next();
      }

      if (limit !== -1 && entry.count >= limit) {
        logger.warn('WebSocket message rate limit exceeded', { orgId, tier, count: entry.count });
        return next(new Error('Message rate limit exceeded'));
      }

      entry.count++;
      next();
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      const currentCount = orgConnectionCounts.get(orgId) || 1;
      orgConnectionCounts.set(orgId, Math.max(0, currentCount - 1));

      logger.info('Client disconnected', {
        socketId: socket.id,
        userId,
        organizationId: orgId,
        reason,
        remainingConnections: orgConnectionCounts.get(orgId),
      });
    });

    socket.on('error', (err) => {
      logger.error('WebSocket error', {
        socketId: socket.id,
        userId,
        organizationId: orgId,
        error: err.message,
      });
    });
  });

  logger.info('Socket.IO server initialized');
}

/**
 * Emit an event to all clients in an organization room.
 */
export function emitToOrg(io: SocketIOServer, orgId: string, event: string, data: any): void {
  io.to(`org:${orgId}`).emit(event, {
    ...data,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}

/**
 * Emit an event to clients subscribed to a specific run.
 */
export function emitToRun(io: SocketIOServer, runId: string, event: string, data: any): void {
  io.to(`run:${runId}`).emit(event, {
    ...data,
    timestamp: data.timestamp || new Date().toISOString(),
  });
}

/**
 * Get current WebSocket statistics.
 */
export function getSocketStats(io: SocketIOServer): {
  totalConnections: number;
  orgConnectionCounts: Record<string, number>;
} {
  return {
    totalConnections: io.engine?.clientsCount || 0,
    orgConnectionCounts: Object.fromEntries(orgConnectionCounts),
  };
}
