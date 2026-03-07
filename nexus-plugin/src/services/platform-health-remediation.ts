/**
 * Platform Health Remediation — AI analysis handler (Task 2).
 *
 * Triggered ONLY when Task 1 detects issues exceeding baseline thresholds.
 * Uses Gemini 2.5 Pro to perform root-cause analysis and generates:
 *   1. Human-readable markdown remediation report
 *   2. Machine-readable XML file for Claude Code auto-repair
 *
 * Stores results to: PostgreSQL, NFS filesystem, GraphRAG, and email.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import axios from 'axios';
import { GeminiClient } from '../integrations/gemini.client';
import type { PlatformHealthReport, RemediationReport, HealthCheck } from '../types/health-monitor';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NFS_REPORT_DIR = process.env.HEALTH_REPORT_DIR || '/mnt/nfs/health-reports';
const NOTIFICATION_EMAIL = process.env.HEALTH_NOTIFICATION_EMAIL || 'dsdon10@gmail.com';
const GRAPHRAG_URL = process.env.GRAPHRAG_URL || 'http://nexus-graphrag:9003';

// ---------------------------------------------------------------------------
// PlatformHealthRemediation
// ---------------------------------------------------------------------------

export class PlatformHealthRemediation {
  private gemini: GeminiClient;
  private db: Pool;

  constructor(db: Pool) {
    this.gemini = new GeminiClient();
    this.db = db;
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  async analyzeAndRemediate(healthReport: PlatformHealthReport): Promise<RemediationReport> {
    const startTime = Date.now();
    const reportId = randomUUID();

    // Filter to only unhealthy/degraded issues
    const issues = healthReport.checks.filter(
      (c) => c.status === 'unhealthy' || c.status === 'degraded',
    );

    if (issues.length === 0) {
      return this.emptyReport(reportId, healthReport.reportId, startTime);
    }

    // Load previous remediation reports for context (prevents repeated suggestions)
    const previousReports = await this.loadRecentRemediations(3);

    // Build the Gemini prompt
    const systemInstruction = this.buildSystemInstruction();
    const prompt = this.buildPrompt(healthReport, issues, previousReports);

    // Call AI (Gemini primary, Claude proxy fallback)
    const aiResponse = await this.gemini.generateContentWithFallback(prompt, systemInstruction);

    // Parse the AI response into markdown and XML
    const markdownReport = this.extractMarkdown(aiResponse.text, healthReport, issues);
    const xmlRemediation = this.extractXml(aiResponse.text, healthReport, issues, reportId);

    const report: RemediationReport = {
      reportId,
      healthReportId: healthReport.reportId,
      timestamp: new Date().toISOString(),
      markdownReport,
      xmlRemediation,
      issueCount: issues.length,
      modelUsed: aiResponse.modelUsed,
      promptTokens: aiResponse.promptTokens,
      completionTokens: aiResponse.completionTokens,
      durationMs: Date.now() - startTime,
    };

    // Store to all 4 destinations in parallel (non-blocking)
    const storageResults = await Promise.allSettled([
      this.storeToDatabase(report, healthReport.reportId),
      this.storeToNFS(report),
      this.storeToGraphRAG(report),
      this.sendEmailNotification(report, healthReport),
    ]);

    for (const result of storageResults) {
      if (result.status === 'rejected') {
        console.warn(`[remediation] Storage failed: ${result.reason}`);
      }
    }

    console.info(
      `[remediation] Complete: ${issues.length} issues analyzed, ` +
      `${aiResponse.promptTokens}+${aiResponse.completionTokens} tokens, ` +
      `${report.durationMs}ms`,
    );

    return report;
  }

  // -----------------------------------------------------------------------
  // Prompt construction
  // -----------------------------------------------------------------------

  private buildSystemInstruction(): string {
    return `You are a Kubernetes platform operations expert analyzing a Nexus platform health report.

Your task is to:
1. Identify the root cause of each unhealthy/degraded component
2. Assess the blast radius and impact of each issue
3. Provide specific, actionable remediation steps
4. Prioritize issues by severity and impact

IMPORTANT RULES:
- Be specific — cite exact pod names, service names, and error messages
- Provide exact kubectl/shell commands for remediation
- Identify affected Kubernetes manifest files when relevant
- Consider cascading failures (one issue causing others)
- If an issue has been reported before (see previous reports), note that it's recurring and suggest deeper investigation
- Group related issues together

OUTPUT FORMAT:
Your response MUST contain two clearly delimited sections:

1. Start with: <!-- MARKDOWN_REPORT_START -->
   Write a human-readable remediation report in markdown format.
   Include: executive summary, per-issue analysis with root cause and steps, priority matrix.
   End with: <!-- MARKDOWN_REPORT_END -->

2. Then: <!-- XML_REMEDIATION_START -->
   Write a structured XML remediation document following this schema:
   <remediation>
     <issues>
       <issue priority="N" category="..." severity="critical|high|medium|low">
         <description>What is wrong</description>
         <rootCause>Why it happened</rootCause>
         <impact>What is affected</impact>
         <affectedServices><service>name</service></affectedServices>
         <remediationSteps>
           <step type="command">exact command to run</step>
           <step type="code-change" file="path/to/file">description of change</step>
           <step type="verification">command to verify fix</step>
         </remediationSteps>
         <affectedFiles>
           <file path="relative/path" reason="why this file needs changes"/>
         </affectedFiles>
       </issue>
     </issues>
     <summary>
       <totalIssues>N</totalIssues>
       <critical>N</critical>
       <high>N</high>
       <medium>N</medium>
       <low>N</low>
     </summary>
   </remediation>
   End with: <!-- XML_REMEDIATION_END -->`;
  }

  private buildPrompt(
    report: PlatformHealthReport,
    issues: HealthCheck[],
    previousReports: string[],
  ): string {
    const lines: string[] = [];

    lines.push('# Platform Health Report Analysis Request');
    lines.push('');
    lines.push(`**Report Time**: ${report.timestamp}`);
    lines.push(`**Overall Status**: ${report.overallStatus}`);
    lines.push(`**Total Checks**: ${report.summary.total}`);
    lines.push(`**Healthy**: ${report.summary.healthy} | **Degraded**: ${report.summary.degraded} | **Unhealthy**: ${report.summary.unhealthy} | **Skipped**: ${report.summary.skipped}`);
    lines.push(`**Duration**: ${report.durationMs}ms`);
    lines.push('');

    lines.push('## Issues Requiring Analysis');
    lines.push('');
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i];
      lines.push(`### Issue ${i + 1}: ${issue.component}`);
      lines.push(`- **Category**: ${issue.category}`);
      lines.push(`- **Status**: ${issue.status}`);
      lines.push(`- **Message**: ${issue.message}`);
      lines.push(`- **Latency**: ${issue.latencyMs}ms`);
      if (issue.details) {
        lines.push(`- **Details**: ${JSON.stringify(issue.details)}`);
      }
      if (issue.threshold) {
        lines.push(`- **Threshold Deviation**: metric=${issue.threshold.metric}, actual=${issue.threshold.actual}, baseline=${issue.threshold.baseline}, deviation=${issue.threshold.deviation}%`);
      }
      lines.push('');
    }

    // Baseline deviations
    if (report.baselineComparison && report.baselineComparison.deviations.length > 0) {
      lines.push('## Baseline Deviations');
      lines.push('');
      for (const dev of report.baselineComparison.deviations) {
        lines.push(`- **${dev.component}** ${dev.metric}: baseline=${dev.baselineValue}, current=${dev.currentValue}, deviation=${dev.deviationPercent}%`);
      }
      lines.push('');
    }

    // Previous reports for recurring issue detection
    if (previousReports.length > 0) {
      lines.push('## Previous Remediation Reports (for recurring issue detection)');
      lines.push('');
      for (let i = 0; i < previousReports.length; i++) {
        lines.push(`### Previous Report ${i + 1}`);
        // Truncate to prevent token overflow
        const truncated = previousReports[i].substring(0, 2000);
        lines.push(truncated);
        if (previousReports[i].length > 2000) lines.push('... (truncated)');
        lines.push('');
      }
    }

    // All healthy checks (brief, for context)
    const healthyChecks = report.checks.filter((c) => c.status === 'healthy');
    if (healthyChecks.length > 0) {
      lines.push('## Healthy Components (for context)');
      lines.push('');
      for (const check of healthyChecks.slice(0, 20)) { // Cap at 20 to limit tokens
        lines.push(`- ${check.component}: ${check.message}`);
      }
      if (healthyChecks.length > 20) {
        lines.push(`  ... and ${healthyChecks.length - 20} more healthy components`);
      }
    }

    return lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // Response parsing
  // -----------------------------------------------------------------------

  private extractMarkdown(
    aiText: string,
    report: PlatformHealthReport,
    issues: HealthCheck[],
  ): string {
    // Try to extract from delimiters
    const mdMatch = aiText.match(
      /<!-- MARKDOWN_REPORT_START -->([\s\S]*?)<!-- MARKDOWN_REPORT_END -->/,
    );

    if (mdMatch) return mdMatch[1].trim();

    // If no delimiters, the entire response before XML is the markdown
    const xmlStart = aiText.indexOf('<!-- XML_REMEDIATION_START -->');
    if (xmlStart > 0) return aiText.substring(0, xmlStart).trim();

    // Fallback: generate a basic markdown report from the raw data
    return this.generateFallbackMarkdown(report, issues, aiText);
  }

  private extractXml(
    aiText: string,
    report: PlatformHealthReport,
    issues: HealthCheck[],
    reportId: string,
  ): string {
    // Try to extract from delimiters
    const xmlMatch = aiText.match(
      /<!-- XML_REMEDIATION_START -->([\s\S]*?)<!-- XML_REMEDIATION_END -->/,
    );

    if (xmlMatch) {
      const xml = xmlMatch[1].trim();
      // Ensure it starts with XML declaration
      if (xml.startsWith('<?xml') || xml.startsWith('<remediation')) {
        return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
      }
    }

    // Try to find <remediation> tag anywhere
    const remMatch = aiText.match(/<remediation[\s\S]*?<\/remediation>/);
    if (remMatch) {
      return `<?xml version="1.0" encoding="UTF-8"?>\n${remMatch[0]}`;
    }

    // Fallback: generate XML from raw data
    return this.generateFallbackXml(report, issues, reportId);
  }

  private generateFallbackMarkdown(
    report: PlatformHealthReport,
    issues: HealthCheck[],
    aiText: string,
  ): string {
    const lines: string[] = [];
    lines.push(`# Platform Health Remediation Report`);
    lines.push(`**Generated**: ${new Date().toISOString()}`);
    lines.push(`**Overall Status**: ${report.overallStatus}`);
    lines.push('');
    lines.push('## Issues Found');
    for (const issue of issues) {
      lines.push(`### ${issue.component}`);
      lines.push(`- **Status**: ${issue.status}`);
      lines.push(`- **Category**: ${issue.category}`);
      lines.push(`- **Message**: ${issue.message}`);
      lines.push('');
    }
    if (aiText && !aiText.startsWith('AI analysis failed')) {
      lines.push('## AI Analysis');
      lines.push(aiText);
    }
    return lines.join('\n');
  }

  private generateFallbackXml(
    report: PlatformHealthReport,
    issues: HealthCheck[],
    reportId: string,
  ): string {
    const issueXml = issues.map((issue, i) => {
      const severity = issue.status === 'unhealthy' ? 'critical' : 'high';
      return `    <issue priority="${i + 1}" category="${issue.category}" severity="${severity}">
      <description>${escapeXml(issue.message)}</description>
      <rootCause>Requires investigation</rootCause>
      <impact>${escapeXml(issue.component)} is ${issue.status}</impact>
      <affectedServices>
        <service>${escapeXml(issue.component.split(':')[1] || issue.component)}</service>
      </affectedServices>
      <remediationSteps>
        <step type="command">kubectl -n nexus describe ${issue.component.replace(':', ' ')}</step>
        <step type="command">kubectl -n nexus logs ${issue.component.split(':')[1] || ''} --tail=100</step>
      </remediationSteps>
    </issue>`;
    }).join('\n');

    const critical = issues.filter((i) => i.status === 'unhealthy').length;
    const high = issues.filter((i) => i.status === 'degraded').length;

    return `<?xml version="1.0" encoding="UTF-8"?>
<remediation timestamp="${new Date().toISOString()}" reportId="${reportId}" healthReportId="${report.reportId}">
  <issues>
${issueXml}
  </issues>
  <summary>
    <totalIssues>${issues.length}</totalIssues>
    <critical>${critical}</critical>
    <high>${high}</high>
    <medium>0</medium>
    <low>0</low>
  </summary>
</remediation>`;
  }

  // -----------------------------------------------------------------------
  // Storage destinations
  // -----------------------------------------------------------------------

  private async storeToDatabase(report: RemediationReport, healthReportId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO trigger.remediation_reports
       (report_id, health_report_id, timestamp, markdown_report, xml_remediation,
        issue_count, model_used, prompt_tokens, completion_tokens, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        report.reportId,
        report.healthReportId,
        report.timestamp,
        report.markdownReport,
        report.xmlRemediation,
        report.issueCount,
        report.modelUsed,
        report.promptTokens,
        report.completionTokens,
        report.durationMs,
      ],
    );

    // Update the health report to link to the remediation
    await this.db.query(
      `UPDATE trigger.health_reports SET triggered_remediation = true, remediation_report_id = $1
       WHERE report_id = $2`,
      [report.reportId, healthReportId],
    );
  }

  private async storeToNFS(report: RemediationReport): Promise<void> {
    const dateDir = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dir = path.join(NFS_REPORT_DIR, dateDir);

    try {
      await fs.promises.mkdir(dir, { recursive: true });

      await Promise.all([
        fs.promises.writeFile(
          path.join(dir, `report-${report.reportId}.md`),
          report.markdownReport,
          'utf-8',
        ),
        fs.promises.writeFile(
          path.join(dir, `remediation-${report.reportId}.xml`),
          report.xmlRemediation,
          'utf-8',
        ),
      ]);

      console.info(`[remediation] Saved to NFS: ${dir}/`);
    } catch (err) {
      console.warn(`[remediation] NFS write failed: ${(err as Error).message}`);
    }
  }

  private async storeToGraphRAG(report: RemediationReport): Promise<void> {
    try {
      await axios.post(
        `${GRAPHRAG_URL}/api/v1/documents`,
        {
          content: report.markdownReport,
          collection: 'health-remediation',
          metadata: {
            type: 'remediation-report',
            reportId: report.reportId,
            healthReportId: report.healthReportId,
            issueCount: report.issueCount,
            timestamp: report.timestamp,
            modelUsed: report.modelUsed,
          },
        },
        {
          timeout: 10_000,
          headers: { 'Content-Type': 'application/json' },
        },
      );
      console.info('[remediation] Indexed in GraphRAG');
    } catch (err) {
      console.warn(`[remediation] GraphRAG storage failed: ${(err as Error).message}`);
    }
  }

  private async sendEmailNotification(
    report: RemediationReport,
    healthReport: PlatformHealthReport,
  ): Promise<void> {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.info('[remediation] RESEND_API_KEY not configured — skipping email notification');
      return;
    }

    const statusLabel = healthReport.overallStatus === 'CRITICAL' ? '[CRITICAL]'
      : healthReport.overallStatus === 'DEGRADED' ? '[DEGRADED]' : '[INFO]';

    const subject = `${statusLabel} Nexus Platform Health: ${report.issueCount} issues detected`;

    const issueList = healthReport.checks
      .filter((c) => c.status === 'unhealthy' || c.status === 'degraded')
      .map((c) => `<li><strong>${c.component}</strong> (${c.status}): ${c.message}</li>`)
      .join('\n');

    const remediationPreview = report.markdownReport.substring(0, 3000).replace(/\n/g, '<br>');

    const html = `
      <h2>Nexus Platform Health Remediation Report</h2>
      <p><strong>Status:</strong> ${healthReport.overallStatus}</p>
      <p><strong>Time:</strong> ${healthReport.timestamp}</p>
      <p><strong>Issues:</strong> ${report.issueCount} | <strong>Checks:</strong> ${healthReport.summary.total}</p>
      <h3>Issues Detected</h3>
      <ul>${issueList}</ul>
      <h3>AI Remediation Summary</h3>
      <p>${remediationPreview}</p>
      <details><summary>XML Remediation Plan</summary><pre>${escapeXml(report.xmlRemediation)}</pre></details>
      <hr>
      <p><small>Report ID: ${report.reportId} | Model: ${report.modelUsed} | Duration: ${report.durationMs}ms</small></p>
    `;

    try {
      const res = await axios.post(
        'https://api.resend.com/emails',
        {
          from: 'Nexus Health <billing@adverant.ai>',
          to: [NOTIFICATION_EMAIL],
          subject,
          html,
          tags: [
            { name: 'type', value: 'health-remediation' },
            { name: 'reportId', value: report.reportId },
          ],
        },
        {
          timeout: 15_000,
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      console.info(`[remediation] Email sent via Resend to ${NOTIFICATION_EMAIL} (id: ${res.data?.id})`);
    } catch (err) {
      const status = (err as any)?.response?.status;
      const body = (err as any)?.response?.data;
      console.warn(`[remediation] Email send failed: ${(err as Error).message}`, { status, body });
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async loadRecentRemediations(count: number): Promise<string[]> {
    try {
      const res = await this.db.query(
        `SELECT markdown_report FROM trigger.remediation_reports
         ORDER BY timestamp DESC LIMIT $1`,
        [count],
      );
      return res.rows.map((r: any) => r.markdown_report);
    } catch {
      return [];
    }
  }

  private emptyReport(reportId: string, healthReportId: string, startTime: number): RemediationReport {
    return {
      reportId,
      healthReportId,
      timestamp: new Date().toISOString(),
      markdownReport: '# No Issues Found\n\nAll components are healthy.',
      xmlRemediation: '<?xml version="1.0" encoding="UTF-8"?>\n<remediation><issues/><summary><totalIssues>0</totalIssues></summary></remediation>',
      issueCount: 0,
      modelUsed: 'none',
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Date.now() - startTime,
    };
  }
}

// ---------------------------------------------------------------------------
// XML escaping helper
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
