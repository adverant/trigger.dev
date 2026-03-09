import type { GeoData } from './geo-lookup.service';

export interface EventEmailData {
  eventType: string;
  user: {
    id: string;
    email: string;
    name: string;
    organization?: string;
    tier: string;
    oauthProvider?: string;
    createdAt: string;
    isNewUser: boolean;
  };
  geo: GeoData;
  device: {
    browser: string;
    os: string;
    type: string;
  };
  session: {
    ip: string;
    userAgent: string;
  };
  context?: Record<string, string>;
  // For subscription events
  oldTier?: string;
  newTier?: string;
  // For API key events
  keyName?: string;
}

export interface DigestData {
  date: string;
  newSignups: Array<{ email: string; name: string; tier: string; oauthProvider?: string; country?: string; createdAt: string }>;
  totalLogins: number;
  uniqueUsers: number;
  subscriptionChanges: Array<{ email: string; oldTier?: string; newTier?: string; eventType: string }>;
  apiKeyEvents: number;
  suspiciousLogins: number;
  countryBreakdown: Array<{ country: string; count: number }>;
}

function sharedStyles(): string {
  return `
    body { margin: 0; padding: 0; background: #f4f4f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { padding: 24px 32px; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 4px 0 0; font-size: 13px; opacity: 0.9; }
    .body { padding: 24px 32px; }
    .detail-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .detail-table td { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: top; }
    .detail-table td:first-child { color: #6b7280; font-weight: 500; width: 140px; white-space: nowrap; }
    .detail-table td:last-child { color: #111827; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
    .badge-green { background: #d1fae5; color: #065f46; }
    .badge-blue { background: #dbeafe; color: #1e40af; }
    .badge-red { background: #fee2e2; color: #991b1b; }
    .badge-gray { background: #f3f4f6; color: #374151; }
    .footer { padding: 16px 32px; background: #f9fafb; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #9ca3af; }
    .footer a { color: #6366f1; text-decoration: none; }
  `;
}

function footer(): string {
  return `
    <div class="footer">
      <p>Automated notification from <a href="https://adverant.ai">Adverant Nexus</a></p>
      <p>This email was sent to the platform admin. <a href="https://dashboard.adverant.ai">Open Dashboard</a></p>
    </div>
  `;
}

export function renderNewSignupEmail(data: EventEmailData): { subject: string; html: string; text: string } {
  const subject = `[New Signup] ${data.user.email} joined Nexus`;
  const providerBadge = data.user.oauthProvider
    ? `<span class="badge badge-blue">${data.user.oauthProvider}</span>`
    : '<span class="badge badge-gray">email</span>';

  const html = `<!DOCTYPE html><html><head><style>${sharedStyles()}</style></head><body>
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
        <h1>New User Signup</h1>
        <p>${new Date(data.user.createdAt || Date.now()).toUTCString()}</p>
      </div>
      <div class="body">
        <table class="detail-table">
          <tr><td>Name</td><td><strong>${esc(data.user.name || 'N/A')}</strong></td></tr>
          <tr><td>Email</td><td>${esc(data.user.email)}</td></tr>
          <tr><td>Auth Method</td><td>${providerBadge}</td></tr>
          <tr><td>Plan</td><td><span class="badge badge-green">${esc(data.user.tier)}</span></td></tr>
          ${data.user.organization ? `<tr><td>Organization</td><td>${esc(data.user.organization)}</td></tr>` : ''}
          <tr><td>Location</td><td>${esc(data.geo.city)}${data.geo.city && data.geo.country ? ', ' : ''}${esc(data.geo.country)} ${data.geo.countryCode ? `(${esc(data.geo.countryCode)})` : ''}</td></tr>
          <tr><td>Timezone</td><td>${esc(data.geo.timezone || 'Unknown')}</td></tr>
          <tr><td>ISP</td><td>${esc(data.geo.isp || 'Unknown')}</td></tr>
          <tr><td>Browser</td><td>${esc(data.device.browser || 'Unknown')}</td></tr>
          <tr><td>OS</td><td>${esc(data.device.os || 'Unknown')}</td></tr>
          <tr><td>Device</td><td>${esc(data.device.type || 'Desktop')}</td></tr>
          <tr><td>IP Address</td><td><code>${esc(data.session.ip)}</code></td></tr>
        </table>
      </div>
      ${footer()}
    </div>
  </body></html>`;

  const text = `New User Signup
Name: ${data.user.name || 'N/A'}
Email: ${data.user.email}
Auth: ${data.user.oauthProvider || 'email'}
Plan: ${data.user.tier}
Location: ${data.geo.city}, ${data.geo.country}
Browser: ${data.device.browser} / ${data.device.os}
IP: ${data.session.ip}`;

  return { subject, html, text };
}

