import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Pool } from 'pg';
import { UserEventEmailService, WebhookEventPayload } from '../services/user-event-email.service';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'auth-events-webhook' });

export function createAuthEventsRouter(pool: Pool): Router {
  const router = Router();
  const emailService = new UserEventEmailService(pool);

  router.post('/auth-events', async (req: Request, res: Response) => {
    // Verify HMAC signature
    const secret = process.env.AUTH_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers['x-nexus-signature-256'] as string;
      if (!signature) {
        logger.warn('Missing webhook signature');
        return res.status(401).json({ error: 'Missing signature' });
      }

      // Use raw body buffer for HMAC — JSON.stringify(req.body) may produce different JSON than Go's json.Marshal
      const rawBody = (req as any).rawBody;
      if (!rawBody) {
        logger.warn('Missing raw body for HMAC verification');
        return res.status(500).json({ error: 'Server misconfiguration: raw body not captured' });
      }
      const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      try {
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
          logger.warn('Invalid webhook signature');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      } catch {
        // timingSafeEqual throws if buffers are different lengths
        logger.warn('Signature verification error (length mismatch)');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body as WebhookEventPayload;

    if (!event.event_type || !event.user?.email) {
      return res.status(400).json({ error: 'Invalid event payload: missing event_type or user.email' });
    }

    // Return 200 immediately, process async
    res.json({ ok: true, event_type: event.event_type });

    // Process in background
    emailService.processEvent(event).catch((err) => {
      logger.error('Failed to process auth event', {
        error: (err as Error).message,
        eventType: event.event_type,
        email: event.user?.email,
      });
    });
  });

  return router;
}
