/**
 * Static task definition registry.
 *
 * Since `trigger-dev-webapp` is not deployed, the "Sync Tasks" flow has
 * nothing to pull from.  Instead we seed all 50 Nexus task definitions
 * directly into the DB on startup so the Tasks page is immediately populated.
 */

import type { UpsertTaskDefinitionData } from '../database/repositories/task-definition.repository';
import { SKILLS_ENGINE_TASKS } from './skills-engine-tasks';
import { PLATFORM_KNOWLEDGE_TASKS } from './platform-knowledge-tasks';
import { PLATFORM_HEALTH_TASKS } from './platform-health-tasks';

export interface TaskRegistryEntry {
  taskIdentifier: string;
  description: string;
  nexusService: string;
  retryConfig?: {
    maxAttempts: number;
    minTimeoutInMs?: number;
    maxTimeoutInMs?: number;
    factor?: number;
  };
  queueName?: string;
}

/**
 * All 50 Nexus task definitions organised by service.
 */
export const TASK_REGISTRY: TaskRegistryEntry[] = [
  // ── GraphRAG (4) ────────────────────────────────────────────────────
  {
    taskIdentifier: 'graphrag-store-run-results',
    description: 'Persist task run outputs into the knowledge graph',
    nexusService: 'graphrag',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
  },
  {
    taskIdentifier: 'graphrag-build-dependency-graph',
    description: 'Analyze and build dependency relationships between tasks',
    nexusService: 'graphrag',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 15000, factor: 2 },
  },
  {
    taskIdentifier: 'graphrag-search-task-logs',
    description: 'Semantic search across task execution logs',
    nexusService: 'graphrag',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 500, maxTimeoutInMs: 5000, factor: 2 },
  },
  {
    taskIdentifier: 'graphrag-nightly-memory-sync',
    description: 'Scheduled nightly synchronization of graph memory state',
    nexusService: 'graphrag',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
    queueName: 'cron',
  },

  // ── MageAgent (4) ───────────────────────────────────────────────────
  {
    taskIdentifier: 'mageagent-orchestration',
    description: 'Multi-agent orchestration with retry and model fallover',
    nexusService: 'mageagent',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'mageagent-competition',
    description: 'Competitive agent evaluation for best result',
    nexusService: 'mageagent',
  },
  {
    taskIdentifier: 'mageagent-vision-ai',
    description: 'Vision model processing (image/diagram analysis)',
    nexusService: 'mageagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 15000, factor: 2 },
  },
  {
    taskIdentifier: 'mageagent-embedding-generation',
    description: 'Batch embedding generation for vector storage',
    nexusService: 'mageagent',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 20000, factor: 2 },
  },

  // ── FileProcess (4) ─────────────────────────────────────────────────
  {
    taskIdentifier: 'fileprocess-document-pipeline',
    description: 'Sequential multi-operation document processing',
    nexusService: 'fileprocess',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'fileprocess-batch-ocr',
    description: 'Batch OCR processing of multiple files',
    nexusService: 'fileprocess',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
  },
  {
    taskIdentifier: 'fileprocess-scheduled-batch',
    description: 'Daily scheduled batch processing of unprocessed files',
    nexusService: 'fileprocess',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'fileprocess-table-extraction',
    description: 'Extract structured tables from documents',
    nexusService: 'fileprocess',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 20000, factor: 2 },
  },

  // ── LearningAgent (4) ───────────────────────────────────────────────
  {
    taskIdentifier: 'learningagent-discovery-search',
    description: 'Multi-source knowledge discovery and aggregation',
    nexusService: 'learningagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 20000, factor: 2 },
  },
  {
    taskIdentifier: 'learningagent-knowledge-synthesis',
    description: 'Synthesize knowledge from multiple documents',
    nexusService: 'learningagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'learningagent-learning-pipeline',
    description: 'Sequential learning pipeline with configurable steps',
    nexusService: 'learningagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 60000, factor: 2 },
  },
  {
    taskIdentifier: 'learningagent-scheduled-discovery',
    description: 'Weekly scheduled discovery on configured topics',
    nexusService: 'learningagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 120000, factor: 2 },
    queueName: 'cron',
  },

  // ── GeoAgent (4) ────────────────────────────────────────────────────
  {
    taskIdentifier: 'geoagent-earth-engine-analysis',
    description: 'Run Earth Engine spatial analysis tasks',
    nexusService: 'geoagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
  },
  {
    taskIdentifier: 'geoagent-bigquery-gis',
    description: 'Execute BigQuery GIS queries',
    nexusService: 'geoagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'geoagent-satellite-processing',
    description: 'Process satellite imagery with multiple operations',
    nexusService: 'geoagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'geoagent-scheduled-monitoring',
    description: 'Daily scheduled satellite monitoring for change detection',
    nexusService: 'geoagent',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 120000, factor: 2 },
    queueName: 'cron',
  },

  // ── Jupyter (4) ─────────────────────────────────────────────────────
  {
    taskIdentifier: 'jupyter-execute-notebook',
    description: 'Execute a Jupyter notebook with parameters',
    nexusService: 'jupyter',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'jupyter-scheduled-notebook',
    description: 'Daily scheduled notebook execution',
    nexusService: 'jupyter',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 300000, factor: 2 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'jupyter-create-notebook',
    description: 'Create a new Jupyter notebook',
    nexusService: 'jupyter',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
  },
  {
    taskIdentifier: 'jupyter-notebook-to-report',
    description: 'Convert notebook to report format',
    nexusService: 'jupyter',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 60000, factor: 2 },
  },

  // ── CVAT (4) ────────────────────────────────────────────────────────
  {
    taskIdentifier: 'cvat-create-annotation-job',
    description: 'Create a new CVAT annotation task with images and labels',
    nexusService: 'cvat',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'cvat-export-annotations',
    description: 'Export completed annotations in various formats',
    nexusService: 'cvat',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'cvat-dataset-management',
    description: 'Create, merge, split, or augment datasets',
    nexusService: 'cvat',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 60000, factor: 2 },
  },
  {
    taskIdentifier: 'cvat-auto-annotation',
    description: 'Run automatic annotation on a task using ML models',
    nexusService: 'cvat',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 120000, factor: 2 },
  },

  // ── GPU Bridge (4) ──────────────────────────────────────────────────
  {
    taskIdentifier: 'gpu-ml-training',
    description: 'Long-running ML model training with GPU allocation',
    nexusService: 'gpu-bridge',
    retryConfig: { maxAttempts: 1 },
  },
  {
    taskIdentifier: 'gpu-batch-inference',
    description: 'Batch inference across multiple inputs',
    nexusService: 'gpu-bridge',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'gpu-model-optimization',
    description: 'Optimize models via quantization, pruning, distillation, ONNX export',
    nexusService: 'gpu-bridge',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'gpu-scheduled-retraining',
    description: 'Weekly scheduled model retraining check',
    nexusService: 'gpu-bridge',
    retryConfig: { maxAttempts: 1 },
    queueName: 'cron',
  },

  // ── N8N (4) ─────────────────────────────────────────────────────────
  {
    taskIdentifier: 'n8n-trigger-workflow',
    description: 'Trigger an N8N workflow with optional wait for completion',
    nexusService: 'n8n',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 15000, factor: 2 },
  },
  {
    taskIdentifier: 'n8n-webhook-receiver',
    description: 'Process incoming N8N webhook payloads',
    nexusService: 'n8n',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
  },
  {
    taskIdentifier: 'n8n-scheduled-workflow-sync',
    description: 'Sync N8N workflow states with Nexus DB every 30 minutes',
    nexusService: 'n8n',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'n8n-workflow-chain',
    description: 'Execute multiple N8N workflows in sequence or parallel',
    nexusService: 'n8n',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 30000, factor: 2 },
  },

  // ── EE Design Partner (10) ──────────────────────────────────────────
  {
    taskIdentifier: 'ee-design/resolve-symbols',
    description: 'Fetch and resolve KiCad symbols from libraries for schematic generation',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/generate-connections',
    description: 'LLM-generated net connections between schematic components (2-10 min)',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 600000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/optimize-layout',
    description: 'Graph centrality + AABB collision detection for IC placement optimization',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/route-wires',
    description: 'Wire routing between components with power label generation',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 60000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/assemble-schematic',
    description: 'Assemble final KiCad .kicad_sch file from pipeline artifacts',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/smoke-test',
    description: 'Electrical rule check — power disconnection, short circuits, missing connections',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 1 },
  },
  {
    taskIdentifier: 'ee-design/visual-validate',
    description: 'AI visual quality assessment of rendered schematic image',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/export-artifacts',
    description: 'Export BOM, netlist, and schematic archive files',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30000, factor: 2 },
  },
  {
    taskIdentifier: 'ee-design/mapo-pipeline',
    description: 'Full MAPO pipeline (8 phases) as a single orchestrated run',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 1 },
  },
  {
    taskIdentifier: 'ee-design/ralph-loop',
    description: 'Continuous iteration loop with quality gate evaluation and escalation',
    nexusService: 'ee-design',
    retryConfig: { maxAttempts: 1 },
  },

  // ── ProseCreator (10) ───────────────────────────────────────────────
  {
    taskIdentifier: 'prosecreator-generate-blueprint',
    description: 'Generate a living blueprint from an outline using LLM analysis',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-generate-chapters',
    description: 'Generate manuscript chapters from a blueprint with quality gates',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 300000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-character-analysis',
    description: 'Deep character development analysis with voice fingerprinting',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-continuity-audit',
    description: 'Cross-chapter continuity checking for traits, locations, and timeline',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-cnes-audit',
    description: 'Full CNES narrative, emotional, and structural audit with LLM scoring',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 300000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-quality-assessment',
    description: 'Manuscript quality scoring across plot, character, writing, and market readiness',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-ai-detection-scan',
    description: 'Scan writing for AI-generated content patterns',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-export-pipeline',
    description: 'Multi-format export pipeline (DOCX, EPUB, PDF)',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 120000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-series-intelligence-sync',
    description: 'Cross-book series consistency analysis for character arcs and lore',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 300000, factor: 2 },
  },
  {
    taskIdentifier: 'prosecreator-deep-insight-generation',
    description: 'Semantic-level writing insights including pacing, voice drift, and thematic analysis',
    nexusService: 'prosecreator',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  },

  // ── Sandbox (4) ─────────────────────────────────────────────────────
  {
    taskIdentifier: 'sandbox-code-execution',
    description: 'Execute code in an isolated sandbox environment',
    nexusService: 'sandbox',
    retryConfig: { maxAttempts: 1 },
  },
  {
    taskIdentifier: 'sandbox-security-scan',
    description: 'Scan code for security vulnerabilities',
    nexusService: 'sandbox',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 20000, factor: 2 },
  },
  {
    taskIdentifier: 'sandbox-scheduled-security-scan',
    description: 'Daily scheduled security scan of all project code',
    nexusService: 'sandbox',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 120000, factor: 2 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'sandbox-pipeline',
    description: 'Execute a pipeline of code steps sequentially',
    nexusService: 'sandbox',
    retryConfig: { maxAttempts: 1 },
  },

  // ── Skills Engine (4) ─────────────────────────────────────────────
  ...SKILLS_ENGINE_TASKS,

  // ── Platform Knowledge (2) ────────────────────────────────────────
  ...PLATFORM_KNOWLEDGE_TASKS,

  // ── Platform Health Monitor (2) ─────────────────────────────────
  ...PLATFORM_HEALTH_TASKS,
];

/**
 * Convert a registry entry into UpsertTaskDefinitionData for a given org/project.
 */
export function toUpsertData(
  entry: TaskRegistryEntry,
  projectId: string,
  organizationId: string
): UpsertTaskDefinitionData {
  return {
    projectId,
    organizationId,
    taskIdentifier: entry.taskIdentifier,
    taskVersion: '1',
    description: entry.description,
    retryConfig: entry.retryConfig,
    queueName: entry.queueName,
    isNexusIntegration: true,
    nexusService: entry.nexusService,
  };
}
