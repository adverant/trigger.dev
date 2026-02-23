import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import axios from 'axios';
import {
  IntegrationConfigRepository,
  ServiceName,
  HealthStatus,
} from '../database/repositories/integration-config.repository';
import { TaskTemplateRepository, TaskTemplate } from '../database/repositories/task-template.repository';
import { NexusConfig } from '../config';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';
import type { ServiceClientRegistry } from '../services/client-registry';

const logger = createLogger({ component: 'api-integrations' });

/**
 * Transform backend IntegrationConfig to the format the UI expects.
 * Populates taskTemplates from the DB instead of hardcoded [].
 */
function toUIIntegration(
  config: any,
  templates: TaskTemplate[] = []
): Record<string, any> {
  const serviceName = config.serviceName || '';
  return {
    id: config.configId || serviceName,
    service: serviceName,
    displayName: serviceName
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c: string) => c.toUpperCase()),
    enabled: config.enabled || false,
    url: config.serviceUrl || '',
    health: config.healthStatus || 'unknown',
    lastCheckAt: config.lastHealthCheck
      ? (config.lastHealthCheck.toISOString?.() ?? String(config.lastHealthCheck))
      : null,
    taskTemplates: templates.map((t) => ({
      id: t.templateId,
      name: t.name,
      description: t.description,
      taskIdentifier: t.taskIdentifier,
      defaultPayload: t.defaultPayload,
    })),
    config: config.config || {},
  };
}

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
  url: Joi.string().uri().allow('').optional(),
  config: Joi.object().optional(),
}).min(1);

