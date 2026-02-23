import { Router, Request, Response } from 'express';
import { DatabaseService } from '../database/database.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';
import { randomUUID, randomBytes } from 'crypto';

const logger = createLogger({ component: 'api-settings' });

/**
 * Settings router providing API keys, environments, and webhooks endpoints.
 * These are the endpoints called by the nexus-dashboard Settings page.
 */
export function createSettingsRouter(db: DatabaseService): Router {
  const router = Router();

  // =========================================================================
  // API Keys
  // =========================================================================

  // GET /api-keys - List API keys for the org
  router.get(
    '/api-keys',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;

      // Ensure settings table exists
      await ensureSettingsTables(db);

      const rows = await db.queryMany<any>(
        `SELECT key_id, name, masked_key, created_at
         FROM trigger.api_keys
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [orgId]
      );

      // If no keys exist, seed a default one
      if (rows.length === 0) {
        const keyId = randomUUID();
        const rawKey = `tr_${randomBytes(24).toString('hex')}`;
        const masked = `tr_${'*'.repeat(40)}${rawKey.slice(-6)}`;

        await db.query(
          `INSERT INTO trigger.api_keys (key_id, organization_id, name, key_hash, masked_key)
           VALUES ($1, $2, $3, $4, $5)`,
          [keyId, orgId, 'Default API Key', rawKey, masked]
        );

        res.json({
          success: true,
          data: [{
            id: keyId,
            name: 'Default API Key',
            maskedKey: masked,
            createdAt: new Date().toISOString(),
          }],
        });
        return;
      }

      res.json({
        success: true,
        data: rows.map((r: any) => ({
          id: r.key_id,
          name: r.name,
          maskedKey: r.masked_key,
          createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
        })),
      });
    })
  );

  // POST /api-keys/:keyId/regenerate - Regenerate an API key
  router.post(
    '/api-keys/:keyId/regenerate',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { keyId } = req.params;

      const rawKey = `tr_${randomBytes(24).toString('hex')}`;
      const masked = `tr_${'*'.repeat(40)}${rawKey.slice(-6)}`;

      const row = await db.queryOne<any>(
        `UPDATE trigger.api_keys
         SET key_hash = $1, masked_key = $2
         WHERE key_id = $3 AND organization_id = $4
         RETURNING *`,
        [rawKey, masked, keyId, orgId]
      );

      if (!row) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'API key not found' },
        });
        return;
      }

      logger.info('API key regenerated', { keyId, orgId });

      res.json({
        success: true,
        data: { key: rawKey },
      });
    })
  );

  // =========================================================================
  // Environments
  // =========================================================================

  // GET /environments - List environments
  router.get(
    '/environments',
    asyncHandler(async (req: Request, res: Response) => {
      // Return static environments based on the deployment mode
      res.json({
        success: true,
        data: [
          {
            id: 'env-production',
            name: 'Production',
            slug: 'production',
            apiUrl: process.env.TRIGGER_API_URL || 'http://trigger-dev-webapp:3030',
            current: true,
          },
          {
            id: 'env-dev',
            name: 'Development',
            slug: 'dev',
            apiUrl: process.env.TRIGGER_API_URL || 'http://trigger-dev-webapp:3030',
            current: false,
          },
        ],
      });
    })
  );

  // =========================================================================
  // Webhooks
  // =========================================================================

  // GET /webhooks - List webhooks for the org
  router.get(
    '/webhooks',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;

      await ensureSettingsTables(db);

      const rows = await db.queryMany<any>(
        `SELECT webhook_id, url, events, enabled, secret, created_at
         FROM trigger.webhooks
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [orgId]
      );

      res.json({
        success: true,
        data: rows.map((r: any) => ({
          id: r.webhook_id,
          url: r.url,
          events: r.events || [],
          enabled: r.enabled,
          secret: r.secret,
          createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
        })),
      });
    })
  );

  // POST /webhooks - Create a webhook
  router.post(
    '/webhooks',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { url, events } = req.body;

      if (!url || !events || !Array.isArray(events) || events.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'url and events[] are required' },
        });
        return;
      }

      await ensureSettingsTables(db);

      const webhookId = randomUUID();
      const secret = `whsec_${randomBytes(16).toString('hex')}`;

      await db.query(
        `INSERT INTO trigger.webhooks (webhook_id, organization_id, url, events, enabled, secret)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [webhookId, orgId, url, events, true, secret]
      );

      logger.info('Webhook created', { webhookId, orgId, url });

      res.status(201).json({
        success: true,
        data: {
          id: webhookId,
          url,
          events,
          enabled: true,
          secret,
          createdAt: new Date().toISOString(),
        },
      });
    })
  );

  // DELETE /webhooks/:webhookId - Delete a webhook
  router.delete(
    '/webhooks/:webhookId',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { webhookId } = req.params;

      await ensureSettingsTables(db);

      const result = await db.queryOne<any>(
        `DELETE FROM trigger.webhooks
         WHERE webhook_id = $1 AND organization_id = $2
         RETURNING webhook_id`,
        [webhookId, orgId]
      );

      if (!result) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        });
        return;
      }

      logger.info('Webhook deleted', { webhookId, orgId });

      res.json({
        success: true,
        data: { deleted: true },
      });
    })
  );

  return router;
}

// ============================================================================
// DB table auto-creation
// ============================================================================

let tablesEnsured = false;

async function ensureSettingsTables(db: DatabaseService): Promise<void> {
  if (tablesEnsured) return;

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS trigger.api_keys (
        key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default API Key',
        key_hash TEXT NOT NULL,
        masked_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trigger.webhooks (
        webhook_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT[] NOT NULL DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        secret TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    tablesEnsured = true;
  } catch (err: any) {
    logger.warn('Settings tables creation attempt', { error: err.message });
    tablesEnsured = true; // Don't retry on failure, tables may already exist
  }
}
