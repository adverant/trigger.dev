/**
 * EE Design Task Definitions
 *
 * Trigger.dev tasks for EE Design Partner MAPO pipeline phases:
 * - resolveSymbols:        Fetch KiCad symbols from libraries
 * - generateConnections:   LLM-generated net connections (30-80 min)
 * - optimizeLayout:        Graph centrality + AABB collision layout
 * - routeWires:            Wire routing between components
 * - assembleSchematic:     Assemble final .kicad_sch file
 * - smokeTest:             Electrical rule check (power, shorts, etc.)
 * - visualValidate:        AI visual quality assessment of schematic image
 * - exportArtifacts:       Export BOM, netlist, schematic archives
 *
 * Each task wraps the corresponding Python pipeline phase, forwarding
 * PROGRESS: lines as structured run logs and handling failures with retry.
 */

import { task } from '@trigger.dev/sdk/v3';
import { EEDesignClient } from '../integrations/ee-design.client';
import type { QualityGateResult, MAPOPhaseResult } from '../integrations/ee-design.client';

// ─── Helpers ─────────────────────────────────────────────────────────────

function getClient(organizationId: string): EEDesignClient {
  return new EEDesignClient(organizationId);
}

// ─── Payload / Result Interfaces ─────────────────────────────────────────

export interface MAPOPhasePayload {
  organizationId: string;
  projectId: string;
  projectName: string;
  operationId: string;
  subsystems: Array<{
    id: string;
    name: string;
    category: string;
    description?: string;
  }>;
  ideationArtifacts?: Array<{
    artifact_type: string;
    category: string;
    name: string;
    content: string;
    subsystem_ids?: string[];
  }>;
  aiProvider?: string;
  parameters?: Record<string, unknown>;
  iteration?: number;
}

export interface MAPOPipelinePayload extends MAPOPhasePayload {
  resumeFromCheckpoint?: boolean;
  maxIterations?: number;
}

export interface MAPOPipelineResult {
  operationId: string;
  success: boolean;
  schematicPath?: string;
  bomPath?: string;
  qualityGates: QualityGateResult[];
  phaseResults: MAPOPhaseResult[];
  totalDurationMs: number;
  iteration: number;
  errors: string[];
  warnings: string[];
}

// ─── Individual Phase Tasks ──────────────────────────────────────────────

export const resolveSymbols = task({
  id: 'ee-design/resolve-symbols',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Resolving symbols for project=${payload.projectId}, subsystems=${payload.subsystems.length}`);

    // Trigger the pipeline which starts with symbol resolution
    const operationId = await client.triggerPipeline({
      projectId: payload.projectId,
      projectName: payload.projectName,
      operationId: payload.operationId,
      subsystems: payload.subsystems,
      ideationArtifacts: payload.ideationArtifacts,
      aiProvider: payload.aiProvider,
      parameters: payload.parameters,
    });

    console.log(`[ee-design] Symbol resolution started, operationId=${operationId}`);

    // Poll for phase completion
    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(operationId);
    while (status.phase === 'symbols' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'symbols' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 3000));
      try {
        status = await client.getOperationStatus(operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for symbols: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Symbol resolution progress: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    console.log(`[ee-design] Symbol resolution complete in ${durationMs}ms`);

    return {
      operationId,
      phase: 'symbols',
      success: status.status !== 'failed',
      durationMs,
      progress: status.progress,
      currentStep: status.currentStep,
    };
  },
});

export const generateConnections = task({
  id: 'ee-design/generate-connections',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 600000, // 10 min max retry timeout (connection gen takes 2-10 min)
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Generating connections for project=${payload.projectId}`);
    console.log(`[ee-design] Using AI provider: ${payload.aiProvider || 'claude_code_max'}`);

    // Poll operation for connection generation phase
    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (
      (status.phase === 'connections' || status.phase === 'symbols') &&
      status.status === 'running'
    ) {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'connections' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 10000)); // 10s intervals (LLM calls are slow)
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for connections: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Connection gen progress: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    console.log(`[ee-design] Connection generation complete in ${Math.round(durationMs / 1000)}s`);

    return {
      operationId: payload.operationId,
      phase: 'connections',
      success: status.status !== 'failed',
      durationMs,
      progress: status.progress,
      currentStep: status.currentStep,
    };
  },
});

export const optimizeLayout = task({
  id: 'ee-design/optimize-layout',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Optimizing layout for project=${payload.projectId}`);

    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (status.phase === 'layout' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'layout' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 3000));
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for layout: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Layout optimization: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    console.log(`[ee-design] Layout optimization complete in ${durationMs}ms`);

    return {
      operationId: payload.operationId,
      phase: 'layout',
      success: status.status !== 'failed',
      durationMs,
    };
  },
});

export const routeWires = task({
  id: 'ee-design/route-wires',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Routing wires for project=${payload.projectId}`);

    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (status.phase === 'wiring' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'wiring' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for wiring: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Wire routing: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    console.log(`[ee-design] Wire routing complete in ${durationMs}ms`);

    return {
      operationId: payload.operationId,
      phase: 'wiring',
      success: status.status !== 'failed',
      durationMs,
    };
  },
});

