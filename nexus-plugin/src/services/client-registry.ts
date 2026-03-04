/**
 * Service Client Registry
 *
 * Maps service names to their integration clients.
 * Each client must implement a healthCheck() method.
 * Tracks initialization failures for observability.
 */

import type { ServiceName } from '../database/repositories/integration-config.repository';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'client-registry' });

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
}

export interface ServiceClient {
  healthCheck(): Promise<HealthCheckResult>;
}

export type ServiceClientRegistry = Map<ServiceName, ServiceClient>;

/** Tracks which clients failed to initialize and why */
const failedClients = new Map<string, { error: string; timestamp: Date }>();

/**
 * Get the list of clients that failed to initialize.
 * Used by health/integrations endpoints for visibility.
 */
export function getFailedClients(): Map<string, { error: string; timestamp: Date }> {
  return failedClients;
}

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
    'skills-engine': 'SKILLS_ENGINE_URL',
  };

  // Ensure env vars are populated from config before constructing clients
  for (const [service, envVar] of Object.entries(envMapping)) {
    const configKeyMap: Record<string, string> = { 'gpu-bridge': 'gpuBridge', 'skills-engine': 'skillsEngine' };
    const configKey = configKeyMap[service] || service;
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
    'skills-engine': () => {
      const { SkillsEngineClient } = require('../integrations/skills-engine.client');
      return new SkillsEngineClient(organizationId);
    },
  };

  for (const [service, factory] of Object.entries(clientFactories)) {
    const configKeyMap: Record<string, string> = { 'gpu-bridge': 'gpuBridge', 'skills-engine': 'skillsEngine' };
    const configKey = configKeyMap[service] || service;
    const url = (serviceUrls as any)[configKey] || '';

    // Skip services with no URL configured (not deployed)
    if (!url) {
      continue;
    }

    try {
      registry.set(service as ServiceName, factory());
      failedClients.delete(service); // Clear any previous failure
    } catch (err: any) {
      logger.error('Failed to initialize integration client', {
        service,
        error: err.message,
        url,
      });
      failedClients.set(service, {
        error: err.message,
        timestamp: new Date(),
      });
    }
  }

  logger.info('Client registry initialized', {
    initialized: Array.from(registry.keys()),
    failed: Array.from(failedClients.keys()),
    skipped: Object.keys(clientFactories).filter(s => {
      const ckm: Record<string, string> = { 'gpu-bridge': 'gpuBridge', 'skills-engine': 'skillsEngine' };
      return !(serviceUrls as any)[ckm[s] || s];
    }),
  });

  return registry;
}
