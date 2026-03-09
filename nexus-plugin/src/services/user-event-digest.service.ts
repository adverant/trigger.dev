import axios from 'axios';
import { Pool } from 'pg';
import { renderDailyDigestEmail, DigestData } from './user-event-templates';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'user-event-digest' });

const RESEND_API_URL = 'https://api.resend.com/emails';
const NOTIFICATION_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.HEALTH_NOTIFICATION_EMAIL || 'don@adverant.ai';

export class UserEventDigestService {
  constructor(private pool: Pool) {}

  async runDailyDigest(): Promise<{ eventCount: number; emailSent: boolean }> {
    logger.info('Running daily user event digest');

    // Get all undigested events from last 24 hours
    const result = await this.pool.query(
      `SELECT * FROM trigger.user_event_log
       WHERE digest_included = FALSE
         AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at ASC`
    );

    const events = result.rows;

    if (events.length === 0) {
      logger.info('No events for daily digest');
      return { eventCount: 0, emailSent: false };
    }

    // Aggregate stats
    const newSignups = events
      .filter((e: any) => e.event_type === 'user.signup')
      .map((e: any) => ({
        email: e.user_email,
        name: e.user_name || 'N/A',
        tier: e.user_tier || 'basic',
        oauthProvider: e.oauth_provider,
        country: e.geo_country,
        createdAt: e.created_at,
      }));

    const loginEvents = events.filter((e: any) => e.event_type.startsWith('user.login'));
    const uniqueLoginEmails = new Set(loginEvents.map((e: any) => e.user_email));

    const subscriptionChanges = events
      .filter((e: any) => e.event_type.startsWith('subscription.'))
      .map((e: any) => {
        const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {});
        return {
          email: e.user_email,
          oldTier: meta.old_tier,
          newTier: meta.new_tier,
          eventType: e.event_type,
        };
      });

    const apiKeyEvents = events.filter((e: any) => e.event_type.startsWith('apikey.')).length;
    const suspiciousLogins = events.filter((e: any) => e.event_type === 'user.login.suspicious').length;

    // Country breakdown
    const countryCounts: Record<string, number> = {};
    for (const e of events) {
      const country = e.geo_country || 'Unknown';
      countryCounts[country] = (countryCounts[country] || 0) + 1;
    }
    const countryBreakdown = Object.entries(countryCounts)
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count);

    const today = new Date().toISOString().split('T')[0];

    const digestData: DigestData = {
      date: today,
      newSignups,
      totalLogins: loginEvents.length,
      uniqueUsers: uniqueLoginEmails.size,
      subscriptionChanges,
      apiKeyEvents,
      suspiciousLogins,
      countryBreakdown,
    };

    // Send digest email
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      logger.warn('RESEND_API_KEY not configured -- skipping digest email');
      return { eventCount: events.length, emailSent: false };
    }

    const rendered = renderDailyDigestEmail(digestData);

    try {
      await axios.post(
        RESEND_API_URL,
        {
          from: 'Nexus Platform <billing@adverant.ai>',
          to: [NOTIFICATION_EMAIL],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tags: [
            { name: 'type', value: 'daily-digest' },
            { name: 'date', value: today },
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

      logger.info('Daily digest email sent', { eventCount: events.length, to: NOTIFICATION_EMAIL });
    } catch (err) {
      logger.error('Failed to send digest email', { error: (err as Error).message });
      return { eventCount: events.length, emailSent: false };
    }

    // Mark events as included in digest
    const eventIds = events.map((e: any) => e.event_id);
    if (eventIds.length > 0) {
      await this.pool.query(
        `UPDATE trigger.user_event_log SET digest_included = TRUE WHERE event_id = ANY($1)`,
        [eventIds]
      );
    }

    return { eventCount: events.length, emailSent: true };
  }
}
