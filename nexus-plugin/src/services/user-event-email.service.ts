import axios from 'axios';
import { Pool } from 'pg';
import { lookupGeo, GeoData } from './geo-lookup.service';
import {
  EventEmailData,
  renderNewSignupEmail,
  renderLoginEmail,
  renderSuspiciousLoginEmail,
  renderSubscriptionChangeEmail,
  renderApiKeyEmail,
} from './user-event-templates';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'user-event-email' });

const RESEND_API_URL = 'https://api.resend.com/emails';
const NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.HEALTH_NOTIFICATION_EMAIL || 'don@adverant.ai';

// Events that should send an immediate email (not just digest)
const IMMEDIATE_EVENTS = new Set([
  'user.signup',
  'subscription.create',
  'subscription.upgrade',
  'subscription.downgrade',
  'subscription.cancel',
]);

export interface WebhookEventPayload {
  event_type: string;
  timestamp: string;
  user: {
    id: string;
    email: string;
    name: string;
    organization?: string;
    tier: string;
    oauth_provider?: string;
    created_at: string;
    is_new_user: boolean;
  };
  session: {
    ip: string;
    user_agent: string;
  };
  context?: Record<string, string>;
}

// Lazy-load ua-parser-js to avoid startup cost if not needed
let UAParser: any = null;
function parseUA(ua: string): { browser: string; os: string; type: string } {
  try {
    if (!UAParser) {
      UAParser = require('ua-parser-js');
    }
    const parser = new UAParser(ua);
    const result = parser.getResult();
    return {
      browser: [result.browser?.name, result.browser?.version].filter(Boolean).join(' ') || 'Unknown',
      os: [result.os?.name, result.os?.version].filter(Boolean).join(' ') || 'Unknown',
      type: result.device?.type || 'desktop',
    };
  } catch {
    return { browser: 'Unknown', os: 'Unknown', type: 'unknown' };
  }
}

export class UserEventEmailService {
  constructor(private pool: Pool) {}

  async processEvent(event: WebhookEventPayload): Promise<void> {
    const startMs = Date.now();
    logger.info('Processing user event', { eventType: event.event_type, email: event.user.email });

    // Enrich: geo-lookup + UA parsing
    const geo = await lookupGeo(event.session.ip);
    const device = parseUA(event.session.user_agent);

    // Check if this is a suspicious login (new country/browser for this user)
    let isSuspicious = false;
    if (event.event_type === 'user.login' && !event.user.is_new_user) {
      isSuspicious = await this.checkSuspiciousLogin(event.user.id, geo, device);
    }

    // Build the enriched data object
    const emailData: EventEmailData = {
      eventType: isSuspicious ? 'user.login.suspicious' : event.event_type,
      user: {
        id: event.user.id,
        email: event.user.email,
        name: event.user.name,
        organization: event.user.organization,
        tier: event.user.tier,
        oauthProvider: event.user.oauth_provider,
        createdAt: event.user.created_at,
        isNewUser: event.user.is_new_user,
      },
      geo,
      device,
      session: {
        ip: event.session.ip,
        userAgent: event.session.user_agent,
      },
      context: event.context,
      oldTier: event.context?.old_tier,
      newTier: event.context?.new_tier,
      keyName: event.context?.key_name,
    };

    // Store in event log (always, for digest)
    await this.storeEvent(emailData, geo, device);

    // Determine if we should send an immediate email
    const shouldSendNow = IMMEDIATE_EVENTS.has(event.event_type) || isSuspicious;

    if (shouldSendNow) {
      await this.sendEmail(emailData);
    }

    logger.info('User event processed', {
      eventType: event.event_type,
      email: event.user.email,
      emailSent: shouldSendNow,
      suspicious: isSuspicious,
      durationMs: Date.now() - startMs,
    });
  }