export const assembleSchematic = task({
  id: 'ee-design/assemble-schematic',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Assembling schematic for project=${payload.projectId}`);

    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (status.phase === 'assembly' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'assembly' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for assembly: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Assembly: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    console.log(`[ee-design] Schematic assembly complete in ${durationMs}ms`);

    return {
      operationId: payload.operationId,
      phase: 'assembly',
      success: status.status !== 'failed',
      durationMs,
    };
  },
});

export const smokeTest = task({
  id: 'ee-design/smoke-test',
  retry: {
    maxAttempts: 1, // No retry — smoke test results are deterministic
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Running smoke test for project=${payload.projectId}`);

    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (status.phase === 'smoke_test' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'smoke_test' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for smoke_test: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Smoke test: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    const qualityGates = status.qualityGates || [];
    const fatalCount = qualityGates
      .filter((g) => g.name === 'smoke_test_fatals' && !g.passed)
      .length;

    console.log(`[ee-design] Smoke test complete in ${durationMs}ms, fatals=${fatalCount}`);

    return {
      operationId: payload.operationId,
      phase: 'smoke_test',
      success: fatalCount === 0,
      durationMs,
      qualityGates,
      fatalCount,
    };
  },
});

export const visualValidate = task({
  id: 'ee-design/visual-validate',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Running visual validation for project=${payload.projectId}`);

    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (status.phase === 'visual_validation' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'visual_validation' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for visual_validation: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Visual validation: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    const qualityGates = status.qualityGates || [];
    const visualGate = qualityGates.find((g) => g.name === 'visual_score');

    console.log(`[ee-design] Visual validation complete in ${durationMs}ms, score=${visualGate?.actual ?? 'N/A'}`);

    return {
      operationId: payload.operationId,
      phase: 'visual_validation',
      success: visualGate?.passed ?? true,
      durationMs,
      qualityGates,
      visualScore: visualGate?.actual,
    };
  },
});

export const exportArtifacts = task({
  id: 'ee-design/export-artifacts',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: MAPOPhasePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Exporting artifacts for project=${payload.projectId}`);

    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(payload.operationId);
    while (status.phase === 'export' && status.status === 'running') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase 'export' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        status = await client.getOperationStatus(payload.operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for export: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }
      console.log(`[ee-design] Export: ${status.progress}% — ${status.currentStep}`);
    }

    const durationMs = Date.now() - start;
    console.log(`[ee-design] Export complete in ${durationMs}ms`);

    return {
      operationId: payload.operationId,
      phase: 'export',
      success: status.status !== 'failed',
      durationMs,
    };
  },
});

// ─── Full Pipeline Task ──────────────────────────────────────────────────

/**
 * Full MAPO pipeline as a single Trigger.dev task.
 * Triggers the Python pipeline via the EE Design API and polls for completion.
 * Quality gate failures at iteration thresholds create waitpoints.
 */
export const mapoPipeline = task({
  id: 'ee-design/mapo-pipeline',
  retry: {
    maxAttempts: 1, // Pipeline manages its own retry logic via Ralph loop
  },
  run: async (payload: MAPOPipelinePayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();

    console.log(`[ee-design] Starting MAPO pipeline for project=${payload.projectId}`);
    console.log(`[ee-design] Subsystems: ${payload.subsystems.map((s) => s.name).join(', ')}`);
    console.log(`[ee-design] AI Provider: ${payload.aiProvider || 'claude_code_max'}`);

    // Trigger the full pipeline
    const operationId = await client.triggerPipeline({
      projectId: payload.projectId,
      projectName: payload.projectName,
      operationId: payload.operationId,
      subsystems: payload.subsystems,
      ideationArtifacts: payload.ideationArtifacts,
      aiProvider: payload.aiProvider,
      resumeFromCheckpoint: payload.resumeFromCheckpoint,
      parameters: payload.parameters,
    });

    console.log(`[ee-design] Pipeline started, operationId=${operationId}`);

    // Poll until completion
    const MAX_POLL_MS = 7200000; // 2 hours
    const pollStart = Date.now();
    let status = await client.getOperationStatus(operationId);
    let lastPhase = '';

    while (status.status === 'running' || status.status === 'queued') {
      if (Date.now() - pollStart > MAX_POLL_MS) {
        throw new Error(
          `Phase '${status.phase || 'pipeline'}' exceeded maximum poll duration of ${MAX_POLL_MS / 60000} minutes. ` +
          `Last status: ${status.progress}% — ${status.currentStep}`
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
      try {
        status = await client.getOperationStatus(operationId);
      } catch (err) {
        console.error(`[ee-design] Poll error for ${status.phase || 'pipeline'}: ${err instanceof Error ? err.message : err}`);
        // Continue polling — transient errors shouldn't kill the task
      }

      // Log phase transitions
      if (status.phase && status.phase !== lastPhase) {
        console.log(`[ee-design] Phase transition: ${lastPhase || 'init'} → ${status.phase}`);
        lastPhase = status.phase;
      }

      console.log(`[ee-design] Pipeline progress: ${status.progress}% [${status.phase}] ${status.currentStep}`);
    }

    const totalDurationMs = Date.now() - start;
    const qualityGates = await client.getQualityGates(operationId);

    const allPassed = qualityGates.every((g) => g.passed);
    console.log(
      `[ee-design] Pipeline ${allPassed ? 'PASSED' : 'FAILED'} in ${Math.round(totalDurationMs / 1000)}s — ` +
      `${qualityGates.filter((g) => g.passed).length}/${qualityGates.length} gates passed`
    );

    return {
      operationId,
      success: status.status === 'completed' && allPassed,
      qualityGates,
      phaseResults: [],
      totalDurationMs,
      iteration: payload.iteration || 1,
      errors: status.status === 'failed' ? [status.currentStep] : [],
      warnings: qualityGates.filter((g) => !g.passed && !g.critical).map((g) => `${g.name}: ${g.actual} (required: ${g.threshold})`),
    } satisfies MAPOPipelineResult;
  },
});
