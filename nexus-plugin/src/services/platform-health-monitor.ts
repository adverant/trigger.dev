/**
 * Platform Health Monitor — core orchestrator (Task 1).
 *
 * Runs every 30 minutes with NO AI. Dynamically discovers all services,
 * pods, deployments, and plugins from the K8s API and plugin registry.
 * No hardcoded service lists — adapts automatically when services are
 * added, removed, or reconfigured.
 *
 * All checks run via Promise.allSettled() with individual timeouts.
 * A single failed check never crashes the full monitor.
 */

import { randomUUID } from 'crypto';
import * as tls from 'tls';
import * as dns from 'dns';
import axios from 'axios';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { KubernetesClient } from '../integrations/kubernetes.client';
import type {
  HealthCheck,
  HealthCategory,
  ComponentStatus,
  OverallStatus,
  PlatformHealthReport,
  BaselineComparison,
  HealthThresholds,
  K8sServiceInfo,
} from '../types/health-monitor';
import { DEFAULT_THRESHOLDS } from '../types/health-monitor';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESEND_API_URL = 'https://api.resend.com/emails';
const NOTIFICATION_EMAIL = process.env.HEALTH_NOTIFICATION_EMAIL || 'dsdon10@gmail.com';
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const NAMESPACE = process.env.K8S_NAMESPACE || 'nexus';
// Monitor only the nexus namespace — default namespace contains stale/orphaned resources
const MONITOR_NAMESPACES = (process.env.MONITOR_NAMESPACES || NAMESPACE).split(',').map(s => s.trim());

/** Common health endpoint paths to probe on discovered services. */
const HEALTH_PATHS = ['/health', '/api/health', '/healthz', '/trigger/health', '/ready', '/'];

/** Services known to NOT have health endpoints (skip probing). */
const SKIP_HEALTH_PROBE = new Set(['kubernetes', 'kube-dns']);

/** Well-known port-to-health-path overrides (based on known conventions). */
const PORT_HEALTH_OVERRIDES: Record<string, string> = {
  'nexus-email-connector': '/api/health',
  'nexus-trigger': '/trigger/health',
};

// ---------------------------------------------------------------------------
// PlatformHealthMonitor
// ---------------------------------------------------------------------------

export class PlatformHealthMonitor {
  private k8s: KubernetesClient;
  private db: Pool;
  private redis: Redis;
  private thresholds: HealthThresholds = DEFAULT_THRESHOLDS;

  constructor(db: Pool, redis: Redis) {
    this.k8s = new KubernetesClient();
    this.db = db;
    this.redis = redis;
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  async runFullHealthCheck(): Promise<PlatformHealthReport> {
    const startTime = Date.now();
    const reportId = randomUUID();

    // Load runtime thresholds from DB (fall back to defaults)
    await this.loadThresholds();

    // Run all 13 check categories in parallel
    const results = await Promise.allSettled([
      this.checkK8sPods(),
      this.checkK8sNodes(),
      this.checkDeployments(),
      this.checkStatefulSets(),
      this.checkDatabases(),
      this.checkServiceEndpoints(),
      this.checkIstio(),
      this.checkCertificates(),
      this.checkDNSResolution(),
      this.checkResourceUtilization(),
      this.checkDiskAndPVCs(),
      this.checkEmailService(),
      this.checkPluginSystem(),
    ]);

    // Flatten all checks into a single array
    const checks: HealthCheck[] = results.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [{
        component: 'check-group',
        category: 'service-endpoint' as HealthCategory,
        status: 'unknown' as ComponentStatus,
        message: `Check group failed: ${(r as PromiseRejectedResult).reason}`,
        latencyMs: 0,
      }],
    );

    // Compare with baseline
    const baselineComparison = await this.compareWithBaseline(checks);
    const issuesExceedingBaseline = checks.filter(
      (c) => c.status === 'unhealthy' || c.status === 'degraded',
    );

    // Determine overall status
    const overallStatus = this.determineOverallStatus(checks);

    const summary = {
      total: checks.length,
      healthy: checks.filter((c) => c.status === 'healthy').length,
      degraded: checks.filter((c) => c.status === 'degraded').length,
      unhealthy: checks.filter((c) => c.status === 'unhealthy').length,
      skipped: checks.filter((c) => c.status === 'skipped').length,
    };

    const report: PlatformHealthReport = {
      reportId,
      timestamp: new Date().toISOString(),
      overallStatus,
      checks,
      summary,
      durationMs: Date.now() - startTime,
      issuesExceedingBaseline,
      baselineComparison,
    };

    // Store report + baselines
    await this.storeReport(report);
    await this.storeBaselines(checks);

    // Prune old data
    await this.pruneOldData();

    console.info(
      `[health-monitor] Completed: ${overallStatus} | ` +
      `${summary.healthy}/${summary.total} healthy | ` +
      `${summary.degraded} degraded | ${summary.unhealthy} unhealthy | ` +
      `${report.durationMs}ms`,
    );

    // Send alert email for non-healthy status
    if (overallStatus !== 'HEALTHY') {
      this.sendHealthAlertEmail(report).catch((err) => {
        console.warn(`[health-monitor] Alert email failed: ${(err as Error).message}`);
      });
    }

    return report;
  }

