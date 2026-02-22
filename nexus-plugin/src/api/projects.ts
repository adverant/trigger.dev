import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { ProjectService } from '../services/project.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-projects' });

const createProjectSchema = Joi.object({
  triggerProjectRef: Joi.string().required(),
  triggerProjectName: Joi.string().optional(),
  environment: Joi.string().valid('dev', 'staging', 'production').required(),
  apiKeyEncrypted: Joi.string().optional(),
  personalAccessTokenEncrypted: Joi.string().optional(),
  triggerApiUrl: Joi.string().uri().optional(),
  mode: Joi.string().valid('self-hosted', 'external').required(),
});

const updateProjectSchema = Joi.object({
  triggerProjectName: Joi.string().optional(),
  environment: Joi.string().valid('dev', 'staging', 'production').optional(),
  apiKeyEncrypted: Joi.string().optional(),
  personalAccessTokenEncrypted: Joi.string().optional(),
  triggerApiUrl: Joi.string().uri().optional(),
  mode: Joi.string().valid('self-hosted', 'external').optional(),
}).min(1);

export function createProjectRouter(
  projectService: ProjectService,
  io: SocketIOServer
): Router {
  const router = Router();

  // POST / - Create project
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = createProjectSchema.validate(req.body, { abortEarly: false });
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

      const project = await projectService.createProject(
        req.user!.organizationId,
        req.user!.userId,
        value
      );

      res.status(201).json({
        success: true,
        data: project,
      });
    })
  );

  // GET / - List projects
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const projects = await projectService.listProjects(req.user!.organizationId);

      res.json({
        success: true,
        data: projects,
      });
    })
  );

  // GET /:projectId - Get project
  router.get(
    '/:projectId',
    asyncHandler(async (req: Request, res: Response) => {
      const project = await projectService.getProject(
        req.params.projectId,
        req.user!.organizationId
      );

      res.json({
        success: true,
        data: project,
      });
    })
  );

  // PUT /:projectId - Update project
  router.put(
    '/:projectId',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = updateProjectSchema.validate(req.body, { abortEarly: false });
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

      const project = await projectService.updateProject(
        req.params.projectId,
        req.user!.organizationId,
        value
      );

      res.json({
        success: true,
        data: project,
      });
    })
  );

  // DELETE /:projectId - Delete project
  router.delete(
    '/:projectId',
    asyncHandler(async (req: Request, res: Response) => {
      await projectService.deleteProject(
        req.params.projectId,
        req.user!.organizationId
      );

      res.json({
        success: true,
        data: { deleted: true },
      });
    })
  );

  // POST /:projectId/test-connection - Test Trigger.dev connection
  router.post(
    '/:projectId/test-connection',
    asyncHandler(async (req: Request, res: Response) => {
      const result = await projectService.testConnection(
        req.params.projectId,
        req.user!.organizationId
      );

      res.json({
        success: true,
        data: result,
      });
    })
  );

  return router;
}
