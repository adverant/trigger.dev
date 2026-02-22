import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { WaitpointService } from '../services/waitpoint.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-waitpoints' });

const completeWaitpointSchema = Joi.object({
  output: Joi.object().required(),
  completedBy: Joi.string().optional(),
});

export function createWaitpointRouter(
  waitpointService: WaitpointService,
  io: SocketIOServer
): Router {
  const router = Router();

  // GET / - List pending waitpoints
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const waitpoints = await waitpointService.listPending(req.user!.organizationId);

      res.json({
        success: true,
        data: waitpoints,
      });
    })
  );

  // GET /:waitpointId - Get waitpoint details
  router.get(
    '/:waitpointId',
    asyncHandler(async (req: Request, res: Response) => {
      const waitpoint = await waitpointService.getWaitpoint(
        req.user!.organizationId,
        req.params.waitpointId
      );

      res.json({
        success: true,
        data: waitpoint,
      });
    })
  );

  // POST /:tokenId/complete - Complete (approve/reject) waitpoint
  router.post(
    '/:tokenId/complete',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = completeWaitpointSchema.validate(req.body, { abortEarly: false });
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

      const completedBy = value.completedBy || req.user!.userId;

      const waitpoint = await waitpointService.completeWaitpoint(
        req.user!.organizationId,
        req.params.tokenId,
        value.output,
        completedBy
      );

      res.json({
        success: true,
        data: waitpoint,
      });
    })
  );

  // POST /:tokenId/cancel - Cancel waitpoint
  router.post(
    '/:tokenId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      await waitpointService.cancelWaitpoint(
        req.user!.organizationId,
        req.params.tokenId
      );

      res.json({
        success: true,
        data: { cancelled: true },
      });
    })
  );

  return router;
}