  private async checkSuspiciousLogin(
    userId: string,
    currentGeo: GeoData,
    currentDevice: { browser: string; os: string; type: string }
  ): Promise<boolean> {
    if (!userId || currentGeo.country === 'Unknown' || currentGeo.country === 'Internal') {
      return false;
    }

    try {
      const result = await this.pool.query(
        `SELECT DISTINCT geo_country, device_browser
         FROM trigger.user_event_log
         WHERE user_id = $1
           AND event_type IN ('user.login', 'user.signup')
           AND created_at > NOW() - INTERVAL '30 days'
         ORDER BY geo_country
         LIMIT 20`,
        [userId]
      );

      if (result.rows.length === 0) {
        // First login recorded -- not suspicious, just new
        return false;
      }

      const knownCountries = new Set(result.rows.map((r: any) => r.geo_country).filter(Boolean));
      const knownBrowsers = new Set(result.rows.map((r: any) => r.device_browser).filter(Boolean));

      // Extract browser family (e.g., "Chrome 120" -> "Chrome")
      const currentBrowserFamily = currentDevice.browser.split(' ')[0];
      const knownBrowserFamilies = new Set(
        Array.from(knownBrowsers).map((b: string) => b.split(' ')[0])
      );

      const newCountry = !knownCountries.has(currentGeo.country);
      const newBrowser = currentBrowserFamily && !knownBrowserFamilies.has(currentBrowserFamily);

      return newCountry || newBrowser;
    } catch (err) {
      logger.warn('Suspicious login check failed', { error: (err as Error).message });
      return false;
    }
  }

  private async storeEvent(
    data: EventEmailData,
    geo: GeoData,
    device: { browser: string; os: string; type: string }
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO trigger.user_event_log
          (event_type, user_email, user_name, user_id, user_tier, oauth_provider, is_new_user,
           ip_address, user_agent, geo_country, geo_city, geo_timezone, geo_isp,
           device_browser, device_os, device_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          data.eventType,
          data.user.email,
          data.user.name,
          data.user.id,
          data.user.tier,
          data.user.oauthProvider || null,
          data.user.isNewUser,
          data.session.ip,
          data.session.userAgent,
          geo.country,
          geo.city,
          geo.timezone,
          geo.isp,
          device.browser,
          device.os,
          device.type,
          JSON.stringify(data.context || {}),
        ]
      );
    } catch (err) {
      logger.error('Failed to store user event', { error: (err as Error).message });
    }
  }

  private async sendEmail(data: EventEmailData): Promise<void> {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      logger.warn('RESEND_API_KEY not configured -- skipping email');
      return;
    }

    let rendered: { subject: string; html: string; text: string };

    switch (data.eventType) {
      case 'user.signup':
        rendered = renderNewSignupEmail(data);
        break;
      case 'user.login':
        rendered = renderLoginEmail(data);
        break;
      case 'user.login.suspicious':
        rendered = renderSuspiciousLoginEmail(data);
        break;
      case 'subscription.create':
      case 'subscription.upgrade':
      case 'subscription.downgrade':
      case 'subscription.cancel':
        rendered = renderSubscriptionChangeEmail(data);
        break;
      case 'apikey.create':
      case 'apikey.revoke':
      case 'apikey.rotate':
        rendered = renderApiKeyEmail(data);
        break;
      default:
        rendered = renderLoginEmail(data); // fallback
    }

    try {
      await axios.post(
        RESEND_API_URL,
        {
          from: 'Nexus Platform <alerts@adverant.ai>',
          to: [NOTIFICATION_EMAIL],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tags: [
            { name: 'type', value: 'user-event' },
            { name: 'event', value: data.eventType },
          ],
        },
        {
          timeout: 15_000,
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      logger.info('Event email sent', { eventType: data.eventType, to: NOTIFICATION_EMAIL });

      // Mark email as sent in the log
      try {
        await this.pool.query(
          `UPDATE trigger.user_event_log
           SET email_sent = TRUE
           WHERE event_id = (
             SELECT event_id FROM trigger.user_event_log
             WHERE user_email = $1 AND event_type = $2
               AND created_at > NOW() - INTERVAL '1 minute'
             ORDER BY created_at DESC LIMIT 1
           )`,
          [data.user.email, data.eventType]
        );
      } catch { /* non-critical */ }
    } catch (err) {
      logger.error('Failed to send event email', { error: (err as Error).message, eventType: data.eventType });
    }
  }
}
