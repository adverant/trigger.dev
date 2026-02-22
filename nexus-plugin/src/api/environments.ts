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
      const result = await triggerProxy.listEnvVars();

      res.json({
        success: true,
        data: result,
      });
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

      const result = await triggerProxy.createEnvVar(value.name, value.value);

      res.status(201).json({
        success: true,
        data: result,
      });
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

      const result = await triggerProxy.updateEnvVar(req.params.name, value.value);

      res.json({
        success: true,
        data: result,
      });
    })
  );

  // DELETE /:name - Delete env var
  router.delete(
    '/:name',
    asyncHandler(async (req: Request, res: Response) => {
      const result = await triggerProxy.deleteEnvVar(req.params.name);

      res.json({
        success: true,
        data: result,
      });
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

      const result = await triggerProxy.importEnvVars(value.variables, value.override);

      res.json({
        success: true,
        data: result,
      });
    })
  );

  return router;
}
