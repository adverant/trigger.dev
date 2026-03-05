/**
 * Platform Knowledge task definitions for the Nexus Trigger.dev plugin.
 *
 * These tasks maintain an up-to-date platform catalog in GraphRAG so the
 * Terminal Computer's platform-info MCP server can serve on-demand queries
 * about plugins, skills, and platform capabilities.
 *
 * Tasks:
 * - platform-knowledge-sync: Daily cron that syncs the full platform catalog
 * - platform-knowledge-refresh: On-demand re-sync triggered by plugin lifecycle events
 */

import { schedules, task } from '@trigger.dev/sdk/v3';
import type { TaskRegistryEntry } from './registry';
import { GraphRAGClient } from '../integrations/graphrag.client';
import { SkillsEngineClient } from '../integrations/skills-engine.client';
import { PluginsClient, PluginCatalogItem } from '../integrations/plugins.client';
import type { SkillListItem } from '../integrations/skills-engine.client';

// --- Interfaces ---

interface PlatformKnowledgeSyncPayload {
  organizationId?: string;
  forceRefresh?: boolean;
  reason?: string;
  pluginId?: string;
}

interface PlatformKnowledgeSyncResult {
  pluginsCatalogued: number;
  skillsCatalogued: number;
  documentId: string;
  memoryId: string;
  durationMs: number;
  errors: string[];
  skipped: boolean;
}

interface PlatformCatalog {
  version: string;
  generatedAt: string;
  organizationId: string;
  plugins: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    endpoint: string;
    tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
    category: string;
    pricingModel: string;
    hasWebUi: boolean;
    uiPath?: string;
    apiDocsUrl?: string;
    tierRequirements?: string[];
  }>;
  skills: Array<{
    id: string;
    name: string;
    category?: string;
    description?: string;
  }>;
  mcpServers: string[];
  services: Record<string, string>;
}

// --- Helpers ---

function getGraphRAGClient(orgId: string): GraphRAGClient {
  return new GraphRAGClient(orgId);
}

function compilePlatformCatalog(
  plugins: PluginCatalogItem[],
  skills: SkillListItem[],
  organizationId: string
): PlatformCatalog {
  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    organizationId,
    plugins: plugins.map((p) => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      endpoint: p.endpoint,
      tools: (p.tools || []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      category: p.category,
      pricingModel: p.pricingModel,
      hasWebUi: p.hasWebUi,
      uiPath: p.uiPath,
      apiDocsUrl: p.apiDocsUrl,
      tierRequirements: p.tierRequirements,
    })),
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      description: s.description,
    })),
    mcpServers: ['n8n', 'graphrag', 'platform-info'],
    services: {
      graphrag: process.env.GRAPHRAG_URL || 'http://nexus-graphrag:9003',
      plugins: process.env.PLUGINS_API_URL || 'http://nexus-plugins:9080',
      skillsEngine: process.env.SKILLS_ENGINE_URL || 'http://nexus-skills-engine:9200',
      trigger: process.env.TRIGGER_URL || 'http://nexus-trigger:9300',
    },
  };
}

