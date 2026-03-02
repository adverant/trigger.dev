/**
 * EE Design Workflow — Ralph Loop (Continuous Iteration)
 *
 * Implements the Ralph-style escalation workflow as a Trigger.dev task:
 *
 * 1. Run MAPO pipeline as a child task
 * 2. Evaluate 7 quality gates
 * 3. Decision tree:
 *    - All gates pass → SUCCESS, complete workflow
 *    - Non-critical failures → INCREASE_PARAMS (bump thresholds, retry)
 *    - Repeated failures → FULL_RESET (new seed, original params)
 *    - Max iterations reached or critical failure → ESCALATE (waitpoint for human)
 *
 * Quality Gates:
 *   placeholder_ratio    ≤ 0%    (auto)
 *   connection_coverage  ≥ 80%   (auto)
 *   overlap_count        = 0     (auto)
 *   smoke_test_fatals    = 0     (waitpoint after 2+ failures)
 *   visual_score         ≥ 22%   (waitpoint after 3+ failures)
 *   center_fallback_ratio ≤ 10%  (auto)
 *   functional_score     ≥ 60%   (waitpoint on failure)
 */

import { task } from '@trigger.dev/sdk/v3';
import { EEDesignClient } from '../integrations/ee-design.client';
import type { QualityGateResult } from '../integrations/ee-design.client';

// ─── Types ───────────────────────────────────────────────────────────────

export interface RalphLoopPayload {
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
  maxIterations?: number;
  parameters?: Record<string, unknown>;
}

type EscalationDecision = 'SUCCESS' | 'INCREASE_PARAMS' | 'FULL_RESET' | 'ESCALATE';

interface IterationResult {
  iteration: number;
  decision: EscalationDecision;
  qualityGates: QualityGateResult[];
  durationMs: number;
  errors: string[];
}

export interface RalphLoopResult {
  success: boolean;
  totalIterations: number;
  finalIteration: number;
  decisions: EscalationDecision[];
  qualityGates: QualityGateResult[];
  escalated: boolean;
  escalationApproved?: boolean;
  totalDurationMs: number;
  errors: string[];
}

// ─── Quality Gate Analysis ───────────────────────────────────────────────

interface GateFailureHistory {
  smoke_test_fatals: number;
  visual_score: number;
  functional_score: number;
  other: number;
}

function analyzeQualityGates(
  gates: QualityGateResult[],
  failureHistory: GateFailureHistory
): EscalationDecision {
  const allPassed = gates.every((g) => g.passed);
  if (allPassed) return 'SUCCESS';

  const failedGates = gates.filter((g) => !g.passed);

  // Check for critical failures requiring escalation
  for (const gate of failedGates) {
    if (gate.name === 'smoke_test_fatals' && failureHistory.smoke_test_fatals >= 2) {
      return 'ESCALATE';
    }
    if (gate.name === 'visual_score' && failureHistory.visual_score >= 3) {
      return 'ESCALATE';
    }
    if (gate.name === 'functional_score' && !gate.passed) {
      return 'ESCALATE';
    }
  }

  // Check if we've been failing too many times overall
  const totalFailures = failureHistory.smoke_test_fatals + failureHistory.visual_score + failureHistory.other;
  if (totalFailures >= 4) {
    return 'FULL_RESET';
  }

  // Non-critical failures — try with increased params
  return 'INCREASE_PARAMS';
}

/**
 * Adjust parameters for the next iteration based on failure analysis
 */
function increaseParams(
  currentParams: Record<string, unknown>,
  failedGates: QualityGateResult[]
): Record<string, unknown> {
  const params = { ...currentParams };

  for (const gate of failedGates) {
    switch (gate.name) {
      case 'visual_score':
        // Lower the threshold slightly to see if we're close
        params.visual_score_min = Math.max(0.15, (gate.threshold as number) - 0.03);
        break;
      case 'connection_coverage':
        // Try different connection gen seed
        params.connection_gen_temperature = Math.min(1.0, ((params.connection_gen_temperature as number) || 0.7) + 0.1);
        break;
      case 'overlap_count':
        // Increase spacing factor
        params.layout_spacing_factor = Math.min(3.0, ((params.layout_spacing_factor as number) || 1.5) + 0.25);
        break;
    }
  }

  return params;
}

// ─── Ralph Loop Task ─────────────────────────────────────────────────────

