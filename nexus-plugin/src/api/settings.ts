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

  // POST /webhooks/:webhookId/test - Test a webhook
  router.post(
    '/webhooks/:webhookId/test',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { webhookId } = req.params;

      await ensureSettingsTables(db);

      const webhook = await db.queryOne<any>(
        `SELECT * FROM trigger.webhooks WHERE webhook_id = $1 AND organization_id = $2`,
        [webhookId, orgId]
      );

      if (!webhook) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Webhook not found' },
        });
        return;
      }

      // Send test payload to webhook URL
      const testPayload = {
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test webhook delivery from Nexus Workflows' },
      };

      const start = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': webhook.secret || '',
          },
          body: JSON.stringify(testPayload),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const latencyMs = Date.now() - start;

        logger.info('Webhook test sent', { webhookId, url: webhook.url, status: response.status, latencyMs });

        res.json({
          success: true,
          data: {
            statusCode: response.status,
            latencyMs,
            success: response.ok,
          },
        });
      } catch (err: any) {
        const latencyMs = Date.now() - start;
        logger.warn('Webhook test failed', { webhookId, url: webhook.url, error: err.message });

        res.json({
          success: true,
          data: {
            statusCode: 0,
            latencyMs,
            success: false,
            error: err.message,
          },
        });
      }
    })
  );

  // =========================================================================
  // Alert Rules
  // =========================================================================

  // GET /alert-rules - List alert rules
  router.get(
    '/alert-rules',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;

      await ensureAlertRulesTable(db);

      const rows = await db.queryMany<any>(
        `SELECT * FROM trigger.alert_rules WHERE organization_id = $1 ORDER BY created_at DESC`,
        [orgId]
      );

      res.json({
        success: true,
        data: rows.map((r: any) => ({
          alertRuleId: r.alert_rule_id,
          name: r.name,
          eventType: r.event_type,
          condition: r.condition || {},
          channel: r.channel,
          target: r.target,
          enabled: r.enabled,
          lastFiredAt: r.last_fired_at,
          fireCount: parseInt(r.fire_count || '0', 10),
          cooldownMinutes: parseInt(r.cooldown_minutes || '5', 10),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      });
    })
  );

  // POST /alert-rules - Create alert rule
  router.post(
    '/alert-rules',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { name, eventType, condition, channel, target, cooldownMinutes } = req.body;

      if (!name || !eventType || !channel || !target) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'name, eventType, channel, and target are required' },
        });
        return;
      }

      await ensureAlertRulesTable(db);

      const row = await db.queryOne<any>(
        `INSERT INTO trigger.alert_rules (organization_id, name, event_type, condition, channel, target, cooldown_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [orgId, name, eventType, JSON.stringify(condition || {}), channel, target, cooldownMinutes || 5]
      );

      logger.info('Alert rule created', { alertRuleId: row!.alert_rule_id, orgId });

      res.status(201).json({
        success: true,
        data: {
          alertRuleId: row!.alert_rule_id,
          name: row!.name,
          eventType: row!.event_type,
          condition: row!.condition || {},
          channel: row!.channel,
          target: row!.target,
          enabled: row!.enabled,
          cooldownMinutes: parseInt(row!.cooldown_minutes || '5', 10),
          createdAt: row!.created_at,
          updatedAt: row!.updated_at,
        },
      });
    })
  );

  // PUT /alert-rules/:ruleId - Update alert rule
  router.put(
    '/alert-rules/:ruleId',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { ruleId } = req.params;
      const data = req.body;

      await ensureAlertRulesTable(db);

      const setClauses: string[] = ['updated_at = NOW()'];
      const values: any[] = [];
      let paramIdx = 1;

      if (data.name !== undefined) { setClauses.push(`name = $${paramIdx++}`); values.push(data.name); }
      if (data.eventType !== undefined) { setClauses.push(`event_type = $${paramIdx++}`); values.push(data.eventType); }
      if (data.condition !== undefined) { setClauses.push(`condition = $${paramIdx++}`); values.push(JSON.stringify(data.condition)); }
      if (data.channel !== undefined) { setClauses.push(`channel = $${paramIdx++}`); values.push(data.channel); }
      if (data.target !== undefined) { setClauses.push(`target = $${paramIdx++}`); values.push(data.target); }
      if (data.enabled !== undefined) { setClauses.push(`enabled = $${paramIdx++}`); values.push(data.enabled); }
      if (data.cooldownMinutes !== undefined) { setClauses.push(`cooldown_minutes = $${paramIdx++}`); values.push(data.cooldownMinutes); }

      values.push(ruleId, orgId);

      const row = await db.queryOne<any>(
        `UPDATE trigger.alert_rules SET ${setClauses.join(', ')}
         WHERE alert_rule_id = $${paramIdx++} AND organization_id = $${paramIdx}
         RETURNING *`,
        values
      );

      if (!row) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert rule not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          alertRuleId: row.alert_rule_id,
          name: row.name,
          eventType: row.event_type,
          condition: row.condition || {},
          channel: row.channel,
          target: row.target,
          enabled: row.enabled,
          cooldownMinutes: parseInt(row.cooldown_minutes || '5', 10),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      });
    })
  );

  // DELETE /alert-rules/:ruleId - Delete alert rule
  router.delete(
    '/alert-rules/:ruleId',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { ruleId } = req.params;

      await ensureAlertRulesTable(db);

      const result = await db.queryOne<any>(
        `DELETE FROM trigger.alert_rules WHERE alert_rule_id = $1 AND organization_id = $2 RETURNING alert_rule_id`,
        [ruleId, orgId]
      );

      if (!result) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Alert rule not found' },
        });
        return;
      }

      logger.info('Alert rule deleted', { ruleId, orgId });

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

let alertTablesEnsured = false;

async function ensureAlertRulesTable(db: DatabaseService): Promise<void> {
  if (alertTablesEnsured) return;

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS trigger.alert_rules (
        alert_rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        condition JSONB NOT NULL DEFAULT '{}',
        channel TEXT NOT NULL CHECK (channel IN ('webhook', 'email')),
        target TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_fired_at TIMESTAMPTZ,
        fire_count INT NOT NULL DEFAULT 0,
        cooldown_minutes INT NOT NULL DEFAULT 5,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    alertTablesEnsured = true;
  } catch (err: any) {
    logger.warn('Alert rules table creation attempt', { error: err.message });
    alertTablesEnsured = true;
  }
}