export function renderLoginEmail(data: EventEmailData): { subject: string; html: string; text: string } {
  const subject = `[Login] ${data.user.email} signed in from ${data.geo.city || data.geo.country || 'Unknown'}`;

  const html = `<!DOCTYPE html><html><head><style>${sharedStyles()}</style></head><body>
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);">
        <h1>User Login</h1>
        <p>${new Date().toUTCString()}</p>
      </div>
      <div class="body">
        <table class="detail-table">
          <tr><td>User</td><td><strong>${esc(data.user.name || data.user.email)}</strong> (${esc(data.user.email)})</td></tr>
          <tr><td>Plan</td><td><span class="badge badge-green">${esc(data.user.tier)}</span></td></tr>
          <tr><td>Auth Method</td><td>${esc(data.user.oauthProvider || 'password')}</td></tr>
          <tr><td>Location</td><td>${esc(data.geo.city)}${data.geo.city && data.geo.country ? ', ' : ''}${esc(data.geo.country)}</td></tr>
          <tr><td>Browser</td><td>${esc(data.device.browser)} on ${esc(data.device.os)}</td></tr>
          <tr><td>IP Address</td><td><code>${esc(data.session.ip)}</code></td></tr>
        </table>
      </div>
      ${footer()}
    </div>
  </body></html>`;

  const text = `User Login: ${data.user.email} from ${data.geo.city}, ${data.geo.country} (${data.device.browser} on ${data.device.os})`;

  return { subject, html, text };
}

export function renderSuspiciousLoginEmail(data: EventEmailData): { subject: string; html: string; text: string } {
  const subject = `[ALERT] Suspicious login: ${data.user.email} from new location`;

  const html = `<!DOCTYPE html><html><head><style>${sharedStyles()}</style></head><body>
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">
        <h1>Suspicious Login Alert</h1>
        <p>New location or device detected</p>
      </div>
      <div class="body">
        <p style="color: #991b1b; font-weight: 500;">This login came from a location or device not previously seen for this user.</p>
        <table class="detail-table">
          <tr><td>User</td><td><strong>${esc(data.user.name || data.user.email)}</strong></td></tr>
          <tr><td>Email</td><td>${esc(data.user.email)}</td></tr>
          <tr><td>New Location</td><td><span class="badge badge-red">${esc(data.geo.city)}${data.geo.city && data.geo.country ? ', ' : ''}${esc(data.geo.country)}</span></td></tr>
          <tr><td>ISP</td><td>${esc(data.geo.isp || 'Unknown')}</td></tr>
          <tr><td>Browser</td><td>${esc(data.device.browser)} on ${esc(data.device.os)}</td></tr>
          <tr><td>IP Address</td><td><code>${esc(data.session.ip)}</code></td></tr>
          <tr><td>Time</td><td>${new Date().toUTCString()}</td></tr>
        </table>
      </div>
      ${footer()}
    </div>
  </body></html>`;

  const text = `SUSPICIOUS LOGIN ALERT
User: ${data.user.email}
Location: ${data.geo.city}, ${data.geo.country} (NEW)
Browser: ${data.device.browser} on ${data.device.os}
IP: ${data.session.ip}`;

  return { subject, html, text };
}

export function renderSubscriptionChangeEmail(data: EventEmailData): { subject: string; html: string; text: string } {
  const isCreate = data.eventType === 'subscription.create';
  const isUpgrade = data.eventType === 'subscription.upgrade';
  const isCancel = data.eventType === 'subscription.cancel';
  const action = isCreate ? 'Subscribed' : isCancel ? 'Cancelled' : isUpgrade ? 'Upgraded' : 'Downgraded';

  const subject = isCreate
    ? `[Subscription] ${data.user.email} subscribed: ${data.newTier || '?'}`
    : `[Subscription] ${data.user.email} ${action.toLowerCase()}: ${data.oldTier || '?'} -> ${data.newTier || '?'}`;

  const html = `<!DOCTYPE html><html><head><style>${sharedStyles()}</style></head><body>
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, ${isCancel ? '#6b7280 0%, #4b5563 100%' : (isUpgrade || isCreate) ? '#10b981 0%, #059669 100%' : '#f59e0b 0%, #d97706 100%'});">
        <h1>Subscription ${action}</h1>
        <p>${new Date().toUTCString()}</p>
      </div>
      <div class="body">
        <table class="detail-table">
          <tr><td>User</td><td><strong>${esc(data.user.name || data.user.email)}</strong></td></tr>
          <tr><td>Email</td><td>${esc(data.user.email)}</td></tr>
          <tr><td>Change</td><td>${esc(data.oldTier || 'N/A')} -> <strong>${esc(data.newTier || 'N/A')}</strong></td></tr>
          <tr><td>Location</td><td>${esc(data.geo.city)}${data.geo.city && data.geo.country ? ', ' : ''}${esc(data.geo.country)}</td></tr>
        </table>
      </div>
      ${footer()}
    </div>
  </body></html>`;

  const text = `Subscription ${action}: ${data.user.email} (${data.oldTier} -> ${data.newTier})`;

  return { subject, html, text };
}

