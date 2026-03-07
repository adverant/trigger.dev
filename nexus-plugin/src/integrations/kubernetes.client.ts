/**
 * Kubernetes API client for platform health monitoring.
 *
 * Uses in-cluster config (service account token auto-mounted by K8s).
 * All methods are read-only and have individual timeouts.
 * If the K8s API is unreachable the client returns empty arrays
 * rather than throwing — callers mark those checks as 'skipped'.
 */

import * as k8s from '@kubernetes/client-node';
import type {
  PodInfo,
  NodeInfo,
  DeploymentInfo,
  StatefulSetInfo,
  PodMetrics,
  NodeMetrics,
  PVCInfo,
  K8sServiceInfo,
} from '../types/health-monitor';

const API_TIMEOUT_MS = 10_000;

export class KubernetesClient {
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private customApi: k8s.CustomObjectsApi;
  private available = true;

  constructor() {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      // Not running in-cluster — mark as unavailable
      this.available = false;
      kc.loadFromDefault(); // fallback for local dev (kubeconfig)
    }
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  isAvailable(): boolean {
    return this.available;
  }

  // -----------------------------------------------------------------------
  // Pods
  // -----------------------------------------------------------------------

  async listPods(namespace: string): Promise<PodInfo[]> {
    try {
      const res = await this.withTimeout(
        this.coreApi.listNamespacedPod({ namespace }),
      );
      return (res.items || []).map((p) => ({
        name: p.metadata?.name || '',
        namespace: p.metadata?.namespace || namespace,
        status: p.status?.phase || 'Unknown',
        phase: p.status?.phase || 'Unknown',
        restartCount: (p.status?.containerStatuses || []).reduce(
          (sum, c) => sum + (c.restartCount || 0),
          0,
        ),
        readyContainers: (p.status?.containerStatuses || []).filter((c) => c.ready).length,
        totalContainers: (p.spec?.containers || []).length,
        nodeName: p.spec?.nodeName || '',
        startTime: p.status?.startTime?.toISOString() ?? null,
        conditions: (p.status?.conditions || []).map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
      }));
    } catch (err) {
      this.handleError('listPods', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Nodes
  // -----------------------------------------------------------------------

  async listNodes(): Promise<NodeInfo[]> {
    try {
      const res = await this.withTimeout(this.coreApi.listNode());
      return (res.items || []).map((n) => ({
        name: n.metadata?.name || '',
        conditions: (n.status?.conditions || []).map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
        allocatable: {
          cpu: n.status?.allocatable?.['cpu'] || '0',
          memory: n.status?.allocatable?.['memory'] || '0',
          pods: n.status?.allocatable?.['pods'] || '0',
          ephemeralStorage: n.status?.allocatable?.['ephemeral-storage'],
        },
        capacity: {
          cpu: n.status?.capacity?.['cpu'] || '0',
          memory: n.status?.capacity?.['memory'] || '0',
          pods: n.status?.capacity?.['pods'] || '0',
          ephemeralStorage: n.status?.capacity?.['ephemeral-storage'],
        },
      }));
    } catch (err) {
      this.handleError('listNodes', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Deployments
  // -----------------------------------------------------------------------

  async listDeployments(namespace: string): Promise<DeploymentInfo[]> {
    try {
      const res = await this.withTimeout(
        this.appsApi.listNamespacedDeployment({ namespace }),
      );
      return (res.items || []).map((d) => ({
        name: d.metadata?.name || '',
        namespace: d.metadata?.namespace || namespace,
        desiredReplicas: d.spec?.replicas ?? 1,
        readyReplicas: d.status?.readyReplicas ?? 0,
        availableReplicas: d.status?.availableReplicas ?? 0,
        updatedReplicas: d.status?.updatedReplicas ?? 0,
        conditions: (d.status?.conditions || []).map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
      }));
    } catch (err) {
      this.handleError('listDeployments', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // StatefulSets
  // -----------------------------------------------------------------------

  async listStatefulSets(namespace: string): Promise<StatefulSetInfo[]> {
    try {
      const res = await this.withTimeout(
        this.appsApi.listNamespacedStatefulSet({ namespace }),
      );
      return (res.items || []).map((s) => ({
        name: s.metadata?.name || '',
        namespace: s.metadata?.namespace || namespace,
        desiredReplicas: s.spec?.replicas ?? 1,
        readyReplicas: s.status?.readyReplicas ?? 0,
        currentReplicas: s.status?.currentReplicas ?? 0,
      }));
    } catch (err) {
      this.handleError('listStatefulSets', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Pod Metrics (requires metrics-server)
  // -----------------------------------------------------------------------

  async getPodMetrics(namespace: string): Promise<PodMetrics[]> {
    try {
      const res = await this.withTimeout(
        this.customApi.listNamespacedCustomObject({
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          namespace,
          plural: 'pods',
        }),
      );
      const body = res as { items?: Array<Record<string, any>> };
      return (body.items || []).map((item) => {
        const containers = (item.containers || []) as Array<{ usage?: { cpu?: string; memory?: string } }>;
        const cpuTotal = containers.reduce((s, c) => s + parseCpuToMillicores(c.usage?.cpu || '0'), 0);
        const memTotal = containers.reduce((s, c) => s + parseMemoryToBytes(c.usage?.memory || '0'), 0);
        return {
          name: item.metadata?.name || '',
          namespace: item.metadata?.namespace || namespace,
          cpuUsageMillicores: cpuTotal,
          memoryUsageBytes: memTotal,
        };
      });
    } catch (err) {
      this.handleError('getPodMetrics', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Node Metrics (requires metrics-server)
  // -----------------------------------------------------------------------

  async getNodeMetrics(): Promise<NodeMetrics[]> {
    try {
      const res = await this.withTimeout(
        this.customApi.listClusterCustomObject({
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          plural: 'nodes',
        }),
      );
      const body = res as { items?: Array<Record<string, any>> };
      return (body.items || []).map((item) => ({
        name: item.metadata?.name || '',
        cpuUsageMillicores: parseCpuToMillicores(item.usage?.cpu || '0'),
        memoryUsageBytes: parseMemoryToBytes(item.usage?.memory || '0'),
      }));
    } catch (err) {
      this.handleError('getNodeMetrics', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Services (for dynamic endpoint discovery)
  // -----------------------------------------------------------------------

  async listServices(namespace: string): Promise<K8sServiceInfo[]> {
    try {
      const res = await this.withTimeout(
        this.coreApi.listNamespacedService({ namespace }),
      );
      return (res.items || []).map((svc) => {
        const ports = (svc.spec?.ports || []).map((p) => ({
          name: p.name || '',
          port: p.port,
          targetPort: p.targetPort,
          protocol: p.protocol || 'TCP',
        }));
        return {
          name: svc.metadata?.name || '',
          namespace: svc.metadata?.namespace || namespace,
          type: svc.spec?.type || 'ClusterIP',
          clusterIP: svc.spec?.clusterIP || '',
          ports,
          selector: svc.spec?.selector || {},
          labels: svc.metadata?.labels || {},
          annotations: svc.metadata?.annotations || {},
        };
      });
    } catch (err) {
      this.handleError('listServices', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // PVCs
  // -----------------------------------------------------------------------

  async listPVCs(namespace: string): Promise<PVCInfo[]> {
    try {
      const res = await this.withTimeout(
        this.coreApi.listNamespacedPersistentVolumeClaim({ namespace }),
      );
      return (res.items || []).map((pvc) => ({
        name: pvc.metadata?.name || '',
        namespace: pvc.metadata?.namespace || namespace,
        status: pvc.status?.phase || 'Unknown',
        capacity: pvc.status?.capacity?.['storage'] || '0',
        storageClass: pvc.spec?.storageClassName || '',
        volumeName: pvc.spec?.volumeName || '',
      }));
    } catch (err) {
      this.handleError('listPVCs', err);
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('K8s API timeout')), API_TIMEOUT_MS),
      ),
    ]);
  }

  private handleError(method: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't log full stack for expected errors (RBAC, timeout, not in cluster)
    if (msg.includes('ECONNREFUSED') || msg.includes('timeout') || msg.includes('Forbidden')) {
      console.debug(`[k8s-client] ${method}: ${msg}`);
    } else {
      console.warn(`[k8s-client] ${method} failed: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// K8s resource string parsers
// ---------------------------------------------------------------------------

function parseCpuToMillicores(cpu: string): number {
  if (cpu.endsWith('n')) return parseInt(cpu, 10) / 1_000_000;
  if (cpu.endsWith('u')) return parseInt(cpu, 10) / 1_000;
  if (cpu.endsWith('m')) return parseInt(cpu, 10);
  return parseFloat(cpu) * 1000;
}

function parseMemoryToBytes(mem: string): number {
  const units: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1_000_000,
    G: 1_000_000_000,
  };
  for (const [suffix, multiplier] of Object.entries(units)) {
    if (mem.endsWith(suffix)) {
      return parseInt(mem.replace(suffix, ''), 10) * multiplier;
    }
  }
  return parseInt(mem, 10) || 0;
}

export { parseCpuToMillicores, parseMemoryToBytes };