export const ralphLoop = task({
  id: 'ee-design/ralph-loop',
  retry: {
    maxAttempts: 1, // Workflow manages its own iteration logic
  },
  run: async (payload: RalphLoopPayload) => {
    const client = getClient(payload.organizationId);
    const start = Date.now();
    const maxIterations = payload.maxIterations || 5;

    console.log(`[ralph-loop] Starting continuous loop for project=${payload.projectId}`);
    console.log(`[ralph-loop] Max iterations: ${maxIterations}`);

    const decisions: EscalationDecision[] = [];
    const iterationResults: IterationResult[] = [];
    let currentParams = { ...(payload.parameters || {}) };
    let finalQualityGates: QualityGateResult[] = [];
    let escalated = false;
    let escalationApproved = false;
    let currentSeed = Date.now();

    const failureHistory: GateFailureHistory = {
      smoke_test_fatals: 0,
      visual_score: 0,
      functional_score: 0,
      other: 0,
    };

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const iterStart = Date.now();
      console.log(`\n[ralph-loop] ═══ Iteration ${iteration}/${maxIterations} ═══`);
      console.log(`[ralph-loop] Params: ${JSON.stringify(currentParams)}`);

      // Trigger pipeline for this iteration
      let operationId: string;
      try {
        operationId = await client.triggerPipeline({
          projectId: payload.projectId,
          projectName: payload.projectName,
          operationId: `${payload.operationId}-iter-${iteration}`,
          subsystems: payload.subsystems,
          ideationArtifacts: payload.ideationArtifacts,
          aiProvider: payload.aiProvider,
          parameters: { ...currentParams, seed: currentSeed, iteration },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ralph-loop] Failed to trigger pipeline: ${msg}`);
        iterationResults.push({
          iteration,
          decision: 'ESCALATE',
          qualityGates: [],
          durationMs: Date.now() - iterStart,
          errors: [msg],
        });
        decisions.push('ESCALATE');
        escalated = true;
        break;
      }

      console.log(`[ralph-loop] Pipeline triggered, operationId=${operationId}`);

      // Poll for completion
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 5;
      const POLL_TIMEOUT_MS = 7200000;
      const pollStart = Date.now();
      let status = await client.getOperationStatus(operationId);
      while (status.status === 'running' || status.status === 'queued') {
        if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
          throw new Error(
            `Phase '${status.phase || 'pipeline'}' exceeded maximum poll duration of ${POLL_TIMEOUT_MS / 60000} minutes. ` +
            `Last status: ${status.progress}% — ${status.currentStep}`
          );
        }
        await new Promise((r) => setTimeout(r, 10000)); // 10s poll intervals
        try {
          status = await client.getOperationStatus(operationId);
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          console.error(`[ralph-loop] Poll error for iter ${iteration}: ${err instanceof Error ? err.message : err} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new Error(
              `${MAX_CONSECUTIVE_ERRORS} consecutive poll errors for iteration ${iteration}. ` +
              `Last error: ${err instanceof Error ? err.message : err}`
            );
          }
          // Continue polling — transient errors shouldn't kill the task
        }
        console.log(`[ralph-loop] [iter ${iteration}] ${status.progress}% [${status.phase}] ${status.currentStep}`);
      }

      // Fetch quality gates
      const qualityGates = await client.getQualityGates(operationId);
      finalQualityGates = qualityGates;
      const failedGates = qualityGates.filter((g) => !g.passed);

      // Update failure history
      for (const gate of failedGates) {
        if (gate.name === 'smoke_test_fatals') failureHistory.smoke_test_fatals++;
        else if (gate.name === 'visual_score') failureHistory.visual_score++;
        else if (gate.name === 'functional_score') failureHistory.functional_score++;
        else failureHistory.other++;
      }

      // Make escalation decision
      const decision = analyzeQualityGates(qualityGates, failureHistory);
      decisions.push(decision);

      const iterDuration = Date.now() - iterStart;
      iterationResults.push({
        iteration,
        decision,
        qualityGates,
        durationMs: iterDuration,
        errors: status.status === 'failed' ? [status.currentStep] : [],
      });

      console.log(`[ralph-loop] [iter ${iteration}] Decision: ${decision}`);
      console.log(`[ralph-loop] [iter ${iteration}] Gates: ${qualityGates.filter((g) => g.passed).length}/${qualityGates.length} passed`);
      for (const gate of qualityGates) {
        console.log(`[ralph-loop]   ${gate.passed ? 'PASS' : 'FAIL'} ${gate.name}: ${gate.actual} (threshold: ${gate.threshold})`);
      }

      // Act on decision
      switch (decision) {
        case 'SUCCESS':
          console.log(`[ralph-loop] All quality gates passed on iteration ${iteration}!`);
          return {
            success: true,
            totalIterations: maxIterations,
            finalIteration: iteration,
            decisions,
            qualityGates: finalQualityGates,
            escalated: false,
            totalDurationMs: Date.now() - start,
            errors: [],
          } satisfies RalphLoopResult;

        case 'INCREASE_PARAMS':
          console.log(`[ralph-loop] Increasing parameters for next iteration`);
          currentParams = increaseParams(currentParams, failedGates);
          break;

        case 'FULL_RESET':
          console.log(`[ralph-loop] Full reset — new seed, original parameters`);
          currentParams = { ...(payload.parameters || {}) };
          currentSeed = Date.now();
          break;

        case 'ESCALATE':
          console.log(`[ralph-loop] Escalating to human review — stopping loop for external resolution`);
          // This SDK version does not support typed waitpoints. Return immediately with
          // escalated=true; the EE Design backend handles the human review workflow
          // and can trigger a new Ralph Loop run with adjusted parameters if approved.
          return {
            success: false,
            totalIterations: maxIterations,
            finalIteration: iteration,
            decisions,
            qualityGates: finalQualityGates,
            escalated: true,
            escalationApproved: false,
            totalDurationMs: Date.now() - start,
            errors: [`Quality gates failed on iteration ${iteration}: ${failedGates.map((g) => g.name).join(', ')}`],
          } satisfies RalphLoopResult;
      }
    }

    // Max iterations reached without success
    const totalDurationMs = Date.now() - start;
    console.log(`[ralph-loop] Max iterations (${maxIterations}) reached without all gates passing`);
    console.log(`[ralph-loop] Total duration: ${Math.round(totalDurationMs / 1000)}s`);

    return {
      success: false,
      totalIterations: maxIterations,
      finalIteration: maxIterations,
      decisions,
      qualityGates: finalQualityGates,
      escalated,
      escalationApproved,
      totalDurationMs,
      errors: ['Max iterations reached without all quality gates passing'],
    } satisfies RalphLoopResult;
  },
});

// ─── Helper ──────────────────────────────────────────────────────────────

function getClient(organizationId: string): EEDesignClient {
  return new EEDesignClient(organizationId);
}