export function createIntegrationRouter(
  integrationConfigRepo: IntegrationConfigRepository,
  nexusConfig: NexusConfig,
  io: SocketIOServer,
  taskTemplateRepo?: TaskTemplateRepository,
  clientRegistry?: ServiceClientRegistry
): Router {
  const router = Router();

  // GET / - List all integration configs for org
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const configs = await integrationConfigRepo.findByOrgId(req.user!.organizationId);

      // Load all task templates grouped by service
      const templateMap = taskTemplateRepo
        ? await taskTemplateRepo.findAllGroupedByService()
        : new Map<string, TaskTemplate[]>();

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
        data: allConfigs.map((c) =>
          toUIIntegration(c, templateMap.get(c.serviceName) || [])
        ),
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

  // PUT /:serviceNameOrId - Update/enable integration config
  // Accepts either a serviceName (e.g. "graphrag") or a configId UUID
  router.put(
    '/:serviceNameOrId',
    asyncHandler(async (req: Request, res: Response) => {
      let serviceName = req.params.serviceNameOrId as ServiceName;

      // If param isn't a valid service name, try resolving as configId
      if (!VALID_SERVICES.includes(serviceName)) {
        const configs = await integrationConfigRepo.findByOrgId(req.user!.organizationId);
        const match = configs.find((c) => c.configId === req.params.serviceNameOrId);
        if (match) {
          serviceName = match.serviceName;
        } else {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid service name or integration ID: ${req.params.serviceNameOrId}`,
            },
          });
          return;
        }
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
          serviceUrl: value.serviceUrl || value.url,
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

  // POST /:serviceNameOrId/test - Test integration connection
  // Returns TestResult format: { success, message, latencyMs, details }
  // Accepts either serviceName or configId UUID
  router.post(
    '/:serviceNameOrId/test',
    asyncHandler(async (req: Request, res: Response) => {
      let serviceName = req.params.serviceNameOrId as ServiceName;

      // Resolve configId to serviceName if needed
      if (!VALID_SERVICES.includes(serviceName)) {
        const configs = await integrationConfigRepo.findByOrgId(req.user!.organizationId);
        const match = configs.find((c) => c.configId === req.params.serviceNameOrId);
        if (match) {
          serviceName = match.serviceName;
        } else {
          res.status(400).json({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid service name or integration ID: ${req.params.serviceNameOrId}`,
            },
          });
          return;
        }
      }

      const config = await integrationConfigRepo.findByService(
        req.user!.organizationId,
        serviceName
      );

      const serviceUrl =
        config?.serviceUrl || (nexusConfig.services as any)[serviceName] || '';

      // Service not configured or not deployed
      if (!serviceUrl) {
        res.json({
          success: true,
          data: {
            success: false,
            message: 'Service not deployed or URL not configured',
            latencyMs: 0,
            details: {
              endpoint: '',
              method: 'GET',
              responseStatus: 0,
              capabilities: [],
            },
          },
        });
        return;
      }

      // Try using the registered integration client first (uses service-specific health checks)
      const client = clientRegistry?.get(serviceName);
      if (client) {
        try {
          const result = await client.healthCheck();
          const healthStatus: HealthStatus = result.status === 'healthy' ? 'healthy' : result.status === 'degraded' ? 'degraded' : 'unhealthy';

          await integrationConfigRepo.updateHealthStatus(
            req.user!.organizationId,
            serviceName,
            healthStatus,
            new Date()
          );

          emitToOrg(io, req.user!.organizationId, WS_EVENTS.INTEGRATION_HEALTH_CHANGED, {
            serviceName,
            healthStatus,
          });

          res.json({
            success: true,
            data: {
              success: result.status === 'healthy' || result.status === 'degraded',
              message: result.status === 'healthy'
                ? `${serviceName} is healthy`
                : result.status === 'degraded'
                  ? `${serviceName} is degraded but reachable`
                  : `${serviceName} is unreachable`,
              latencyMs: result.latency,
              details: {
                endpoint: `${serviceUrl}/health`,
                method: 'GET',
                responseStatus: result.status === 'unhealthy' ? 503 : 200,
                capabilities: config?.config?.capabilities || [],
              },
            },
          });
          return;
        } catch (err: any) {
          logger.warn(`Client healthCheck failed for ${serviceName}, falling back to raw HTTP`, { error: err.message });
        }
      }

      // Fallback: raw HTTP health check
      const start = Date.now();
      try {
        const healthUrl = `${serviceUrl.replace(/\/$/, '')}/health`;
        const response = await axios.get(healthUrl, { timeout: 10000, validateStatus: (s) => s < 500 });
        const latencyMs = Date.now() - start;

        const isHealthy = response.status >= 200 && response.status < 300;
        const healthStatus: HealthStatus = isHealthy ? 'healthy' : 'degraded';

        await integrationConfigRepo.updateHealthStatus(
          req.user!.organizationId,
          serviceName,
          healthStatus,
          new Date()
        );

        emitToOrg(io, req.user!.organizationId, WS_EVENTS.INTEGRATION_HEALTH_CHANGED, {
          serviceName,
          healthStatus,
        });

        res.json({
          success: true,
          data: {
            success: isHealthy,
            message: isHealthy ? `${serviceName} is healthy` : `${serviceName} returned status ${response.status}`,
            latencyMs,
            details: {
              endpoint: healthUrl,
              method: 'GET',
              responseStatus: response.status,
              capabilities: config?.config?.capabilities || [],
            },
          },
        });
      } catch (err: any) {
        const latencyMs = Date.now() - start;

        await integrationConfigRepo.updateHealthStatus(
          req.user!.organizationId,
          serviceName,
          'unhealthy',
          new Date()
        );

        emitToOrg(io, req.user!.organizationId, WS_EVENTS.INTEGRATION_HEALTH_CHANGED, {
          serviceName,
          healthStatus: 'unhealthy',
        });

        res.json({
          success: true,
          data: {
            success: false,
            message: `${serviceName} is unreachable: ${err.message}`,
            latencyMs,
            details: {
              endpoint: `${serviceUrl}/health`,
              method: 'GET',
              responseStatus: err.response?.status || 0,
              capabilities: [],
            },
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

  // =========================================================================
  // Task Template endpoints
  // =========================================================================

  // GET /:serviceName/templates - List templates for a service
  router.get(
    '/:serviceName/templates',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Invalid service name: ${serviceName}` },
        });
        return;
      }

      if (!taskTemplateRepo) {
        res.json({ success: true, data: [] });
        return;
      }

      const templates = await taskTemplateRepo.findByService(serviceName);
      res.json({ success: true, data: templates });
    })
  );

  // POST /:serviceName/templates - Create a custom template
  router.post(
    '/:serviceName/templates',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Invalid service name: ${serviceName}` },
        });
        return;
      }

      if (!taskTemplateRepo) {
        res.status(501).json({
          success: false,
          error: { code: 'NOT_IMPLEMENTED', message: 'Task templates not available' },
        });
        return;
      }

      const { name, description, taskIdentifier, defaultPayload, schema } = req.body;
      if (!name || !taskIdentifier) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'name and taskIdentifier are required' },
        });
        return;
      }

      const template = await taskTemplateRepo.create({
        serviceName,
        name,
        description,
        taskIdentifier,
        defaultPayload,
        schema,
      });

      logger.info('Task template created', { templateId: template.templateId, serviceName });

      res.status(201).json({ success: true, data: template });
    })
  );

  // DELETE /:serviceName/templates/:templateId - Delete a template
  router.delete(
    '/:serviceName/templates/:templateId',
    asyncHandler(async (req: Request, res: Response) => {
      const serviceName = req.params.serviceName as ServiceName;
      if (!VALID_SERVICES.includes(serviceName)) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Invalid service name: ${serviceName}` },
        });
        return;
      }

      if (!taskTemplateRepo) {
        res.status(501).json({
          success: false,
          error: { code: 'NOT_IMPLEMENTED', message: 'Task templates not available' },
        });
        return;
      }

      const deleted = await taskTemplateRepo.delete(req.params.templateId);
      if (!deleted) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
        return;
      }

      logger.info('Task template deleted', { templateId: req.params.templateId, serviceName });

      res.json({ success: true });
    })
  );

  return router;
}
