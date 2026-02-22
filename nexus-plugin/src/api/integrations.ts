import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import axios from 'axios';
import {
  IntegrationConfigRepository,
  ServiceName,
  HealthStatus,
} from '../database/repositories/integration-config.repository';
import { NexusConfig } from '../config';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-integrations' });

const VALID_SERVICES: ServiceName[] = [
  'graphrag',
  'mageagent',
  'fileprocess',
  'learningagent',
  'geoagent',
  'jupyter',
  'cvat',
  'gpu-bridge',
  'sandbox',
  'n8n',
];

const updateIntegrationSchema = Joi.object({
  enabled: Joi.boolean().optional(),
  serviceUrl: Joi.string().uri().allow('').optional(),
  config: Joi.object().optional(),
}).min(1);

export function createIntegrationRouter(
  integrationConfigRepo: IntegrationConfigRepository,
  nexusConfig: NexusConfig,
  io: SocketIOServer
): Router {
  const router = Router();

  // GET / - List all integration configs for org
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const configs = await integrationConfigRepo.findByOrgId(req.user!.organizationId);

      // Fill in defaults for services that haven't been configured yet
      const configMap = new Map(configs.map((c) => [c.serviceName, c]));
      const allConfigs = VALID_SERVICES.map((serviceName) => {
        const existing = configMap.get(serviceName);
        if (existing) return existing;

        const defaultUrl = (nexusConfig.services as any)[serviceName] || '';
        return {
          configId: null,
          organizationId: req.user!.organizationId,
          serviceName,
          enabled: false,
          serviceUrl: defaultUrl,
          config: {},
          lastHealthCheck: null,
          healthStatus: 'unknown' as HealthStatus,
          createdAt: null,
          updatedAt: null,
        };
      });

      res.json({
        success: true,
        data: allConfigs,
      });
    })
  );

  // GET /health-summary - Get all integration health statuses
  router.get(
    '/health-summary',
    asyncHandler(async (req: Request, res: Response) => {
      const configs = await integrationConfigRepo.findByOrgId(req.user!.organizationId);

      const summary = configs.map((c) => ({
        serviceName: c.serviceName,
        enabled: c.enabled,
        healthStatus: c.healthStatus,
        lastHealthCheck: c.lastHealthCheck,
      }));

      res.json({
        success: true,
        data: summary,
      });
    })
  );

  // GET /:serviceName - Get specific integration config
  router.get(
    '/:serviceName',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid service name: ${serviceName}. Valid: ${VALID_SERVICES.join(', ')}`,
          },
        });
        return;
      }

      const config = await integrationConfigRepo.findByService(
        req.user!.organizationId,
        serviceName
      );

      if (!config) {
        const defaultUrl = (nexusConfig.services as any)[serviceName] || '';
        res.json({
          success: true,
          data: {
            configId: null,
            organizationId: req.user!.organizationId,
            serviceName,
            enabled: false,
            serviceUrl: defaultUrl,
            config: {},
            lastHealthCheck: null,
            healthStatus: 'unknown',
            createdAt: null,
            updatedAt: null,
          },
        });
        return;
      }

      res.json({
        success: true,
        data: config,
      });
    })
  );

  // PUT /:serviceName - Update/enable integration config
  router.put(
    '/:serviceName',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid service name: ${serviceName}`,
          },
        });
        return;
      }

      const { error, value } = updateIntegrationSchema.validate(req.body, { abortEarly: false });
      if (error) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.details.map((d) => d.message),
          },
        });
        return;
      }

      const config = await integrationConfigRepo.upsert(
        req.user!.organizationId,
        serviceName,
        {
          enabled: value.enabled,
          serviceUrl: value.serviceUrl,
          config: value.config,
        }
      );

      emitToOrg(io, req.user!.organizationId, WS_EVENTS.INTEGRATION_CONFIGURED, {
        serviceName,
        enabled: config.enabled,
      });

      res.json({
        success: true,
        data: config,
      });
    })
  );

  // POST /:serviceName/test - Test integration connection
  router.post(
    '/:serviceName/test',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid service name: ${serviceName}`,
          },
        });
        return;
      }

      const config = await integrationConfigRepo.findByService(
        req.user!.organizationId,
        serviceName
      );

      const serviceUrl =
        config?.serviceUrl || (nexusConfig.services as any)[serviceName] || '';

      if (!serviceUrl) {
        res.json({
          success: true,
          data: {
            reachable: false,
            latencyMs: 0,
            error: 'No service URL configured',
          },
        });
        return;
      }

      const start = Date.now();
      try {
        const healthUrl = `${serviceUrl.replace(/\/$/, '')}/health`;
        await axios.get(healthUrl, { timeout: 10000, validateStatus: (s) => s < 500 });
        const latencyMs = Date.now() - start;

        // Update health status
        await integrationConfigRepo.updateHealthStatus(
          req.user!.organizationId,
          serviceName,
          'healthy',
          new Date()
        );

        res.json({
          success: true,
          data: { reachable: true, latencyMs },
        });
      } catch (err: any) {
        const latencyMs = Date.now() - start;

        await integrationConfigRepo.updateHealthStatus(
          req.user!.organizationId,
          serviceName,
          'unhealthy',
          new Date()
        );

        res.json({
          success: true,
          data: {
            reachable: false,
            latencyMs,
            error: err.message,
          },
        });
      }
    })
  );

  // GET /:serviceName/health - Get health status
  router.get(
    '/:serviceName/health',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid service name: ${serviceName}`,
          },
        });
        return;
      }

      const config = await integrationConfigRepo.findByService(
        req.user!.organizationId,
        serviceName
      );

      res.json({
        success: true,
        data: {
          serviceName,
          healthStatus: config?.healthStatus || 'unknown',
          lastHealthCheck: config?.lastHealthCheck || null,
          enabled: config?.enabled || false,
        },
      });
    })
  );

  return router;
}
