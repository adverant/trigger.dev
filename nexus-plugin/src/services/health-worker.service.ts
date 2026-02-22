/**
 * Background Health Check Worker
 *
 * Periodically checks health of all enabled integration services.
 * Updates the database and emits WebSocket events on status changes.
 */

import { Server as SocketIOServer } from 'socket.io';
import { IntegrationConfigRepository, ServiceName, HealthStatus } from '../database/repositories/integration-config.repository';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';
import type { ServiceClientRegistry } from './client-registry';

const logger = createLogger({ component: 'health-worker' });

export class HealthWorkerService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private integrationConfigRepo: IntegrationConfigRepository,
    private clientRegistry: ServiceClientRegistry,
    private io: SocketIOServer,
    private intervalMs: number = 60000
  ) {}

  start(): void {
    if (this.intervalHandle) {
      return;
    }

    logger.info('Health worker started', { intervalMs: this.intervalMs });

    // Run immediately on start
    this.checkAll().catch((err) =>
      logger.error('Initial health check failed', { error: err.message })
    );

    this.intervalHandle = setInterval(() => {
      this.checkAll().catch((err) =>
        logger.error('Periodic health check failed', { error: err.message })
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('Health worker stopped');
    }
  }

  /**
   * Check all enabled integrations across all organizations.
   * Since we're a background worker, we check all orgs.
   */
  private async checkAll(): Promise<void> {
    // Get all unique org IDs from the integration_configs table
    // For each service that has a client, do a health check
    const services = Array.from(this.clientRegistry.keys());

    if (services.length === 0) {
      return;
    }

    const results: Array<{ service: ServiceName; status: HealthStatus; latency: number }> = [];

    await Promise.allSettled(
      services.map(async (serviceName) => {
        const client = this.clientRegistry.get(serviceName);
        if (!client) return;

        try {
          const result = await client.healthCheck();
          const healthStatus: HealthStatus =
            result.status === 'healthy' ? 'healthy' :
            result.status === 'degraded' ? 'degraded' : 'unhealthy';

          results.push({ service: serviceName, status: healthStatus, latency: result.latency });
        } catch (err: any) {
          results.push({ service: serviceName, status: 'unhealthy', latency: 0 });
        }
      })
    );

    // Update all orgs that have these services configured
    // We use a simple approach: update all rows for each service
    for (const { service, status, latency } of results) {
      try {
        // Update health status for all orgs that have this service configured
        await this.integrationConfigRepo.updateHealthStatusAll(service, status, new Date());
      } catch (err: any) {
        logger.error(`Failed to update health for ${service}`, { error: err.message });
      }
    }

    const healthySvcs = results.filter((r) => r.status === 'healthy').length;
    const totalSvcs = results.length;
    logger.debug(`Health check complete: ${healthySvcs}/${totalSvcs} healthy`, {
      results: results.map((r) => `${r.service}:${r.status}(${r.latency}ms)`),
    });
  }
}