  // -----------------------------------------------------------------------
  // Should we trigger remediation?
  // -----------------------------------------------------------------------

  async shouldTriggerRemediation(report: PlatformHealthReport): Promise<boolean> {
    if (report.issuesExceedingBaseline.length < this.thresholds.minUnhealthyToTrigger) {
      return false;
    }

    // Debounce: check if last remediation was < 30 min ago
    try {
      const recent = await this.db.query(
        `SELECT timestamp FROM trigger.remediation_reports
         ORDER BY timestamp DESC LIMIT 1`,
      );
      if (recent.rows.length > 0) {
        const lastTime = new Date(recent.rows[0].timestamp).getTime();
        if (Date.now() - lastTime < 30 * 60 * 1000) {
          console.info('[health-monitor] Skipping remediation — last was <30 min ago');
          return false;
        }
      }
    } catch {
      // If DB check fails, allow triggering
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // 1. K8s Pod Health (DYNAMIC)
  // -----------------------------------------------------------------------

  private async checkK8sPods(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) return [this.skipped('k8s-pods', 'k8s-pod', 'K8s API unavailable')];

    const checks: HealthCheck[] = [];

    // Check pods in monitored namespaces
    for (const ns of MONITOR_NAMESPACES) {
      const pods = await this.k8s.listPods(ns);
      for (const pod of pods) {
        const start = Date.now();
        let status: ComponentStatus = 'healthy';
        let message = `Phase: ${pod.phase}, Ready: ${pod.readyContainers}/${pod.totalContainers}`;

        if (pod.phase !== 'Running' && pod.phase !== 'Succeeded') {
          status = 'unhealthy';
          message = `Phase: ${pod.phase}`;
        } else if (pod.readyContainers < pod.totalContainers) {
          status = 'degraded';
        }

        if (pod.restartCount >= this.thresholds.podRestartThreshold) {
          status = 'degraded';
          message += ` | ${pod.restartCount} restarts`;
        }

        // Check for OOMKilled or CrashLoopBackOff in conditions
        const hasCrashLoop = pod.conditions.some(
          (c) => c.reason?.includes('CrashLoopBackOff') || c.reason?.includes('OOMKilled'),
        );
        if (hasCrashLoop) {
          status = 'unhealthy';
          message += ' | CrashLoop/OOMKilled detected';
        }

        checks.push({
          component: `pod:${ns}/${pod.name}`,
          category: 'k8s-pod',
          status,
          message,
          latencyMs: Date.now() - start,
          details: {
            restartCount: pod.restartCount,
            nodeName: pod.nodeName,
            startTime: pod.startTime,
          },
        });
      }
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // 2. K8s Node Conditions (DYNAMIC)
  // -----------------------------------------------------------------------

  private async checkK8sNodes(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) return [this.skipped('k8s-nodes', 'k8s-node', 'K8s API unavailable')];

    const nodes = await this.k8s.listNodes();
    const checks: HealthCheck[] = [];

    for (const node of nodes) {
      const start = Date.now();
      let status: ComponentStatus = 'healthy';
      const issues: string[] = [];

      for (const cond of node.conditions) {
        // Ready=True is good, everything else True is bad
        if (cond.type === 'Ready' && cond.status !== 'True') {
          status = 'unhealthy';
          issues.push(`NotReady: ${cond.reason || cond.message || 'unknown'}`);
        } else if (cond.type !== 'Ready' && cond.status === 'True') {
          // DiskPressure=True, MemoryPressure=True, etc.
          status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
          issues.push(`${cond.type}: ${cond.reason || cond.message || 'active'}`);
        }
      }

      checks.push({
        component: `node:${node.name}`,
        category: 'k8s-node',
        status,
        message: issues.length > 0 ? issues.join('; ') : 'All conditions nominal',
        latencyMs: Date.now() - start,
        details: { allocatable: node.allocatable, capacity: node.capacity },
      });
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // 3. Deployment Status (DYNAMIC)
  // -----------------------------------------------------------------------

  private async checkDeployments(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) return [this.skipped('k8s-deployments', 'k8s-deployment', 'K8s API unavailable')];

    const checks: HealthCheck[] = [];

    for (const ns of MONITOR_NAMESPACES) {
      const deployments = await this.k8s.listDeployments(ns);
      for (const dep of deployments) {
        const start = Date.now();
        let status: ComponentStatus = 'healthy';
        let message = `Ready: ${dep.readyReplicas}/${dep.desiredReplicas}`;

        if (dep.desiredReplicas === 0) {
          // Scaled to zero — informational, not unhealthy
          status = 'skipped';
          message = 'Scaled to 0 replicas';
        } else if (dep.readyReplicas === 0) {
          status = 'unhealthy';
          message = `No ready replicas (desired: ${dep.desiredReplicas})`;
        } else if (dep.readyReplicas < dep.desiredReplicas) {
          const shortfall = ((dep.desiredReplicas - dep.readyReplicas) / dep.desiredReplicas) * 100;
          status = shortfall >= this.thresholds.replicaDeviationPercent ? 'unhealthy' : 'degraded';
          message += ` (${Math.round(shortfall)}% shortfall)`;
        }

        // Check for failed conditions
        const failedCondition = dep.conditions.find(
          (c) => c.type === 'Available' && c.status !== 'True',
        );
        if (failedCondition) {
          status = 'unhealthy';
          message += ` | ${failedCondition.reason || 'Not available'}`;
        }

        checks.push({
          component: `deployment:${ns}/${dep.name}`,
          category: 'k8s-deployment',
          status,
          message,
          latencyMs: Date.now() - start,
        });
      }
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // 4. StatefulSet Health (DYNAMIC)
  // -----------------------------------------------------------------------

  private async checkStatefulSets(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) return [this.skipped('k8s-statefulsets', 'k8s-statefulset', 'K8s API unavailable')];

    const checks: HealthCheck[] = [];

    for (const ns of MONITOR_NAMESPACES) {
      const sets = await this.k8s.listStatefulSets(ns);
      for (const ss of sets) {
        const start = Date.now();
        let status: ComponentStatus = 'healthy';
        let message = `Ready: ${ss.readyReplicas}/${ss.desiredReplicas}`;

        if (ss.readyReplicas === 0 && ss.desiredReplicas > 0) {
          status = 'unhealthy';
          message = `No ready replicas (desired: ${ss.desiredReplicas})`;
        } else if (ss.readyReplicas < ss.desiredReplicas) {
          status = 'degraded';
        }

        checks.push({
          component: `statefulset:${ns}/${ss.name}`,
          category: 'k8s-statefulset',
          status,
          message,
          latencyMs: Date.now() - start,
        });
      }
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // 5. Database Connectivity
  // -----------------------------------------------------------------------

  private async checkDatabases(): Promise<HealthCheck[]> {
    const checks = await Promise.allSettled([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkNeo4j(),
      this.checkQdrant(),
    ]);

    return checks.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value] : [{
        component: 'db:unknown',
        category: 'database' as HealthCategory,
        status: 'unknown' as ComponentStatus,
        message: `DB check error: ${(r as PromiseRejectedResult).reason}`,
        latencyMs: 0,
      }],
    );
  }

  private async checkPostgres(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      const res = await Promise.race([
        this.db.query('SELECT 1 AS ok'),
        this.timeout(HEALTH_CHECK_TIMEOUT_MS),
      ]);
      // Also check active connections
      const connRes = await this.db.query(
        "SELECT count(*) as cnt FROM pg_stat_activity WHERE state = 'active'",
      );
      const activeConns = parseInt(connRes.rows[0]?.cnt || '0', 10);
      return {
        component: 'db:postgres',
        category: 'database',
        status: 'healthy',
        message: `Connected, ${activeConns} active connections`,
        latencyMs: Date.now() - start,
        details: { activeConnections: activeConns },
      };
    } catch (err) {
      return {
        component: 'db:postgres',
        category: 'database',
        status: 'unhealthy',
        message: `Connection failed: ${(err as Error).message}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async checkRedis(): Promise<HealthCheck> {
    const start = Date.now();
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        this.timeout(HEALTH_CHECK_TIMEOUT_MS),
      ]);

      let memInfo = '';
      try {
        const info = await this.redis.info('memory');
        const usedMatch = info.match(/used_memory_human:(\S+)/);
        const maxMatch = info.match(/maxmemory_human:(\S+)/);
        if (usedMatch) memInfo = `used: ${usedMatch[1]}`;
        if (maxMatch) memInfo += `, max: ${maxMatch[1]}`;
      } catch { /* memory info is best-effort */ }

      return {
        component: 'db:redis',
        category: 'database',
        status: pong === 'PONG' ? 'healthy' : 'degraded',
        message: pong === 'PONG' ? `Connected${memInfo ? ` (${memInfo})` : ''}` : `Unexpected response: ${pong}`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        component: 'db:redis',
        category: 'database',
        status: 'unhealthy',
        message: `Connection failed: ${(err as Error).message}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  private async checkNeo4j(): Promise<HealthCheck> {
    const neo4jHost = process.env.NEO4J_HOST || 'nexus-neo4j.nexus.svc.cluster.local';
    return this.httpHealthCheck(`db:neo4j`, 'database', `http://${neo4jHost}:7474/`);
  }

  private async checkQdrant(): Promise<HealthCheck> {
    const qdrantHost = process.env.QDRANT_HOST || 'nexus-qdrant.nexus.svc.cluster.local';
    return this.httpHealthCheck(`db:qdrant`, 'database', `http://${qdrantHost}:6333/`);
  }

  // -----------------------------------------------------------------------
  // 6. Service Endpoints (FULLY DYNAMIC)
  //    Discovers all K8s services in monitored namespaces,
  //    probes health endpoints automatically.
  // -----------------------------------------------------------------------

  private async checkServiceEndpoints(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) {
      return [this.skipped('services', 'service-endpoint', 'K8s API unavailable — cannot discover services')];
    }

    const checks: HealthCheck[] = [];

    for (const ns of MONITOR_NAMESPACES) {
      const services = await this.k8s.listServices(ns);

      // Probe each service in parallel
      const probes = services
        .filter((svc) => !SKIP_HEALTH_PROBE.has(svc.name) && svc.clusterIP !== 'None')
        .map((svc) => this.probeService(svc, ns));

      const results = await Promise.allSettled(probes);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          checks.push(r.value);
        }
      }
    }

    return checks;
  }

  /**
   * Probe a single K8s service by trying known health paths.
   * Uses annotation `health.nexus.io/path` if present, otherwise
   * tries common paths in order until one responds.
   */
  private async probeService(svc: K8sServiceInfo, ns: string): Promise<HealthCheck | null> {
    const start = Date.now();

    // Pick the first HTTP port (skip metrics, grpc-only, etc.)
    const httpPort = svc.ports.find(
      (p) => p.protocol === 'TCP' && !p.name?.includes('grpc'),
    );
    if (!httpPort) return null; // No HTTP port — nothing to probe

    const baseUrl = `http://${svc.name}.${ns}.svc.cluster.local:${httpPort.port}`;

    // Check for annotation override
    const annotatedPath = svc.annotations?.['health.nexus.io/path'];
    const knownOverride = PORT_HEALTH_OVERRIDES[svc.name];
    const pathsToTry = annotatedPath
      ? [annotatedPath]
      : knownOverride
        ? [knownOverride, ...HEALTH_PATHS.filter((p) => p !== knownOverride)]
        : HEALTH_PATHS;

    for (const path of pathsToTry) {
      try {
        const res = await axios.get(`${baseUrl}${path}`, {
          timeout: HEALTH_CHECK_TIMEOUT_MS,
          validateStatus: () => true, // Accept any status
          maxRedirects: 0,
        });

        if (res.status >= 200 && res.status < 400) {
          return {
            component: `service:${ns}/${svc.name}`,
            category: 'service-endpoint',
            status: 'healthy',
            message: `${path} → ${res.status} (${Date.now() - start}ms)`,
            latencyMs: Date.now() - start,
            details: { port: httpPort.port, path, statusCode: res.status },
          };
        }

        if (res.status >= 400 && res.status < 500 && path !== pathsToTry[pathsToTry.length - 1]) {
          continue; // Try next path (404 means this path doesn't exist)
        }

        // 5xx or last path — report as degraded
        return {
          component: `service:${ns}/${svc.name}`,
          category: 'service-endpoint',
          status: res.status >= 500 ? 'unhealthy' : 'degraded',
          message: `${path} → ${res.status}`,
          latencyMs: Date.now() - start,
          details: { port: httpPort.port, path, statusCode: res.status },
        };
      } catch {
        // Connection refused, timeout, etc. — try next path
        continue;
      }
    }

    // No path responded — service may not have a health endpoint
    // Mark as unknown rather than unhealthy (it's running but we can't confirm health)
    return {
      component: `service:${ns}/${svc.name}`,
      category: 'service-endpoint',
      status: 'unknown',
      message: 'No health endpoint responded',
      latencyMs: Date.now() - start,
      details: { port: httpPort?.port, triedPaths: pathsToTry },
    };
  }

  // -----------------------------------------------------------------------
  // 7. Istio Health (DYNAMIC)
  // -----------------------------------------------------------------------

  private async checkIstio(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) return [this.skipped('istio', 'istio', 'K8s API unavailable')];

    const checks: HealthCheck[] = [];
    const start = Date.now();

    // Check if Istio gateway pods are running
    try {
      const istioPods = await this.k8s.listPods('istio-system');
      const gatewayPods = istioPods.filter((p) => p.name.includes('gateway'));
      const runningGateways = gatewayPods.filter((p) => p.phase === 'Running');

      checks.push({
        component: 'istio:gateways',
        category: 'istio',
        status: runningGateways.length > 0 ? 'healthy' : 'unhealthy',
        message: `${runningGateways.length}/${gatewayPods.length} gateway pods running`,
        latencyMs: Date.now() - start,
      });

      // Check istiod (control plane)
      const istiodPods = istioPods.filter((p) => p.name.includes('istiod'));
      const runningIstiod = istiodPods.filter((p) => p.phase === 'Running');

      checks.push({
        component: 'istio:istiod',
        category: 'istio',
        status: runningIstiod.length > 0 ? 'healthy' : 'unhealthy',
        message: `${runningIstiod.length}/${istiodPods.length} istiod pods running`,
        latencyMs: Date.now() - start,
      });
    } catch {
      checks.push(this.skipped('istio:control-plane', 'istio', 'Cannot access istio-system namespace'));
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // 8. Certificate Health
  // -----------------------------------------------------------------------

  private async checkCertificates(): Promise<HealthCheck[]> {
    const domains = ['dashboard.adverant.ai', 'api.adverant.ai'];
    const checks = await Promise.allSettled(
      domains.map((d) => this.checkTLSCert(d)),
    );
    return checks.map((r) =>
      r.status === 'fulfilled' ? r.value : {
        component: 'cert:unknown',
        category: 'certificate' as HealthCategory,
        status: 'unknown' as ComponentStatus,
        message: `Cert check error: ${(r as PromiseRejectedResult).reason}`,
        latencyMs: 0,
      },
    );
  }

  private checkTLSCert(hostname: string): Promise<HealthCheck> {
    const start = Date.now();
    return new Promise((resolve) => {
      const socket = tls.connect(
        { host: hostname, port: 443, servername: hostname, timeout: HEALTH_CHECK_TIMEOUT_MS },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();

          if (!cert || !cert.valid_to) {
            resolve({
              component: `cert:${hostname}`,
              category: 'certificate',
              status: 'unknown',
              message: 'Could not read certificate',
              latencyMs: Date.now() - start,
            });
            return;
          }

          const expiryDate = new Date(cert.valid_to);
          const daysRemaining = Math.floor((expiryDate.getTime() - Date.now()) / (86400 * 1000));
          let status: ComponentStatus = 'healthy';
          if (daysRemaining <= 0) status = 'unhealthy';
          else if (daysRemaining <= this.thresholds.certExpiryDays) status = 'degraded';

          resolve({
            component: `cert:${hostname}`,
            category: 'certificate',
            status,
            message: `Expires ${expiryDate.toISOString()} (${daysRemaining} days)`,
            latencyMs: Date.now() - start,
            details: { validTo: cert.valid_to, validFrom: cert.valid_from, issuer: cert.issuer?.O },
          });
        },
      );

      socket.on('error', (err) => {
        resolve({
          component: `cert:${hostname}`,
          category: 'certificate',
          status: 'unknown',
          message: `TLS connect failed: ${err.message}`,
          latencyMs: Date.now() - start,
        });
      });

      socket.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => {
        socket.destroy();
        resolve({
          component: `cert:${hostname}`,
          category: 'certificate',
          status: 'unknown',
          message: 'TLS connect timeout',
          latencyMs: Date.now() - start,
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // 9. DNS Resolution
  // -----------------------------------------------------------------------

  private async checkDNSResolution(): Promise<HealthCheck[]> {
    // Dynamically check DNS for critical internal services
    const dnsTargets = [
      `nexus-postgres.${NAMESPACE}.svc.cluster.local`,
      `nexus-redis.${NAMESPACE}.svc.cluster.local`,
      `nexus-graphrag.${NAMESPACE}.svc.cluster.local`,
      `nexus-api-gateway.${NAMESPACE}.svc.cluster.local`,
    ];

    const checks = await Promise.allSettled(
      dnsTargets.map(async (target) => {
        const start = Date.now();
        try {
          await Promise.race([
            dns.promises.resolve(target),
            this.timeout(HEALTH_CHECK_TIMEOUT_MS),
          ]);
          return {
            component: `dns:${target.split('.')[0]}`,
            category: 'dns' as HealthCategory,
            status: 'healthy' as ComponentStatus,
            message: `Resolved ${target}`,
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          return {
            component: `dns:${target.split('.')[0]}`,
            category: 'dns' as HealthCategory,
            status: 'unhealthy' as ComponentStatus,
            message: `DNS resolution failed: ${(err as Error).message}`,
            latencyMs: Date.now() - start,
          };
        }
      }),
    );

    return checks.map((r) =>
      r.status === 'fulfilled' ? r.value : {
        component: 'dns:unknown',
        category: 'dns' as HealthCategory,
        status: 'unknown' as ComponentStatus,
        message: `DNS check error`,
        latencyMs: 0,
      },
    );
  }

  // -----------------------------------------------------------------------
  // 10. Resource Utilization (DYNAMIC — via metrics-server)
  // -----------------------------------------------------------------------

  private async checkResourceUtilization(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) {
      return [this.skipped('resources', 'resource-utilization', 'K8s API unavailable')];
    }

    const checks: HealthCheck[] = [];
    const podMetrics = await this.k8s.getPodMetrics(NAMESPACE);

    if (podMetrics.length === 0) {
      return [this.skipped('resources', 'resource-utilization', 'Metrics server unavailable')];
    }

    // Also get deployments to know resource limits
    const deployments = await this.k8s.listDeployments(NAMESPACE);
    const pods = await this.k8s.listPods(NAMESPACE);

    for (const metric of podMetrics) {
      // Find which deployment this pod belongs to
      const pod = pods.find((p) => p.name === metric.name);
      if (!pod) continue;

      // Memory check (compare against node allocatable as rough estimate)
      const memUsageMB = metric.memoryUsageBytes / (1024 * 1024);
      const start = Date.now();

      // We don't have per-pod limits from metrics API, so report raw usage
      checks.push({
        component: `resource:${metric.name}`,
        category: 'resource-utilization',
        status: 'healthy', // Will be degraded if memory is very high
        message: `CPU: ${metric.cpuUsageMillicores}m, Memory: ${Math.round(memUsageMB)}Mi`,
        latencyMs: Date.now() - start,
        details: {
          cpuMillicores: metric.cpuUsageMillicores,
          memoryMB: Math.round(memUsageMB),
        },
      });
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // 11. Disk / PVC Health (DYNAMIC)
  // -----------------------------------------------------------------------

  private async checkDiskAndPVCs(): Promise<HealthCheck[]> {
    if (!this.k8s.isAvailable()) return [this.skipped('disk', 'disk', 'K8s API unavailable')];

    const checks: HealthCheck[] = [];

    // Check PVCs in monitored namespaces
    for (const ns of MONITOR_NAMESPACES) {
      const pvcs = await this.k8s.listPVCs(ns);
      for (const pvc of pvcs) {
        const start = Date.now();
        let status: ComponentStatus = 'healthy';
        let message = `Status: ${pvc.status}, Capacity: ${pvc.capacity}`;

        if (pvc.status !== 'Bound') {
          status = 'unhealthy';
          message = `PVC not bound: ${pvc.status}`;
        }

        checks.push({
          component: `pvc:${ns}/${pvc.name}`,
          category: 'disk',
          status,
          message,
          latencyMs: Date.now() - start,
          details: { storageClass: pvc.storageClass, volumeName: pvc.volumeName },
        });
      }
    }

    // Node disk pressure already checked in checkK8sNodes()
    return checks;
  }

  // -----------------------------------------------------------------------
  // 12. Email Service (DYNAMIC — probed via service discovery)
  // -----------------------------------------------------------------------

  private async checkEmailService(): Promise<HealthCheck[]> {
    // The email connector will be caught by the dynamic service endpoint
    // probe. This method adds specific email-capability checks.
    const emailHost = process.env.EMAIL_CONNECTOR_URL || `http://nexus-email-connector.${NAMESPACE}.svc.cluster.local:3010`;
    const check = await this.httpHealthCheck('email:connector', 'email', `${emailHost}/api/health`);
    return [check];
  }

  // -----------------------------------------------------------------------
  // 13. Plugin System (DYNAMIC — queries plugin registry)
  // -----------------------------------------------------------------------

  private async checkPluginSystem(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];
    const pluginsUrl = process.env.PLUGINS_API_URL || `http://nexus-plugins.${NAMESPACE}.svc.cluster.local:9080`;

    // Check plugins service health
    const pluginsHealth = await this.httpHealthCheck(
      'plugin:nexus-plugins', 'plugin-system', `${pluginsUrl}/health`,
    );
    checks.push(pluginsHealth);

    // Dynamically query installed plugins
    try {
      const res = await axios.get(`${pluginsUrl}/api/v1/plugins`, {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        headers: { 'x-internal-request': 'true' },
      });
      const plugins = res.data?.data?.plugins || res.data?.plugins || [];

      for (const plugin of plugins) {
        if (!plugin.endpoint) continue;
        const start = Date.now();
        try {
          const pRes = await axios.get(`${plugin.endpoint}/health`, {
            timeout: HEALTH_CHECK_TIMEOUT_MS,
            validateStatus: () => true,
          });
          checks.push({
            component: `plugin:${plugin.name || plugin.id}`,
            category: 'plugin-system',
            status: pRes.status >= 200 && pRes.status < 400 ? 'healthy' : 'degraded',
            message: `${plugin.name}: ${pRes.status}`,
            latencyMs: Date.now() - start,
          });
        } catch {
          checks.push({
            component: `plugin:${plugin.name || plugin.id}`,
            category: 'plugin-system',
            status: 'unhealthy',
            message: `${plugin.name}: unreachable at ${plugin.endpoint}`,
            latencyMs: Date.now() - start,
          });
        }
      }
    } catch {
      // Plugin listing failed — already covered by plugins health check
    }

    return checks;
  }

  // -----------------------------------------------------------------------
  // Baseline comparison
  // -----------------------------------------------------------------------

  private async compareWithBaseline(checks: HealthCheck[]): Promise<BaselineComparison> {
    const comparison: BaselineComparison = { windowHours: 24, reportsInWindow: 0, deviations: [] };

    try {
      // Get baseline averages for each component
      const res = await this.db.query(`
        SELECT component, metric_name,
               AVG(metric_value) as avg_value,
               COUNT(*) as sample_count
        FROM trigger.health_baselines
        WHERE recorded_at > NOW() - INTERVAL '24 hours'
        GROUP BY component, metric_name
      `);

      comparison.reportsInWindow = res.rows.length > 0 ? res.rows[0].sample_count : 0;

      const baselineMap = new Map<string, number>();
      for (const row of res.rows) {
        baselineMap.set(`${row.component}:${row.metric_name}`, parseFloat(row.avg_value));
      }

      // Compare current checks against baselines
      for (const check of checks) {
        const latencyBaseline = baselineMap.get(`${check.component}:latency`);
        if (latencyBaseline && latencyBaseline > 0) {
          const deviation = ((check.latencyMs - latencyBaseline) / latencyBaseline) * 100;
          if (Math.abs(deviation) > this.thresholds.deviationTriggerPercent) {
            comparison.deviations.push({
              component: check.component,
              metric: 'latency',
              baselineValue: latencyBaseline,
              currentValue: check.latencyMs,
              deviationPercent: Math.round(deviation),
            });
          }
        }
      }
    } catch (err) {
      console.debug(`[health-monitor] Baseline comparison failed: ${(err as Error).message}`);
    }

    return comparison;
  }

  // -----------------------------------------------------------------------
  // Status determination
  // -----------------------------------------------------------------------

  private determineOverallStatus(checks: HealthCheck[]): OverallStatus {
    const unhealthy = checks.filter((c) => c.status === 'unhealthy').length;
    const degraded = checks.filter((c) => c.status === 'degraded').length;

    if (unhealthy >= 3) return 'CRITICAL';
    if (unhealthy >= 1) return 'DEGRADED';
    if (degraded >= 5) return 'DEGRADED';
    return 'HEALTHY';
  }

  // -----------------------------------------------------------------------
  // Storage
  // -----------------------------------------------------------------------

  private async storeReport(report: PlatformHealthReport): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO trigger.health_reports
         (report_id, timestamp, overall_status, checks, summary, duration_ms,
          issues_exceeding_baseline, baseline_comparison)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          report.reportId,
          report.timestamp,
          report.overallStatus,
          JSON.stringify(report.checks),
          JSON.stringify(report.summary),
          report.durationMs,
          JSON.stringify(report.issuesExceedingBaseline),
          report.baselineComparison ? JSON.stringify(report.baselineComparison) : null,
        ],
      );
    } catch (err) {
      console.error(`[health-monitor] Failed to store report: ${(err as Error).message}`);
    }
  }

  private async storeBaselines(checks: HealthCheck[]): Promise<void> {
    try {
      const values: string[] = [];
      const params: any[] = [];
      let idx = 1;

      for (const check of checks) {
        if (check.status === 'skipped') continue;
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        params.push(check.component, check.category, 'latency', check.latencyMs);

        // Store status as numeric (healthy=0, degraded=1, unhealthy=2)
        const statusValue = check.status === 'healthy' ? 0 : check.status === 'degraded' ? 1 : 2;
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++})`);
        params.push(check.component, check.category, 'status', statusValue);
      }

      if (values.length > 0) {
        await this.db.query(
          `INSERT INTO trigger.health_baselines (component, category, metric_name, metric_value)
           VALUES ${values.join(', ')}`,
          params,
        );
      }
    } catch (err) {
      console.debug(`[health-monitor] Failed to store baselines: ${(err as Error).message}`);
    }
  }

  private async pruneOldData(): Promise<void> {
    try {
      await this.db.query('SELECT trigger.prune_health_baselines()');
      await this.db.query('SELECT trigger.prune_health_reports()');
    } catch {
      // Non-critical — pruning can happen next run
    }
  }

  // -----------------------------------------------------------------------
  // Load thresholds from DB
  // -----------------------------------------------------------------------

  private async loadThresholds(): Promise<void> {
    try {
      const res = await this.db.query(
        'SELECT threshold_key, threshold_value FROM trigger.health_thresholds',
      );

      const keyMap: Record<string, keyof HealthThresholds> = {
        pod_restart_threshold: 'podRestartThreshold',
        service_latency_ms: 'serviceLatencyMs',
        memory_usage_percent: 'memoryUsagePercent',
        cpu_usage_percent: 'cpuUsagePercent',
        disk_usage_percent: 'diskUsagePercent',
        cert_expiry_days: 'certExpiryDays',
        replica_deviation_percent: 'replicaDeviationPercent',
        deviation_trigger_percent: 'deviationTriggerPercent',
        min_unhealthy_to_trigger: 'minUnhealthyToTrigger',
      };

      for (const row of res.rows) {
        const prop = keyMap[row.threshold_key];
        if (prop) {
          (this.thresholds as any)[prop] = parseFloat(row.threshold_value);
        }
      }
    } catch {
      // Use defaults if DB is unavailable
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Email alert (Resend API)
  // -----------------------------------------------------------------------

  private async sendHealthAlertEmail(report: PlatformHealthReport): Promise<void> {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) return;

    const statusLabel = report.overallStatus === 'CRITICAL' ? '[CRITICAL]' : '[DEGRADED]';
    const issues = report.checks.filter((c) => c.status === 'unhealthy' || c.status === 'degraded');
    const issueList = issues
      .map((c) => `<li><strong>${c.component}</strong> (${c.status}): ${c.message}</li>`)
      .join('\n');

    const html = `
      <h2>${statusLabel} Nexus Platform Health Alert</h2>
      <p><strong>Status:</strong> ${report.overallStatus}</p>
      <p><strong>Time:</strong> ${report.timestamp}</p>
      <p><strong>Summary:</strong> ${report.summary.healthy}/${report.summary.total} healthy, ${report.summary.degraded} degraded, ${report.summary.unhealthy} unhealthy</p>
      <h3>Issues</h3>
      <ul>${issueList}</ul>
      <p><small>Report ID: ${report.reportId} | Duration: ${report.durationMs}ms | AI remediation will follow if thresholds exceeded.</small></p>
    `;

    try {
      await axios.post(
        RESEND_API_URL,
        {
          from: 'Nexus Health <billing@adverant.ai>',
          to: [NOTIFICATION_EMAIL],
          subject: `${statusLabel} Nexus Health: ${issues.length} issues (${report.summary.unhealthy} unhealthy, ${report.summary.degraded} degraded)`,
          html,
          tags: [
            { name: 'type', value: 'health-monitor' },
            { name: 'status', value: report.overallStatus },
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
      console.info(`[health-monitor] Alert email sent to ${NOTIFICATION_EMAIL}`);
    } catch (err) {
      console.warn(`[health-monitor] Alert email failed: ${(err as Error).message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async httpHealthCheck(
    component: string,
    category: HealthCategory,
    url: string,
  ): Promise<HealthCheck> {
    const start = Date.now();
    try {
      const res = await axios.get(url, {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
        validateStatus: () => true,
      });
      return {
        component,
        category,
        status: res.status >= 200 && res.status < 400 ? 'healthy' : 'unhealthy',
        message: `HTTP ${res.status} (${Date.now() - start}ms)`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        component,
        category,
        status: 'unhealthy',
        message: `Unreachable: ${(err as Error).message}`,
        latencyMs: Date.now() - start,
      };
    }
  }

  private skipped(component: string, category: HealthCategory, message: string): HealthCheck {
    return { component, category, status: 'skipped', message, latencyMs: 0 };
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    );
  }
}
