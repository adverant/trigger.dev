import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService } from './trigger-proxy.service';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'queue-service' });

export class QueueService {
  constructor(
    private proxy: TriggerProxyService,
    private io: SocketIOServer
  ) {}

  async listQueues(
    orgId: string,
    projectId: string,
    params?: { page?: number; perPage?: number }
  ): Promise<any> {
    const result = await this.proxy.listQueues(params);

    logger.debug('Listed queues', {
      orgId,
      projectId,
      count: result?.data?.length || 0,
    });

    return result;
  }

  async pauseQueue(orgId: string, queueId: string): Promise<any> {
    const result = await this.proxy.pauseQueue(queueId);

    emitToOrg(this.io, orgId, WS_EVENTS.QUEUE_PAUSED, {
      queueId,
      queueName: result?.name || queueId,
      action: 'paused',
    });

    logger.info('Queue paused', { orgId, queueId });

    return result;
  }

  async resumeQueue(orgId: string, queueId: string): Promise<any> {
    const result = await this.proxy.resumeQueue(queueId);

    emitToOrg(this.io, orgId, WS_EVENTS.QUEUE_RESUMED, {
      queueId,
      queueName: result?.name || queueId,
      action: 'resumed',
    });

    logger.info('Queue resumed', { orgId, queueId });

    return result;
  }
}
