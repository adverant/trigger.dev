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

  // GET / - List waitpoints (with optional status filter)
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const status = req.query.status as string | undefined;
      const waitpoints = await waitpointService.listAll(
        req.user!.organizationId,
        status || undefined
      );

      // Map to frontend-compatible shape (id instead of waitpointId)
      const mapped = waitpoints.map((wp) => ({
        id: wp.waitpointId,
        type: 'token',
        status: wp.status,
        idempotencyKey: wp.tokenId,
        description: wp.description,
        input: wp.input,
        output: wp.output,
        expiresAt: wp.expiresAt?.toISOString() || null,
        resolvedAt: wp.completedAt?.toISOString() || null,
        createdAt: wp.createdAt.toISOString(),
        runId: wp.runId,
        taskSlug: wp.taskIdentifier,
      }));

      res.json({
        success: true,
        data: mapped,
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

  // POST /:waitpointId/resolve - Resolve (approve/reject) waitpoint
  // This is what the dashboard frontend calls.
  // approved=true → complete the waitpoint, approved=false → cancel/expire it
  router.post(
    '/:waitpointId/resolve',
    asyncHandler(async (req: Request, res: Response) => {
      const { approved, output } = req.body;
      const waitpointId = req.params.waitpointId;
      const orgId = req.user!.organizationId;

      // Look up by waitpointId (UUID) to get the tokenId needed by service methods
      const existing = await waitpointService.getWaitpoint(orgId, waitpointId);

      if (approved) {
        const waitpoint = await waitpointService.completeWaitpoint(
          orgId,
          existing.tokenId,
          output || { approved: true },
          req.user!.userId
        );
        res.json({ success: true, data: waitpoint });
      } else {
        await waitpointService.cancelWaitpoint(orgId, existing.tokenId);
        res.json({ success: true, data: { cancelled: true } });
      }
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
