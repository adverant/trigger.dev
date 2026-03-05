import { Router, Request, Response } from 'express';
import Joi from 'joi';
import { TriggerProxyService } from '../services/trigger-proxy.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-environments' });

const createEnvVarSchema = Joi.object({
  name: Joi.string().required(),
  value: Joi.string().required(),
});

const updateEnvVarSchema = Joi.object({
  value: Joi.string().required(),
});

const importEnvVarsSchema = Joi.object({
  variables: Joi.array()
    .items(
      Joi.object({
        name: Joi.string().required(),
        value: Joi.string().required(),
      })
    )
    .min(1)
    .required(),
  override: Joi.boolean().optional().default(false),
});

export function createEnvironmentRouter(
  triggerProxy: TriggerProxyService
): Router {
  const router = Router();

  // GET / - List environment variables
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await triggerProxy.listEnvVars();
        res.json({ success: true, data: result });
      } catch (err) {
        // Trigger.dev proxy not configured — return empty list
        logger.warn('listEnvVars proxy failed, returning empty list', { error: (err as Error).message });
        res.json({ success: true, data: [] });
      }
    })
  );

  // POST / - Create env var
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = createEnvVarSchema.validate(req.body, { abortEarly: false });
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

      try {
        const result = await triggerProxy.createEnvVar(value.name, value.value);
        res.status(201).json({ success: true, data: result });
      } catch (err) {
        logger.warn('createEnvVar proxy failed', { error: (err as Error).message });
        res.status(503).json({ success: false, error: { code: 'PROXY_UNAVAILABLE', message: 'Trigger.dev proxy not configured' } });
      }
    })
  );

  // PUT /:name - Update env var
  router.put(
    '/:name',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = updateEnvVarSchema.validate(req.body, { abortEarly: false });
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

      try {
        const result = await triggerProxy.updateEnvVar(req.params.name, value.value);
        res.json({ success: true, data: result });
      } catch (err) {
        logger.warn('updateEnvVar proxy failed', { error: (err as Error).message });
        res.status(503).json({ success: false, error: { code: 'PROXY_UNAVAILABLE', message: 'Trigger.dev proxy not configured' } });
      }
    })
  );

  // DELETE /:name - Delete env var
  router.delete(
    '/:name',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await triggerProxy.deleteEnvVar(req.params.name);
        res.json({ success: true, data: result });
      } catch (err) {
        logger.warn('deleteEnvVar proxy failed', { error: (err as Error).message });
        res.status(503).json({ success: false, error: { code: 'PROXY_UNAVAILABLE', message: 'Trigger.dev proxy not configured' } });
      }
    })
  );

  // POST /import - Bulk import env vars
  router.post(
    '/import',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = importEnvVarsSchema.validate(req.body, { abortEarly: false });
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

      try {
        const result = await triggerProxy.importEnvVars(value.variables, value.override);
        res.json({ success: true, data: result });
      } catch (err) {
        logger.warn('importEnvVars proxy failed', { error: (err as Error).message });
        res.status(503).json({ success: false, error: { code: 'PROXY_UNAVAILABLE', message: 'Trigger.dev proxy not configured' } });
      }
    })
  );

  return router;
}