function compilePlatformMarkdown(catalog: PlatformCatalog): string {
  const lines: string[] = [];

  lines.push('# Nexus Platform Knowledge Catalog');
  lines.push(`Generated: ${catalog.generatedAt}`);
  lines.push(`Organization: ${catalog.organizationId}`);
  lines.push('');

  lines.push('## Installed Plugins');
  lines.push('');
  for (const p of catalog.plugins) {
    lines.push(`### ${p.displayName || p.name}`);
    lines.push(`- **PID**: \`${p.id}\``);
    lines.push(`- **Name**: \`${p.name}\``);
    lines.push(`- **Endpoint**: \`${p.endpoint}\``);
    if (p.tools?.length) {
      lines.push(`- **Tools**: ${p.tools.map((t) => t.name).join(', ')}`);
    }
    if (p.apiDocsUrl) lines.push(`- **API Docs**: ${p.apiDocsUrl}`);
    if (p.category) lines.push(`- **Category**: ${p.category}`);
    if (p.pricingModel) lines.push(`- **Pricing**: ${p.pricingModel}`);
    if (p.hasWebUi && p.uiPath) lines.push(`- **UI Path**: \`${p.uiPath}\``);
    if (p.tierRequirements?.length) {
      lines.push(`- **Tier Required**: ${p.tierRequirements.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Skills Engine');
  lines.push(`- **API**: \`${catalog.services.skillsEngine}/api/v1/skills\``);
  lines.push(`- **Total Skills**: ${catalog.skills.length}`);
  lines.push('');
  for (const s of catalog.skills) {
    lines.push(`- **${s.name}** (\`${s.id}\`) — ${s.description || s.category || ''}`);
  }
  lines.push('');

  lines.push('## MCP Servers');
  for (const server of catalog.mcpServers) {
    lines.push(`- ${server}`);
  }
  lines.push('');

  lines.push('## Service Endpoints');
  for (const [name, url] of Object.entries(catalog.services)) {
    lines.push(`- **${name}**: \`${url}\``);
  }

  return lines.join('\n');
}

// --- Shared sync logic (exported for direct invocation by task.service.ts) ---

export async function syncPlatformKnowledge(
  orgId: string,
  reason: string
): Promise<PlatformKnowledgeSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  const graphrag = getGraphRAGClient(orgId);

  // Initialize service clients
  let pluginsClient: PluginsClient | null = null;
  let skillsClient: SkillsEngineClient | null = null;

  try {
    pluginsClient = new PluginsClient(orgId);
  } catch (e) {
    errors.push(`Plugins client init failed: ${(e as Error).message}`);
  }

  try {
    skillsClient = new SkillsEngineClient(orgId);
  } catch (e) {
    errors.push(`Skills client init failed: ${(e as Error).message}`);
  }

  // Fetch data in parallel with graceful failures
  const [pluginsResult, skillsResult] = await Promise.allSettled([
    pluginsClient ? pluginsClient.listAllPlugins() : Promise.resolve({ plugins: [], total: 0 }),
    skillsClient
      ? skillsClient.listSkills({ limit: 200 })
      : Promise.resolve({ skills: [], total: 0 }),
  ]);

  const allPlugins =
    pluginsResult.status === 'fulfilled'
      ? pluginsResult.value.plugins
      : (errors.push(`plugins: ${(pluginsResult as PromiseRejectedResult).reason}`), []);

  const allSkills =
    skillsResult.status === 'fulfilled'
      ? skillsResult.value.skills
      : (errors.push(`skills: ${(skillsResult as PromiseRejectedResult).reason}`), []);

  console.log(
    `[platform-knowledge] Fetched ${allPlugins.length} plugins, ${allSkills.length} skills (reason: ${reason})`
  );

  // Compile catalog
  const catalog = compilePlatformCatalog(allPlugins, allSkills, orgId);
  const markdown = compilePlatformMarkdown(catalog);

  // Store in GraphRAG
  const [docResult, memResult] = await Promise.allSettled([
    graphrag.storeDocument({
      content: markdown,
      collection: 'platform-catalog',
      metadata: {
        type: 'platform-knowledge',
        version: catalog.generatedAt,
        pluginCount: allPlugins.length,
        skillCount: allSkills.length,
        reason,
      },
    }),
    graphrag.storeMemory({
      content: JSON.stringify(catalog),
      context: 'platform-knowledge-latest',
      tags: ['platform', 'catalog', 'latest'],
      ttl: 86400 * 2, // 2-day TTL
      collection: 'platform-catalog',
    }),
  ]);

  const documentId =
    docResult.status === 'fulfilled'
      ? docResult.value.documentId
      : (errors.push(`storeDocument: ${(docResult as PromiseRejectedResult).reason}`), '');

  const memoryId =
    memResult.status === 'fulfilled'
      ? memResult.value.memoryId
      : (errors.push(`storeMemory: ${(memResult as PromiseRejectedResult).reason}`), '');

  return {
    pluginsCatalogued: allPlugins.length,
    skillsCatalogued: allSkills.length,
    documentId,
    memoryId,
    durationMs: Date.now() - startTime,
    errors,
    skipped: false,
  };
}

// --- Scheduled Task: Daily Full Sync ---

export const platformKnowledgeSync = schedules.task({
  id: 'platform-knowledge-sync',
  cron: '0 3 * * *', // Daily at 3 AM UTC
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload) => {
    const orgId =
      (payload as PlatformKnowledgeSyncPayload).organizationId ||
      process.env.SYSTEM_ORGANIZATION_ID ||
      'system';

    console.log('[platform-knowledge] Starting daily platform knowledge sync');
    return syncPlatformKnowledge(orgId, 'daily-cron');
  },
});

// --- On-Demand Task: Event-Driven Refresh ---

export const platformKnowledgeRefresh = task({
  id: 'platform-knowledge-refresh',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: PlatformKnowledgeSyncPayload) => {
    const orgId = payload.organizationId || process.env.SYSTEM_ORGANIZATION_ID || 'system';
    const reason = payload.reason || 'on-demand';

    // Debounce: check if last sync was less than 5 minutes ago
    const graphrag = getGraphRAGClient(orgId);
    try {
      const recent = await graphrag.search({
        query: 'platform catalog',
        collection: 'platform-catalog',
        topK: 1,
        filters: { type: 'platform-knowledge' },
        includeMetadata: true,
      });

      if (recent.results.length > 0) {
        const lastVersion = recent.results[0].metadata?.version as string | undefined;
        if (lastVersion) {
          const lastSyncTime = new Date(lastVersion).getTime();
          const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
          if (lastSyncTime > fiveMinutesAgo) {
            console.log(
              `[platform-knowledge] Skipping refresh — last sync was ${Math.round(
                (Date.now() - lastSyncTime) / 1000
              )}s ago (reason: ${reason})`
            );
            return {
              pluginsCatalogued: 0,
              skillsCatalogued: 0,
              documentId: '',
              memoryId: '',
              durationMs: 0,
              errors: [],
              skipped: true,
            } satisfies PlatformKnowledgeSyncResult;
          }
        }
      }
    } catch {
      // If debounce check fails, proceed with sync
    }

    console.log(`[platform-knowledge] Starting on-demand refresh (reason: ${reason})`);
    return syncPlatformKnowledge(orgId, reason);
  },
});

// --- Registry Export ---

export const PLATFORM_KNOWLEDGE_TASKS: TaskRegistryEntry[] = [
  {
    taskIdentifier: 'platform-knowledge-sync',
    description: 'Daily sync of platform plugin catalog, skills, and service inventory to GraphRAG',
    nexusService: 'platform',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'platform-knowledge-refresh',
    description:
      'On-demand re-sync of platform catalog triggered by plugin lifecycle events (debounced)',
    nexusService: 'platform',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 30000, factor: 2 },
  },
];
