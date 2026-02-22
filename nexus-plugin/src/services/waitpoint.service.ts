import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService } from './trigger-proxy.service';
import { WaitpointRepository, Waitpoint, CreateWaitpointData } from '../database/repositories/waitpoint.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';

const logger = createLogger({ component: 'waitpoint-service' });

export class WaitpointService {
  constructor(
    private proxy: TriggerProxyService,
    private waitpointRepo: WaitpointRepository,
    private usageRepo: UsageRepository,
    private io: SocketIOServer
  ) {}

  async createWaitpoint(
    orgId: string,
    data: {
      tokenId: string;
      runId?: string;
      triggerRunId?: string;
      projectId: string;
      taskIdentifier?: string;
      description?: string;
      input?: Record<string, any>;
      requestedBy?: string;
      expiresAt?: Date;
    }
  ): Promise<Waitpoint> {
    const waitpoint = await this.waitpointRepo.create({
      tokenId: data.tokenId,
      runId: data.runId,
      triggerRunId: data.triggerRunId,
      projectId: data.projectId,
      organizationId: orgId,
      taskIdentifier: data.taskIdentifier,
      description: data.description,
      status: 'pending',
      input: data.input,
      requestedBy: data.requestedBy,
      expiresAt: data.expiresAt,
    });

    emitToOrg(this.io, orgId, WS_EVENTS.WAITPOINT_CREATED, {
      waitpointId: waitpoint.waitpointId,
      tokenId: waitpoint.tokenId,
      taskIdentifier: waitpoint.taskIdentifier,
      description: waitpoint.description,
      expiresAt: waitpoint.expiresAt?.toISOString(),
    });

    logger.info('Waitpoint created', {
      waitpointId: waitpoint.waitpointId,
      tokenId: data.tokenId,
      orgId,
    });

    return waitpoint;
  }

  async listPending(orgId: string): Promise<Waitpoint[]> {
    return this.waitpointRepo.findPending(orgId);
  }

  async getWaitpoint(orgId: string, waitpointId: string): Promise<Waitpoint> {
    const waitpoint = await this.waitpointRepo.findById(waitpointId, orgId);
    if (!waitpoint) {
      throw new NotFoundError('Waitpoint', waitpointId);
    }
    return waitpoint;
  }

  async completeWaitpoint(
    orgId: string,
    tokenId: string,
    output: Record<string, any>,
    completedBy: string
  ): Promise<Waitpoint> {
    // Verify the waitpoint exists and is pending
    const existing = await this.waitpointRepo.findByTokenId(tokenId);
    if (!existing) {
      throw new NotFoundError('Waitpoint token', tokenId);
    }
    if (existing.organizationId !== orgId) {
      throw new NotFoundError('Waitpoint token', tokenId);
    }
    if (existing.status !== 'pending') {
      throw new ValidationError(`Waitpoint is not in pending state (current: ${existing.status})`);
    }

    // Complete in Trigger.dev
    await this.proxy.completeWaitpointToken(tokenId, output);

    // Update locally
    const completed = await this.waitpointRepo.complete(tokenId, orgId, output, completedBy);

    await this.usageRepo.record(orgId, 'waitpoint_resolution', {
      tokenId,
      waitpointId: completed.waitpointId,
      completedBy,
    });

    emitToOrg(this.io, orgId, WS_EVENTS.WAITPOINT_COMPLETED, {
      waitpointId: completed.waitpointId,
      tokenId,
      completedBy,
      output,
    });

    logger.info('Waitpoint completed', {
      waitpointId: completed.waitpointId,
      tokenId,
      orgId,
      completedBy,
    });

    return completed;
  }

  async cancelWaitpoint(orgId: string, tokenId: string): Promise<void> {
    const existing = await this.waitpointRepo.findByTokenId(tokenId);
    if (!existing) {
      throw new NotFoundError('Waitpoint token', tokenId);
    }
    if (existing.organizationId !== orgId) {
      throw new NotFoundError('Waitpoint token', tokenId);
    }
    if (existing.status !== 'pending') {
      throw new ValidationError(`Waitpoint is not in pending state (current: ${existing.status})`);
    }

    await this.waitpointRepo.expire(tokenId);

    emitToOrg(this.io, orgId, WS_EVENTS.WAITPOINT_EXPIRED, {
      waitpointId: existing.waitpointId,
      tokenId,
    });

    logger.info('Waitpoint cancelled', {
      waitpointId: existing.waitpointId,
      tokenId,
      orgId,
    });
  }
}
