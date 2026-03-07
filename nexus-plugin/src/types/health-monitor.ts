/**
 * Platform Health Monitor type definitions.
 *
 * Used by both the scheduled health check task (Task 1) and the
 * AI-powered remediation task (Task 2).
 */

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'skipped';
export type OverallStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export type HealthCategory =
  | 'k8s-pod'
  | 'k8s-node'
  | 'k8s-deployment'
  | 'k8s-statefulset'
  | 'database'
  | 'service-endpoint'
  | 'istio'
  | 'certificate'
  | 'dns'
  | 'resource-utilization'
  | 'disk'
  | 'email'
  | 'plugin-system';

// ---------------------------------------------------------------------------
// Health check result
// ---------------------------------------------------------------------------

export interface HealthCheck {
  component: string;
  category: HealthCategory;
  status: ComponentStatus;
  message: string;
  latencyMs: number;
  details?: Record<string, unknown>;
  threshold?: {
    metric: string;
    actual: number;
    baseline: number;
    deviation: number;
  };
}

// ---------------------------------------------------------------------------
// Platform health report (Task 1 output)
// ---------------------------------------------------------------------------

export interface PlatformHealthReport {
  reportId: string;
  timestamp: string;
  overallStatus: OverallStatus;
  checks: HealthCheck[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    skipped: number;
  };
  durationMs: number;
  issuesExceedingBaseline: HealthCheck[];
  baselineComparison?: BaselineComparison;
}

export interface BaselineComparison {
  windowHours: number;
  reportsInWindow: number;
  deviations: Array<{
    component: string;
    metric: string;
    baselineValue: number;
    currentValue: number;
    deviationPercent: number;
  }>;
}

// ---------------------------------------------------------------------------
// Thresholds (stored in DB, loaded at runtime)
// ---------------------------------------------------------------------------

export interface HealthThresholds {
  podRestartThreshold: number;
  serviceLatencyMs: number;
  memoryUsagePercent: number;
  cpuUsagePercent: number;
  diskUsagePercent: number;
  certExpiryDays: number;
  replicaDeviationPercent: number;
  deviationTriggerPercent: number;
  minUnhealthyToTrigger: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  podRestartThreshold: 3,
  serviceLatencyMs: 5000,
  memoryUsagePercent: 85,
  cpuUsagePercent: 80,
  diskUsagePercent: 85,
  certExpiryDays: 14,
  replicaDeviationPercent: 50,
  deviationTriggerPercent: 30,
  minUnhealthyToTrigger: 2,
};

// ---------------------------------------------------------------------------
// Service endpoint definition
// ---------------------------------------------------------------------------

export interface ServiceEndpointDef {
  name: string;
  url: string;
  healthPath: string;
  port: number;
  timeoutMs: number;
  critical: boolean;
}

// ---------------------------------------------------------------------------
// Remediation report (Task 2 output)
// ---------------------------------------------------------------------------

export interface RemediationReport {
  reportId: string;
  healthReportId: string;
  timestamp: string;
  markdownReport: string;
  xmlRemediation: string;
  issueCount: number;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// K8s client simplified types
// ---------------------------------------------------------------------------

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  phase: string;
  restartCount: number;
  readyContainers: number;
  totalContainers: number;
  nodeName: string;
  startTime: string | null;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

export interface NodeInfo {
  name: string;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  allocatable: { cpu: string; memory: string; pods: string; ephemeralStorage?: string };
  capacity: { cpu: string; memory: string; pods: string; ephemeralStorage?: string };
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  desiredReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  updatedReplicas: number;
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
}

export interface StatefulSetInfo {
  name: string;
  namespace: string;
  desiredReplicas: number;
  readyReplicas: number;
  currentReplicas: number;
}

export interface PodMetrics {
  name: string;
  namespace: string;
  cpuUsageMillicores: number;
  memoryUsageBytes: number;
}

export interface NodeMetrics {
  name: string;
  cpuUsageMillicores: number;
  memoryUsageBytes: number;
}

export interface PVCInfo {
  name: string;
  namespace: string;
  status: string;
  capacity: string;
  storageClass: string;
  volumeName: string;
}

export interface K8sServiceInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  ports: Array<{ name: string; port: number; targetPort: any; protocol: string }>;
  selector: Record<string, string>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}
