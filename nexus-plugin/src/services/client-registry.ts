/**
 * Service Client Registry
 *
 * Maps service names to their integration clients.
 * Each client must implement a healthCheck() method.
 */

import type { ServiceName } from '../database/repositories/integration-config.repository';

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
}

export interface ServiceClient {
  healthCheck(): Promise<HealthCheckResult>;
}

export type ServiceClientRegistry = Map<ServiceName, ServiceClient>;

/**
 * Build a registry of service clients, safely skipping any that fail to initialize.
 * Clients read their base URL from process.env, so the env vars must be set before
 * calling this function.
 */
export function buildClientRegistry(
  serviceUrls: Record<string, string>,
  organizationId: string
): ServiceClientRegistry {
  const registry: ServiceClientRegistry = new Map();

  // Set env vars so clients can read their base URLs
  const envMapping: Record<string, string> = {
    graphrag: 'GRAPHRAG_URL',
    mageagent: 'MAGEAGENT_URL',
    fileprocess: 'FILEPROCESS_URL',
    learningagent: 'LEARNINGAGENT_URL',
    geoagent: 'GEOAGENT_URL',
    jupyter: 'JUPYTER_URL',
    cvat: 'CVAT_URL',
    'gpu-bridge': 'GPU_BRIDGE_URL',
    sandbox: 'SANDBOX_URL',
    n8n: 'N8N_URL',
  };

  // Ensure env vars are populated from config before constructing clients
  for (const [service, envVar] of Object.entries(envMapping)) {
    const configKey = service === 'gpu-bridge' ? 'gpuBridge' : service;
    const url = (serviceUrls as any)[configKey] || '';
    if (url && !process.env[envVar]) {
      process.env[envVar] = url;
    }
  }

  // Lazy imports to avoid top-level failures
  const clientFactories: Record<string, () => ServiceClient> = {
    graphrag: () => {
      const { GraphRAGClient } = require('../integrations/graphrag.client');
      return new GraphRAGClient(organizationId);
    },
    mageagent: () => {
      const { MageAgentClient } = require('../integrations/mageagent.client');
      return new MageAgentClient(organizationId);
    },
    fileprocess: () => {
      const { FileProcessClient } = require('../integrations/fileprocess.client');
      return new FileProcessClient(organizationId);
    },
    learningagent: () => {
      const { LearningAgentClient } = require('../integrations/learningagent.client');
      return new LearningAgentClient(organizationId);
    },
    geoagent: () => {
      const { GeoAgentClient } = require('../integrations/geoagent.client');
      return new GeoAgentClient(organizationId);
    },
    jupyter: () => {
      const { JupyterClient } = require('../integrations/jupyter.client');
      return new JupyterClient(organizationId);
    },
    cvat: () => {
      const { CVATClient } = require('../integrations/cvat.client');
      return new CVATClient(organizationId);
    },
    'gpu-bridge': () => {
      const { GPUBridgeClient } = require('../integrations/gpu-bridge.client');
      return new GPUBridgeClient(organizationId);
    },
    sandbox: () => {
      const { SandboxClient } = require('../integrations/sandbox.client');
      return new SandboxClient(organizationId);
    },
    n8n: () => {
      const { N8NClient } = require('../integrations/n8n.client');
      return new N8NClient(organizationId);
    },
  };

  for (const [service, factory] of Object.entries(clientFactories)) {
    const configKey = service === 'gpu-bridge' ? 'gpuBridge' : service;
    const url = (serviceUrls as any)[configKey] || '';

    // Skip services with no URL configured (not deployed)
    if (!url) {
      continue;
    }

    try {
      registry.set(service as ServiceName, factory());
    } catch (err: any) {
      // Client construction failed (e.g., missing env var) — skip silently
      console.warn(`[ClientRegistry] Failed to initialize ${service} client: ${err.message}`);
    }
  }

  return registry;
}