export function renderApiKeyEmail(data: EventEmailData): { subject: string; html: string; text: string } {
  const action = data.eventType === 'apikey.create' ? 'Created' : data.eventType === 'apikey.rotate' ? 'Rotated' : 'Revoked';
  const subject = `[API Key ${action}] ${data.user.email} -- ${data.keyName || 'unnamed'}`;

  const html = `<!DOCTYPE html><html><head><style>${sharedStyles()}</style></head><body>
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%);">
        <h1>API Key ${action}</h1>
        <p>${new Date().toUTCString()}</p>
      </div>
      <div class="body">
        <table class="detail-table">
          <tr><td>User</td><td><strong>${esc(data.user.email)}</strong></td></tr>
          <tr><td>Key Name</td><td>${esc(data.keyName || 'N/A')}</td></tr>
          <tr><td>Action</td><td><span class="badge ${data.eventType === 'apikey.create' ? 'badge-green' : data.eventType === 'apikey.rotate' ? 'badge-blue' : 'badge-red'}">${action}</span></td></tr>
          <tr><td>Location</td><td>${esc(data.geo.city)}${data.geo.city && data.geo.country ? ', ' : ''}${esc(data.geo.country)}</td></tr>
          <tr><td>IP</td><td><code>${esc(data.session.ip)}</code></td></tr>
        </table>
      </div>
      ${footer()}
    </div>
  </body></html>`;

  const text = `API Key ${action}: ${data.user.email} -- ${data.keyName || 'unnamed'} from ${data.session.ip}`;

  return { subject, html, text };
}

export function renderDailyDigestEmail(data: DigestData): { subject: string; html: string; text: string } {
  const subject = `[Nexus Daily Digest] ${data.date}: ${data.newSignups.length} signups, ${data.uniqueUsers} active users`;

  const signupRows = data.newSignups.map(s =>
    `<tr>
      <td>${esc(s.name || 'N/A')}</td>
      <td>${esc(s.email)}</td>
      <td><span class="badge badge-blue">${esc(s.oauthProvider || 'email')}</span></td>
      <td>${esc(s.country || 'Unknown')}</td>
    </tr>`
  ).join('');

  const subChanges = data.subscriptionChanges.map(s =>
    `<tr>
      <td>${esc(s.email)}</td>
      <td>${esc(s.oldTier || '?')} -> ${esc(s.newTier || '?')}</td>
      <td>${esc(s.eventType)}</td>
    </tr>`
  ).join('');

  const countryRows = data.countryBreakdown.slice(0, 10).map(c =>
    `<tr><td>${esc(c.country)}</td><td>${c.count}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html><html><head><style>${sharedStyles()}
    .stats-grid { display: flex; gap: 16px; margin: 16px 0; flex-wrap: wrap; }
    .stat-card { flex: 1; min-width: 120px; background: #f9fafb; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-card .number { font-size: 28px; font-weight: 700; color: #111827; }
    .stat-card .label { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .section-title { font-size: 16px; font-weight: 600; color: #111827; margin: 24px 0 8px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .data-table th { text-align: left; padding: 8px; background: #f3f4f6; color: #374151; font-weight: 500; }
    .data-table td { padding: 8px; border-bottom: 1px solid #f3f4f6; }
  </style></head><body>
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%);">
        <h1>Daily Platform Digest</h1>
        <p>${esc(data.date)}</p>
      </div>
      <div class="body">
        <div class="stats-grid">
          <div class="stat-card"><div class="number">${data.newSignups.length}</div><div class="label">New Signups</div></div>
          <div class="stat-card"><div class="number">${data.uniqueUsers}</div><div class="label">Active Users</div></div>
          <div class="stat-card"><div class="number">${data.totalLogins}</div><div class="label">Total Logins</div></div>
          <div class="stat-card"><div class="number">${data.suspiciousLogins}</div><div class="label">Suspicious</div></div>
        </div>

        ${data.newSignups.length > 0 ? `
          <div class="section-title">New Signups</div>
          <table class="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Auth</th><th>Country</th></tr></thead>
            <tbody>${signupRows}</tbody>
          </table>
        ` : ''}

        ${data.subscriptionChanges.length > 0 ? `
          <div class="section-title">Subscription Changes</div>
          <table class="data-table">
            <thead><tr><th>Email</th><th>Change</th><th>Type</th></tr></thead>
            <tbody>${subChanges}</tbody>
          </table>
        ` : ''}

        ${data.countryBreakdown.length > 0 ? `
          <div class="section-title">Geographic Distribution</div>
          <table class="data-table">
            <thead><tr><th>Country</th><th>Events</th></tr></thead>
            <tbody>${countryRows}</tbody>
          </table>
        ` : ''}

        ${data.apiKeyEvents > 0 ? `<p style="color:#6b7280;font-size:13px;">API key events: ${data.apiKeyEvents}</p>` : ''}
      </div>
      ${footer()}
    </div>
  </body></html>`;

  const text = `Nexus Daily Digest -- ${data.date}
New Signups: ${data.newSignups.length}
Active Users: ${data.uniqueUsers}
Total Logins: ${data.totalLogins}
Suspicious Logins: ${data.suspiciousLogins}
${data.newSignups.map(s => `  - ${s.email} (${s.oauthProvider || 'email'}, ${s.country || 'Unknown'})`).join('\n')}`;

  return { subject, html, text };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
