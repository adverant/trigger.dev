/**
 * ProseCreator Task Definitions
 *
 * Trigger.dev tasks for the ProseCreator creative writing platform:
 * - prosecreatorGenerateBlueprint: Generate a living blueprint from an outline
 * - prosecreatorGenerateChapters: Generate chapters from a blueprint
 * - prosecreatorCharacterAnalysis: Deep character development analysis
 * - prosecreatorContinuityAudit: Cross-chapter continuity checking
 * - prosecreatorCNESAudit: Full CNES (Narrative, Emotional, Structural) audit
 * - prosecreatorQualityAssessment: Manuscript quality scoring
 * - prosecreatorAIDetectionScan: Scan writing for AI-generated content
 * - prosecreatorExportPipeline: Multi-format export (DOCX, EPUB, PDF)
 * - prosecreatorSeriesIntelligenceSync: Cross-book series consistency analysis
 * - prosecreatorDeepInsightGeneration: Semantic-level writing insights
 * - prosecreatorPanelAnalysis: Inspector panel LLM analysis via Claude Code Max proxy
 * - prosecreatorNovelImport: Import a completed novel — parse chapters, extract characters, identify plot threads
 *
 * Full Ingestion Pipeline tasks (8):
 * - prosecreatorFullIngestAnalyze: Analyze imported document structure and content
 * - prosecreatorFullIngestCharacters: Extract and create character profiles from imported text
 * - prosecreatorFullIngestStructure: Parse and create chapter/beat structure from imported text
 * - prosecreatorFullIngestWorld: Extract world-building elements (locations, systems, rules)
 * - prosecreatorFullIngestTropes: Identify literary tropes and narrative patterns
 * - prosecreatorFullIngestBlueprint: Generate a living blueprint from ingested content
 * - prosecreatorFullIngestConstitution: Generate project constitution from ingested content
 * - prosecreatorFullIngestAnalysis: Run comprehensive quality analysis on ingested project
 */

import { task } from '@trigger.dev/sdk/v3';
import { ProseCreatorClient } from '../integrations/prosecreator.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): ProseCreatorClient {
  return new ProseCreatorClient(organizationId);
}

const DEFAULT_N8N_INSTANCE_ID = process.env.DEFAULT_N8N_INSTANCE_ID || '';

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface ProseCreatorWorkflowPayload {
  organizationId: string;
  projectId: string;
  userId: string;
  n8nInstanceId?: string;
  inputData?: Record<string, unknown>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface ProseCreatorSeriesPayload {
  organizationId: string;
  seriesId: string;
  userId: string;
  n8nInstanceId?: string;
  inputData?: Record<string, unknown>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface ProseCreatorExportPayload {
  organizationId: string;
  projectId: string;
  userId: string;
  formats?: Array<'docx' | 'epub' | 'pdf'>;
  n8nInstanceId?: string;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface ProseCreatorWorkflowResult {
  executionId: string;
  templateKey: string;
  status: string;
  wasDeployed: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Shared workflow execution logic
// ---------------------------------------------------------------------------

async function executeProseCreatorWorkflow(
  client: ProseCreatorClient,
  templateKey: string,
  payload: {
    projectId: string;
    userId: string;
    n8nInstanceId?: string;
    inputData?: Record<string, unknown>;
    waitForCompletion?: boolean;
    timeoutMs?: number;
  }
): Promise<ProseCreatorWorkflowResult> {
  const startTime = Date.now();
  const n8nInstanceId = payload.n8nInstanceId || DEFAULT_N8N_INSTANCE_ID;
  const waitForCompletion = payload.waitForCompletion ?? false;
  const timeoutMs = payload.timeoutMs ?? 300000; // 5 min default

  console.log(
    `[prosecreator] Executing workflow: template=${templateKey}, project=${payload.projectId}, wait=${waitForCompletion}`
  );

  // Step 1: Resolve or deploy binding
  const { bindingId, wasDeployed } = await client.resolveBindingForTemplate(
    payload.projectId,
    templateKey,
    n8nInstanceId,
    payload.userId
  );

  if (wasDeployed) {
    console.log(`[prosecreator] Deployed template ${templateKey} for project ${payload.projectId}`);
  }

  // Step 2: Execute the workflow
  const execResult = await client.executeWorkflow(
    bindingId,
    {
      projectId: payload.projectId,
      userId: payload.userId,
      ...payload.inputData,
    },
    payload.userId
  );

  console.log(
    `[prosecreator] Workflow triggered: executionId=${execResult.executionId}, status=${execResult.status}`
  );

  if (!waitForCompletion) {
    return {
      executionId: execResult.executionId,
      templateKey,
      status: execResult.status,
      wasDeployed,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 3: Poll for completion
  console.log(`[prosecreator] Waiting for completion (timeout=${timeoutMs}ms)`);
  const pollIntervalMs = 3000;
  const pollStart = Date.now();

  let lastStatus = execResult.status;
  while (
    (lastStatus === 'queued' || lastStatus === 'running') &&
    Date.now() - pollStart < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const jobStatus = await client.getJobStatus(execResult.executionId);
      lastStatus = jobStatus.status;

      if (lastStatus === 'completed' || lastStatus === 'failed') {
        const durationMs = Date.now() - startTime;
        console.log(
          `[prosecreator] Workflow ${templateKey} ${lastStatus}: duration=${durationMs}ms`
        );
        return {
          executionId: execResult.executionId,
          templateKey,
          status: lastStatus,
          wasDeployed,
          result: jobStatus.result,
          error: jobStatus.error,
          durationMs,
        };
      }
    } catch {
      // Poll failure is not fatal, keep trying
      console.warn(`[prosecreator] Poll failed for ${execResult.executionId}, retrying...`);
    }
  }

  const durationMs = Date.now() - startTime;
  if (lastStatus === 'queued' || lastStatus === 'running') {
    console.warn(`[prosecreator] Workflow ${templateKey} timed out after ${timeoutMs}ms`);
    return {
      executionId: execResult.executionId,
      templateKey,
      status: 'timeout',
      wasDeployed,
      durationMs,
    };
  }

  return {
    executionId: execResult.executionId,
    templateKey,
    status: lastStatus,
    wasDeployed,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const prosecreatorGenerateBlueprint = task({
  id: 'prosecreator-generate-blueprint',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'outline-to-blueprint', payload);
  },
});

export const prosecreatorGenerateChapters = task({
  id: 'prosecreator-generate-chapters',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'blueprint-to-manuscript', {
      ...payload,
      timeoutMs: payload.timeoutMs ?? 600000, // 10 min for full manuscript
    });
  },
});

export const prosecreatorCharacterAnalysis = task({
  id: 'prosecreator-character-analysis',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'character-development', payload);
  },
});

export const prosecreatorContinuityAudit = task({
  id: 'prosecreator-continuity-audit',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'continuity-audit', payload);
  },
});

export const prosecreatorCNESAudit = task({
  id: 'prosecreator-cnes-audit',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'cnes-full-audit', {
      ...payload,
      timeoutMs: payload.timeoutMs ?? 600000, // 10 min for full audit
    });
  },
});

export const prosecreatorQualityAssessment = task({
  id: 'prosecreator-quality-assessment',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'quality-assessment', payload);
  },
});

export const prosecreatorAIDetectionScan = task({
  id: 'prosecreator-ai-detection-scan',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'ai-detection-scan', payload);
  },
});

export const prosecreatorExportPipeline = task({
  id: 'prosecreator-export-pipeline',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ProseCreatorExportPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'export-pipeline', {
      projectId: payload.projectId,
      userId: payload.userId,
      n8nInstanceId: payload.n8nInstanceId,
      waitForCompletion: payload.waitForCompletion,
      timeoutMs: payload.timeoutMs,
      inputData: {
        formats: payload.formats || ['docx', 'epub', 'pdf'],
      },
    });
  },
});

export const prosecreatorSeriesIntelligenceSync = task({
  id: 'prosecreator-series-intelligence-sync',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: ProseCreatorSeriesPayload) => {
    const client = getClient(payload.organizationId);

    // Series tasks use seriesId instead of projectId in the input
    return executeProseCreatorWorkflow(client, 'series-intelligence-sync', {
      projectId: payload.seriesId, // Binding resolved at series level
      userId: payload.userId,
      n8nInstanceId: payload.n8nInstanceId,
      waitForCompletion: payload.waitForCompletion,
      timeoutMs: payload.timeoutMs ?? 600000,
      inputData: {
        seriesId: payload.seriesId,
        ...payload.inputData,
      },
    });
  },
});

export const prosecreatorDeepInsightGeneration = task({
  id: 'prosecreator-deep-insight-generation',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'deep-insight-generation', payload);
  },
});

// ---------------------------------------------------------------------------
// Inspector Panel Analysis — generic LLM call via Claude Code Max proxy
// ---------------------------------------------------------------------------

export interface PanelAnalysisPayload {
  organizationId: string;
  analysisType: string;
  systemMessage: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface PanelAnalysisResult {
  content: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  analysisType: string;
  durationMs: number;
}

/**
 * Generic inspector panel analysis task.
 * Receives a fully-built prompt and calls Claude Code Max proxy
 * (flat rate, unlimited) instead of MageAgent or OpenRouter.
 */
export const prosecreatorPanelAnalysis = task({
  id: 'prosecreator-panel-analysis',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 600000,
    factor: 2,
  },
  run: async (payload: PanelAnalysisPayload): Promise<PanelAnalysisResult> => {
    const startTime = Date.now();
    const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || 'http://claude-code-proxy:3100';

    console.log(
      `[prosecreator] Panel analysis: type=${payload.analysisType}, promptLen=${payload.prompt.length}`
    );

    const controller = new AbortController();
    // Scale timeout with maxTokens — insight_resolve sends 32k tokens, needs more time
    const fetchTimeoutMs = (payload.maxTokens || 8000) > 16000 ? 480000 : 150000;
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

    try {
      const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          messages: [
            { role: 'system', content: payload.systemMessage },
            { role: 'user', content: payload.prompt },
          ],
          max_tokens: payload.maxTokens || 8000,
          temperature: payload.temperature || 0.3,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Claude Code Max proxy error ${res.status}: ${errText.slice(0, 300)}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any;
      const durationMs = Date.now() - startTime;

      const extractedContent = data.choices?.[0]?.message?.content || '';
      console.log(
        `[prosecreator] Panel analysis complete: type=${payload.analysisType}, duration=${durationMs}ms, model=${data.model || 'unknown'}, contentLen=${extractedContent.length}, hasChoices=${!!data.choices}, choicesLen=${data.choices?.length || 0}, finishReason=${data.choices?.[0]?.finish_reason || 'none'}, contentPreview=${extractedContent.slice(0, 200)}`
      );

      return {
        content: extractedContent,
        model: data.model || 'unknown',
        usage: data.usage || {},
        analysisType: payload.analysisType,
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});

// ---------------------------------------------------------------------------
// Novel Import — parse a completed novel into structured project data
// ---------------------------------------------------------------------------

export interface NovelImportPayload {
  organizationId: string;
  documentId: string;
  extractedContent: string;
  originalFilename: string;
  projectTitle?: string;
  genre?: string;
  format?: string;
}

interface ChapterSegment {
  chapter_number: number;
  title: string | null;
  content: string;
  word_count: number;
}

interface ChapterAnalysis {
  chapter_number: number;
  title: string | null;
  synopsis: string;
  pov_character: string | null;
  content: string;
  word_count: number;
  beats: Array<{
    beat_number: number;
    beat_type: string;
    content: string;
    word_count: number;
  }>;
  characters_mentioned: Array<{
    name: string;
    role_hint: string;
    actions: string;
  }>;
  plot_developments: string[];
}

export interface NovelImportResult {
  chapters: ChapterAnalysis[];
  characters: Array<{
    character_name: string;
    role: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
    backstory: string;
    motivations: string;
    personality_traits: string;
    speaking_style: string;
    age_range: string | null;
    aliases: string[];
  }>;
  plot_threads: Array<{
    name: string;
    description: string;
    importance: 'primary' | 'secondary' | 'tertiary';
    thread_type: string;
    characters_involved: string[];
    introduced_chapter: number;
    resolved_chapter: number | null;
    status: string;
  }>;
  metadata: {
    total_words: number;
    chapters_detected: number;
    characters_found: number;
    plot_threads_found: number;
    processing_time_ms: number;
  };
}

// Chapter heading detection patterns (duplicated from NovelParserService — runs in separate process)
const CHAPTER_HEADING_PATTERNS: RegExp[] = [
  /^(?:chapter)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)(?:\s*[:.\-—]\s*(.+))?$/i,
  /^CHAPTER\s+(?:\d+|[IVXLC]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY|FORTY|FIFTY)(?:\s*[:.\-—]\s*(.+))?$/,
  /^(?:part)\s+(?:\d+|[IVXLC]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*[:.\-—]\s*(.+))?$/i,
  /^BOOK\s+(?:\d+|[IVXLC]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN)(?:\s*[:.\-—]\s*(.+))?$/i,
  /^ACT\s+(?:\d+|[IVXLC]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT)(?:\s*[:.\-—]\s*(.+))?$/i,
  /^[IVXLC]+\.?$/,
  /^\d{1,3}[.):]?\s*$/,
];

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

function romanToNum(roman: string): number {
  const m: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let r = 0;
  const u = roman.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    const cur = m[u[i]] || 0;
    const nxt = i + 1 < u.length ? (m[u[i + 1]] || 0) : 0;
    r += cur < nxt ? -cur : cur;
  }
  return r;
}

function extractNum(line: string): number | null {
  const nm = line.match(/\b(\d+)\b/);
  if (nm) return parseInt(nm[1], 10);
  const rm = line.match(/\b([IVXLC]+)\b/i);
  if (rm) { const n = romanToNum(rm[1]); if (n > 0 && n < 200) return n; }
  const lw = line.toLowerCase();
  for (const [w, n] of Object.entries(WORD_NUMBERS)) { if (lw.includes(w)) return n; }
  return null;
}

function isHeading(line: string): { is: boolean; title: string | null } {
  const t = line.trim();
  if (!t || t.length > 200) return { is: false, title: null };
  for (const p of CHAPTER_HEADING_PATTERNS) {
    const m = t.match(p);
    if (m) return { is: true, title: m[1]?.trim() || null };
  }
  if (t === t.toUpperCase() && t.length > 2 && t.length < 80 && /[A-Z]/.test(t)) {
    const ratio = (t.match(/[A-Z]/g) || []).length / t.length;
    if (ratio > 0.5) return { is: true, title: t };
  }
  return { is: false, title: null };
}

function splitChapters(text: string): ChapterSegment[] {
  const lines = text.split('\n');
  const breaks: Array<{ lineIndex: number; title: string | null }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const prev = i > 0 ? lines[i - 1].trim() : '';
    const result = isHeading(line);
    if (result.is && (!prev || i === 0)) {
      breaks.push({ lineIndex: i, title: result.title });
    }
  }

  // Fallback: split every ~5000 words
  if (breaks.length < 2) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const segs: ChapterSegment[] = [];
    for (let i = 0; i < words.length; i += 5000) {
      const chunk = words.slice(i, i + 5000);
      segs.push({
        chapter_number: Math.floor(i / 5000) + 1,
        title: null,
        content: chunk.join(' '),
        word_count: chunk.length,
      });
    }
    return segs;
  }

  const chapters: ChapterSegment[] = [];
  // Prologue
  if (breaks[0].lineIndex > 0) {
    const pro = lines.slice(0, breaks[0].lineIndex).join('\n').trim();
    const wc = pro.split(/\s+/).filter(w => w.length > 0).length;
    if (wc > 100) {
      chapters.push({ chapter_number: 0, title: 'Prologue', content: pro, word_count: wc });
    }
  }
  for (let i = 0; i < breaks.length; i++) {
    const start = breaks[i].lineIndex;
    const end = i + 1 < breaks.length ? breaks[i + 1].lineIndex : lines.length;
    const content = lines.slice(start + 1, end).join('\n').trim();
    const wc = content.split(/\s+/).filter(w => w.length > 0).length;
    chapters.push({
      chapter_number: extractNum(lines[start]) || (i + 1),
      title: breaks[i].title,
      content,
      word_count: wc,
    });
  }
  return chapters;
}

async function callLLM(
  proxyUrl: string,
  systemMessage: string,
  userMessage: string,
  maxTokens: number = 8000,
  retries: number = 2
): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180000); // 3 min
      try {
        const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-6',
            messages: [
              { role: 'system', content: systemMessage },
              { role: 'user', content: userMessage },
            ],
            max_tokens: maxTokens,
            temperature: 0.2,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(`Proxy error ${res.status}: ${errText.slice(0, 200)}`);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content || '';
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[novel-import] LLM call attempt ${attempt + 1} failed, retrying in ${(attempt + 1) * 5}s...`);
      await new Promise(r => setTimeout(r, (attempt + 1) * 5000));
    }
  }
  throw new Error('LLM call exhausted retries');
}

function parseJsonFromLLM(text: string): unknown {
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

const CHAPTER_ANALYSIS_SYSTEM = `You are a literary analyst. You analyze novel chapters and extract structured data.
Always respond with valid JSON only — no markdown, no explanations outside the JSON.`;

function buildChapterPrompt(chapter: ChapterSegment, chapterCount: number): string {
  // Truncate very long chapters to ~48K chars (~12K words) for LLM context
  const maxChars = 48000;
  const content = chapter.content.length > maxChars
    ? chapter.content.slice(0, maxChars) + '\n\n[... content truncated for analysis ...]'
    : chapter.content;

  return `Analyze chapter ${chapter.chapter_number} of ${chapterCount} (${chapter.word_count} words).
${chapter.title ? `Chapter title: "${chapter.title}"` : ''}

Extract the following as JSON:
{
  "synopsis": "2-3 sentence synopsis of this chapter",
  "pov_character": "name of the POV character or null if omniscient",
  "beats": [
    {
      "beat_number": 1,
      "beat_type": "scene|transition|flashback|action|dialogue|reflection|revelation",
      "synopsis": "1 sentence describing this scene/beat",
      "start_paragraph": 1,
      "approximate_word_count": 1200
    }
  ],
  "characters_mentioned": [
    {
      "name": "full character name as it appears",
      "role_hint": "protagonist|antagonist|supporting|minor|mentioned",
      "actions": "brief summary of what this character does in this chapter"
    }
  ],
  "plot_developments": ["key plot point 1", "key plot point 2"]
}

Rules for beat segmentation:
- Create a new beat at: setting changes, significant time jumps, POV shifts, or major dramatic tension shifts
- Target ~1000-1500 words per beat
- Each beat should be a self-contained scene or moment

CHAPTER TEXT:
${content}`;
}

const SYNTHESIS_SYSTEM = `You are a literary analyst performing cross-chapter synthesis.
Deduplicate characters, identify plot arcs, and classify relationships.
Always respond with valid JSON only.`;

function buildSynthesisPrompt(
  chapterAnalyses: ChapterAnalysis[],
  originalFilename: string
): string {
  // Build compact summaries
  const charSummaries = new Map<string, { chapters: number[]; roles: string[]; actions: string[] }>();
  const plotPoints: Array<{ chapter: number; point: string }> = [];

  for (const ch of chapterAnalyses) {
    for (const c of ch.characters_mentioned) {
      const existing = charSummaries.get(c.name) || { chapters: [], roles: [], actions: [] };
      existing.chapters.push(ch.chapter_number);
      existing.roles.push(c.role_hint);
      existing.actions.push(c.actions);
      charSummaries.set(c.name, existing);
    }
    for (const p of ch.plot_developments) {
      plotPoints.push({ chapter: ch.chapter_number, point: p });
    }
  }

  const charList = Array.from(charSummaries.entries())
    .map(([name, data]) => `- ${name}: appears in chapters [${data.chapters.join(',')}], roles=[${[...new Set(data.roles)].join(',')}], key actions: ${data.actions.slice(0, 3).join('; ')}`)
    .join('\n');

  const plotList = plotPoints
    .map(p => `- Ch${p.chapter}: ${p.point}`)
    .join('\n');

  return `Novel: "${originalFilename}"
Total chapters: ${chapterAnalyses.length}
Total words: ${chapterAnalyses.reduce((s, c) => s + c.word_count, 0)}

CHARACTER MENTIONS (may contain duplicates/aliases):
${charList}

PLOT DEVELOPMENTS BY CHAPTER:
${plotList}

Synthesize into JSON:
{
  "characters": [
    {
      "character_name": "canonical full name",
      "role": "protagonist|antagonist|supporting|minor",
      "backstory": "inferred backstory from text (2-3 sentences)",
      "motivations": "character motivations (1-2 sentences)",
      "personality_traits": "comma-separated traits",
      "speaking_style": "description of how they speak",
      "age_range": "approximate age or null",
      "aliases": ["other names/nicknames used in the text"]
    }
  ],
  "plot_threads": [
    {
      "name": "descriptive thread name",
      "description": "what this thread is about (1-2 sentences)",
      "importance": "primary|secondary|tertiary",
      "thread_type": "main_plot|subplot|romance|mystery|character_arc|theme",
      "characters_involved": ["character names"],
      "introduced_chapter": 1,
      "resolved_chapter": null,
      "status": "active|resolved|abandoned|cliffhanger"
    }
  ]
}

Rules:
- Deduplicate characters: merge "Tom" / "Thomas" / "Mr. Smith" into one entry with aliases
- Classify at most 2 protagonists and 2 antagonists
- Identify 3-8 plot threads (primary threads must span multiple chapters)
- Use canonical names consistently`;
}

export const prosecreatorNovelImport = task({
  id: 'prosecreator-novel-import',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10000,
    maxTimeoutInMs: 1800000, // 30 min
    factor: 2,
  },
  run: async (payload: NovelImportPayload): Promise<NovelImportResult> => {
    const startTime = Date.now();
    const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || 'http://claude-code-proxy:3100';

    console.log(
      `[novel-import] Starting: doc=${payload.documentId}, file=${payload.originalFilename}, contentLen=${payload.extractedContent.length}`
    );

    // Pass 1: Structural chapter splitting (regex, no LLM)
    console.log('[novel-import] Pass 1: Splitting chapters...');
    const chapters = splitChapters(payload.extractedContent);
    console.log(`[novel-import] Detected ${chapters.length} chapters`);

    // Pass 2: Per-chapter LLM analysis (sequential)
    console.log('[novel-import] Pass 2: Analyzing chapters sequentially...');
    const chapterAnalyses: ChapterAnalysis[] = [];

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      console.log(`[novel-import] Analyzing chapter ${i + 1}/${chapters.length} (${ch.word_count} words)...`);

      try {
        const prompt = buildChapterPrompt(ch, chapters.length);
        const response = await callLLM(proxyUrl, CHAPTER_ANALYSIS_SYSTEM, prompt, 8000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = parseJsonFromLLM(response) as any;

        // Build beat content by splitting chapter content
        const beats: ChapterAnalysis['beats'] = [];
        if (parsed.beats && Array.isArray(parsed.beats)) {
          const totalBeats = parsed.beats.length;
          const wordsPerBeat = Math.ceil(ch.word_count / totalBeats);
          const words = ch.content.split(/\s+/);

          for (let b = 0; b < totalBeats; b++) {
            const startIdx = b * wordsPerBeat;
            const endIdx = Math.min((b + 1) * wordsPerBeat, words.length);
            const beatContent = words.slice(startIdx, endIdx).join(' ');

            beats.push({
              beat_number: b + 1,
              beat_type: parsed.beats[b]?.beat_type || 'scene',
              content: beatContent,
              word_count: endIdx - startIdx,
            });
          }
        } else {
          // Fallback: single beat for the whole chapter
          beats.push({
            beat_number: 1,
            beat_type: 'scene',
            content: ch.content,
            word_count: ch.word_count,
          });
        }

        chapterAnalyses.push({
          chapter_number: ch.chapter_number,
          title: ch.title || parsed.title || null,
          synopsis: parsed.synopsis || '',
          pov_character: parsed.pov_character || null,
          content: ch.content,
          word_count: ch.word_count,
          beats,
          characters_mentioned: parsed.characters_mentioned || [],
          plot_developments: parsed.plot_developments || [],
        });
      } catch (err) {
        console.error(`[novel-import] Chapter ${i + 1} analysis failed:`, err);
        // Continue with raw chapter data on failure
        chapterAnalyses.push({
          chapter_number: ch.chapter_number,
          title: ch.title,
          synopsis: '',
          pov_character: null,
          content: ch.content,
          word_count: ch.word_count,
          beats: [{
            beat_number: 1,
            beat_type: 'scene',
            content: ch.content,
            word_count: ch.word_count,
          }],
          characters_mentioned: [],
          plot_developments: [],
        });
      }
    }

    // Pass 3: Cross-chapter synthesis
    console.log('[novel-import] Pass 3: Cross-chapter synthesis...');
    let characters: NovelImportResult['characters'] = [];
    let plotThreads: NovelImportResult['plot_threads'] = [];

    try {
      const synthPrompt = buildSynthesisPrompt(chapterAnalyses, payload.originalFilename);
      const synthResponse = await callLLM(proxyUrl, SYNTHESIS_SYSTEM, synthPrompt, 12000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const synthParsed = parseJsonFromLLM(synthResponse) as any;

      characters = synthParsed.characters || [];
      plotThreads = synthParsed.plot_threads || [];
    } catch (err) {
      console.error('[novel-import] Synthesis failed:', err);
      // Extract basic character list from chapter analyses as fallback
      const charSet = new Set<string>();
      for (const ch of chapterAnalyses) {
        for (const c of ch.characters_mentioned) {
          charSet.add(c.name);
        }
      }
      characters = Array.from(charSet).map(name => ({
        character_name: name,
        role: 'supporting' as const,
        backstory: '',
        motivations: '',
        personality_traits: '',
        speaking_style: '',
        age_range: null,
        aliases: [],
      }));
    }

    const processingTimeMs = Date.now() - startTime;
    console.log(
      `[novel-import] Complete: ${chapterAnalyses.length} chapters, ${characters.length} characters, ${plotThreads.length} plot threads in ${processingTimeMs}ms`
    );

    return {
      chapters: chapterAnalyses,
      characters,
      plot_threads: plotThreads,
      metadata: {
        total_words: chapterAnalyses.reduce((s, c) => s + c.word_count, 0),
        chapters_detected: chapterAnalyses.length,
        characters_found: characters.length,
        plot_threads_found: plotThreads.length,
        processing_time_ms: processingTimeMs,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// World-Building AI — dedicated task for element generation, expansion,
// codex compilation, and consistency checking
// ---------------------------------------------------------------------------

export interface WorldBuildingPayload {
  organizationId: string;
  analysisType: 'world_element_generate' | 'world_element_expand' | 'world_codex_generate' | 'world_consistency_check';
  systemMessage: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface WorldBuildingResult {
  content: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  analysisType: string;
  durationMs: number;
}

/**
 * Dedicated world-building AI task.
 * Handles element generation, expansion, codex generation, and consistency checks
 * via Claude Code Max proxy. Separate from panel-analysis for independent scaling,
 * monitoring, and retry configuration.
 */
export const prosecreatorWorldBuilding = task({
  id: 'prosecreator-world-building',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 600000,
    factor: 2,
  },
  run: async (payload: WorldBuildingPayload): Promise<WorldBuildingResult> => {
    const startTime = Date.now();
    const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || 'http://claude-code-proxy:3100';

    console.log(
      `[world-building] AI task: type=${payload.analysisType}, promptLen=${payload.prompt.length}`
    );

    const controller = new AbortController();
    // Codex generation needs more time (up to 8 min), others 3 min
    const fetchTimeoutMs = payload.analysisType === 'world_codex_generate' ? 480000 : 180000;
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

    try {
      const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          messages: [
            { role: 'system', content: payload.systemMessage },
            { role: 'user', content: payload.prompt },
          ],
          max_tokens: payload.maxTokens || 8000,
          temperature: payload.temperature || 0.3,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Claude Code Max proxy error ${res.status}: ${errText.slice(0, 300)}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any;
      const durationMs = Date.now() - startTime;

      const extractedContent = data.choices?.[0]?.message?.content || '';
      console.log(
        `[world-building] Complete: type=${payload.analysisType}, duration=${durationMs}ms, model=${data.model || 'unknown'}, contentLen=${extractedContent.length}`
      );

      return {
        content: extractedContent,
        model: data.model || 'unknown',
        usage: data.usage || {},
        analysisType: payload.analysisType,
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});

// ---------------------------------------------------------------------------
// Full Ingestion Pipeline — 8 stages, each a standalone LLM call
// ---------------------------------------------------------------------------

export interface FullIngestPayload {
  organizationId: string;
  systemMessage: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface FullIngestResult {
  content: string;
}

/**
 * Helper: execute a full-ingest pipeline stage via Claude Code Max proxy.
 * All 8 stages share the same shape — receive a prompt, return content.
 */
async function executeFullIngestStage(
  taskId: string,
  payload: FullIngestPayload,
  fetchTimeoutMs: number
): Promise<FullIngestResult> {
  const startTime = Date.now();
  const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || 'http://claude-code-proxy:3100';
  const model = process.env.CLAUDE_MODEL || 'claude-opus-4-6';

  console.log(
    `[${taskId}] Starting: promptLen=${payload.prompt.length}, maxTokens=${payload.maxTokens || 8000}, timeout=${fetchTimeoutMs}ms`
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: payload.systemMessage },
          { role: 'user', content: payload.prompt },
        ],
        max_tokens: payload.maxTokens || 8000,
        temperature: payload.temperature || 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Claude Code Max proxy error ${res.status}: ${errText.slice(0, 300)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    const durationMs = Date.now() - startTime;

    const extractedContent = data.choices?.[0]?.message?.content || '';
    console.log(
      `[${taskId}] Complete: duration=${durationMs}ms, model=${data.model || 'unknown'}, contentLen=${extractedContent.length}`
    );

    return { content: extractedContent };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stage 1: Analyze — initial document analysis (genre, tone, style, structure overview).
 * Timeout: 2 min.
 */
export const prosecreatorFullIngestAnalyze = task({
  id: 'prosecreator-full-ingest-analyze',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-analyze', payload, 120000);
  },
});

/**
 * Stage 2: Characters — extract character profiles, relationships, voice fingerprints.
 * Timeout: 5 min.
 */
export const prosecreatorFullIngestCharacters = task({
  id: 'prosecreator-full-ingest-characters',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-characters', payload, 300000);
  },
});

/**
 * Stage 3: Structure — parse chapter/beat structure, POV tracking, scene boundaries.
 * Timeout: 8 min.
 */
export const prosecreatorFullIngestStructure = task({
  id: 'prosecreator-full-ingest-structure',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 480000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-structure', payload, 480000);
  },
});

/**
 * Stage 4: World — extract world-building elements (locations, magic systems, technology, rules).
 * Timeout: 3 min.
 */
export const prosecreatorFullIngestWorld = task({
  id: 'prosecreator-full-ingest-world',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-world', payload, 180000);
  },
});

/**
 * Stage 5: Tropes — identify literary tropes, narrative patterns, genre conventions.
 * Timeout: 2 min.
 */
export const prosecreatorFullIngestTropes = task({
  id: 'prosecreator-full-ingest-tropes',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-tropes', payload, 120000);
  },
});

/**
 * Stage 6: Blueprint — generate a living blueprint from the ingested content.
 * Timeout: 5 min.
 */
export const prosecreatorFullIngestBlueprint = task({
  id: 'prosecreator-full-ingest-blueprint',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-blueprint', payload, 300000);
  },
});

/**
 * Stage 7: Constitution — generate project constitution (voice, rules, constraints).
 * Timeout: 2 min.
 */
export const prosecreatorFullIngestConstitution = task({
  id: 'prosecreator-full-ingest-constitution',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-constitution', payload, 120000);
  },
});

/**
 * Stage 8: Analysis — comprehensive quality analysis on the fully ingested project.
 * Timeout: 3 min.
 */
export const prosecreatorFullIngestAnalysis = task({
  id: 'prosecreator-full-ingest-analysis',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: FullIngestPayload): Promise<FullIngestResult> => {
    return executeFullIngestStage('full-ingest-analysis', payload, 180000);
  },
});

// ---------------------------------------------------------------------------
// Document-to-Research Extraction Task
// ---------------------------------------------------------------------------

export interface DocumentToResearchPayload {
  analysisType: string;
  systemMessage: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface DocumentToResearchResult {
  content: string;
  model: string;
  usage: Record<string, number>;
  analysisType: string;
  durationMs: number;
}

/**
 * Dedicated document-to-research extraction task.
 * Analyzes document content via LLM and returns structured research topics.
 * Supports N-parallel execution via batch trigger — each document gets its own task run.
 * Uses Claude Code Max proxy for LLM inference.
 */
export const prosecreatorDocumentToResearch = task({
  id: "prosecreator-document-to-research",
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 1200000,
    factor: 2,
  },
  run: async (payload: DocumentToResearchPayload): Promise<DocumentToResearchResult> => {
    const startTime = Date.now();
    const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || "http://claude-code-proxy:3100";
    const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";

    console.log(
      `[document-to-research] AI task: type=${payload.analysisType}, promptLen=${payload.prompt.length}`
    );

    const controller = new AbortController();
    const fetchTimeoutMs = 900000; // 15 minutes
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

    try {
      const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: payload.systemMessage },
            { role: "user", content: payload.prompt },
          ],
          max_tokens: payload.maxTokens || 8000,
          temperature: payload.temperature || 0.3,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Claude Code Max proxy error ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json() as any;
      const durationMs = Date.now() - startTime;

      const extractedContent = data.choices?.[0]?.message?.content || "";
      console.log(
        `[document-to-research] Complete: type=${payload.analysisType}, duration=${durationMs}ms, model=${data.model || "unknown"}, contentLen=${extractedContent.length}`
      );

      return {
        content: extractedContent,
        model: data.model || "unknown",
        usage: data.usage || {},
        analysisType: payload.analysisType,
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});

// ---------------------------------------------------------------------------
// Shared LLM Task Helper — Tier 1 (LLM-only) tasks
// ---------------------------------------------------------------------------

/**
 * Payload for all Tier 1 LLM-only tasks.
 * Same shape as PanelAnalysisPayload — systemMessage + prompt + config.
 */
export interface LLMTaskPayload {
  organizationId: string;
  analysisType: string;
  systemMessage: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMTaskResult {
  content: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  analysisType: string;
  durationMs: number;
}

/**
 * Execute an LLM-only task via Claude Code Max proxy.
 * Shared by all Tier 1 tasks — receives a fully-built prompt, calls the proxy,
 * and returns the raw LLM content. Post-processing (DB writes, etc.) happens
 * on the ProseCreator side after polling the run result.
 *
 * @param taskLabel - Human-readable label for logging (e.g. 'research-generate')
 * @param payload - System message, prompt, and generation config
 * @param fetchTimeoutMs - Abort timeout for the LLM fetch call
 */
async function executeLLMTask(
  taskLabel: string,
  payload: LLMTaskPayload,
  fetchTimeoutMs?: number,
): Promise<LLMTaskResult> {
  const startTime = Date.now();
  const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || 'http://claude-code-proxy:3100';
  const model = process.env.CLAUDE_MODEL || 'claude-opus-4-6';
  const maxTokens = payload.maxTokens || 8000;
  const temperature = payload.temperature ?? 0.3;

  // Scale timeout with maxTokens if not explicitly provided
  const effectiveTimeout = fetchTimeoutMs ?? (maxTokens > 16000 ? 480000 : 150000);

  console.log(
    `[${taskLabel}] Starting: type=${payload.analysisType}, promptLen=${payload.prompt.length}, maxTokens=${maxTokens}, timeout=${effectiveTimeout}ms`
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: payload.systemMessage },
          { role: 'user', content: payload.prompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Claude Code Max proxy error ${res.status}: ${errText.slice(0, 300)}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    const durationMs = Date.now() - startTime;

    const extractedContent = data.choices?.[0]?.message?.content || '';
    console.log(
      `[${taskLabel}] Complete: type=${payload.analysisType}, duration=${durationMs}ms, model=${data.model || 'unknown'}, contentLen=${extractedContent.length}`
    );

    return {
      content: extractedContent,
      model: data.model || 'unknown',
      usage: data.usage || {},
      analysisType: payload.analysisType,
      durationMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Tier 1 Tasks — LLM-only (research, publication, constitution, etc.)
// ---------------------------------------------------------------------------

/**
 * Generate a research brief from project context + topic.
 * LLM produces structured research output stored back in prose.research_briefs.
 */
export const prosecreatorResearchGenerate = task({
  id: 'prosecreator-research-generate',
  retry: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('research-generate', payload, 180000);
  },
});

/**
 * Refine an existing research brief with additional context or focus areas.
 */
export const prosecreatorResearchRefine = task({
  id: 'prosecreator-research-refine',
  retry: { maxAttempts: 3, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('research-refine', payload, 180000);
  },
});

/**
 * Validate factual claims in manuscript content against research briefs.
 */
export const prosecreatorClaimValidation = task({
  id: 'prosecreator-claim-validation',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('claim-validation', payload, 150000);
  },
});

/**
 * Generate a book index from manuscript content — topics, names, locations.
 */
export const prosecreatorIndexGeneration = task({
  id: 'prosecreator-index-generation',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('index-generation', payload, 180000);
  },
});

/**
 * Generate copyright page content for publication.
 */
export const prosecreatorPublicationCopyright = task({
  id: 'prosecreator-publication-copyright',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 120000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('publication-copyright', payload, 90000);
  },
});

/**
 * Generate "About the Author" section for publication.
 */
export const prosecreatorPublicationAbout = task({
  id: 'prosecreator-publication-about',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 120000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('publication-about', payload, 90000);
  },
});

/**
 * Generate a marketing blurb / back-cover copy for publication.
 */
export const prosecreatorPublicationBlurb = task({
  id: 'prosecreator-publication-blurb',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 120000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('publication-blurb', payload, 90000);
  },
});

/**
 * Generate front/back matter sections (dedication, acknowledgements, etc.).
 */
export const prosecreatorPublicationMatter = task({
  id: 'prosecreator-publication-matter',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 120000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('publication-matter', payload, 90000);
  },
});

/**
 * Assess publication readiness — completeness, quality gates, formatting checks.
 */
export const prosecreatorPublicationReadiness = task({
  id: 'prosecreator-publication-readiness',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('publication-readiness', payload, 120000);
  },
});

/**
 * Generate a full project constitution — voice, rules, constraints, style guide.
 */
export const prosecreatorConstitutionGenerate = task({
  id: 'prosecreator-constitution-generate',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('constitution-generate', payload, 180000);
  },
});

/**
 * Generate or update a single section of the project constitution.
 */
export const prosecreatorConstitutionSection = task({
  id: 'prosecreator-constitution-section',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('constitution-section', payload, 120000);
  },
});

/**
 * Analyze character evolution across chapters — trait changes, arc progression,
 * relationship dynamics. Feeds CharacterEvolutionService.
 */
export const prosecreatorCharacterEvolution = task({
  id: 'prosecreator-character-evolution',
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 600000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('character-evolution', payload, 300000);
  },
});

/**
 * Generate a TTS voice profile for a character — prosody, pace, pitch, emotion mapping.
 */
export const prosecreatorTTSVoiceProfile = task({
  id: 'prosecreator-tts-voice-profile',
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 180000, factor: 2 },
  run: async (payload: LLMTaskPayload): Promise<LLMTaskResult> => {
    return executeLLMTask('tts-voice-profile', payload, 120000);
  },
});

// ---------------------------------------------------------------------------
// Shared Callback Task Helper — Tier 2 (callback to ProseCreator)
// ---------------------------------------------------------------------------

/**
 * Payload for Tier 2 callback tasks.
 * The task calls back to ProseCreator's internal execute endpoint, which
 * runs the full handler with ServiceContainer access.
 */
export interface CallbackTaskPayload {
  organizationId: string;
  inputParams: Record<string, unknown>;
  jobId?: string;
  userId?: string;
  projectId?: string;
}

export interface CallbackTaskResult {
  executionId: string;
  status: 'completed' | 'failed';
  result?: unknown;
  durationMs: number;
}

/**
 * Execute a Tier 2 task by calling back to ProseCreator's internal execute endpoint.
 *
 * Flow:
 *   1. POST to /prosecreator/api/internal/execute with job_type + input_params
 *   2. Poll /prosecreator/api/internal/execute/:executionId/status until completion
 *   3. Return result or throw on failure/timeout
 *
 * @param taskLabel - Human-readable label for logging
 * @param jobType - The ProseCreator job_type string (e.g. 'beat', 'chapter', 'canvas_brainstorm')
 * @param payload - Organization, input params, optional job ID
 * @param options - Timeout and poll interval overrides
 */
async function executeCallbackTask(
  taskLabel: string,
  jobType: string,
  payload: CallbackTaskPayload,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<CallbackTaskResult> {
  const startTime = Date.now();
  const prosecreatorUrl = process.env.PROSECREATOR_ENDPOINT || 'http://nexus-prosecreator:3000';
  const serviceKey = process.env.NEXUS_TRIGGER_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY || '';
  const timeoutMs = options?.timeoutMs || 600000;
  const pollIntervalMs = options?.pollIntervalMs || 5000;

  console.log(
    `[${taskLabel}] Starting callback: jobType=${jobType}, org=${payload.organizationId}, timeout=${timeoutMs}ms`
  );

  // Step 1: Submit execution request
  const submitRes = await fetch(`${prosecreatorUrl}/prosecreator/api/internal/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-key': serviceKey,
    },
    body: JSON.stringify({
      job_type: jobType,
      input_params: payload.inputParams,
      run_id: `trigger-${taskLabel}-${Date.now()}`,
      user_id: payload.userId,
      project_id: payload.projectId,
    }),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => '');
    throw new Error(`ProseCreator execute failed (${submitRes.status}): ${errText.slice(0, 500)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const submitData = await submitRes.json() as any;
  const executionId = submitData.execution_id || submitData.executionId || submitData.id;

  if (!executionId) {
    throw new Error(`ProseCreator returned no execution_id: ${JSON.stringify(submitData).slice(0, 500)}`);
  }

  console.log(
    `[${taskLabel}] Execution accepted: executionId=${executionId}`
  );

  // Step 2: Poll for completion
  const pollStart = Date.now();
  while (Date.now() - pollStart < timeoutMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    try {
      const statusRes = await fetch(
        `${prosecreatorUrl}/prosecreator/api/internal/execute/${executionId}/status`,
        {
          headers: {
            'x-service-key': serviceKey,
          },
        }
      );

      if (!statusRes.ok) {
        console.warn(`[${taskLabel}] Status poll returned ${statusRes.status}, retrying...`);
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const statusData = await statusRes.json() as any;
      const jobStatus = statusData.status;

      if (jobStatus === 'completed') {
        const durationMs = Date.now() - startTime;
        console.log(
          `[${taskLabel}] Completed: executionId=${executionId}, duration=${durationMs}ms`
        );
        return {
          executionId,
          status: 'completed',
          result: statusData.result || statusData.output,
          durationMs,
        };
      }

      if (jobStatus === 'failed' || jobStatus === 'error') {
        const errMsg = statusData.error || statusData.message || 'Job failed on ProseCreator';
        throw new Error(`${taskLabel} failed: ${errMsg}`);
      }

      // Still processing — log progress if available
      if (statusData.progress) {
        console.log(
          `[${taskLabel}] Progress: ${statusData.progress}% (${Math.round((Date.now() - pollStart) / 1000)}s elapsed)`
        );
      }
    } catch (err) {
      // Re-throw if this is our own error (not a poll failure)
      if (err instanceof Error && err.message.startsWith(`${taskLabel} failed:`)) {
        throw err;
      }
      console.warn(`[${taskLabel}] Poll error, retrying: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`${taskLabel} timed out after ${timeoutMs}ms (executionId=${executionId})`);
}

// ---------------------------------------------------------------------------
// Tier 2 Tasks — Callback to ProseCreator (full ServiceContainer access)
// ---------------------------------------------------------------------------

/**
 * Generate a single beat (scene) within a chapter.
 * Uses ProseGenerator + ContextInjector + AntiAIDetection + VoiceConsistency pipeline.
 * Queue: prosecreator-generation. Timeout: 10 min.
 */
export const prosecreatorBeatGeneration = task({
  id: 'prosecreator-beat-generation',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 600000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('beat-generation', 'beat', payload, { timeoutMs: 600000 });
  },
});

/**
 * Generate a full chapter — orchestrates multiple beat generations, word count rollup,
 * plot thread seeding. Queue: prosecreator-generation. Timeout: 25 min.
 */
export const prosecreatorChapterGeneration = task({
  id: 'prosecreator-chapter-generation',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 1500000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('chapter-generation', 'chapter', payload, { timeoutMs: 1500000 });
  },
});

/**
 * Generate a living blueprint from project outline/data.
 * Uses BlueprintManager + entity extraction + JSON repair.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorBlueprintGeneration = task({
  id: 'prosecreator-blueprint-generation',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('blueprint-generation', 'blueprint', payload, { timeoutMs: 900000 });
  },
});

/**
 * Run analysis on manuscript content — supports 6 subtypes (continuity, style, pacing,
 * character, plot holes, AI detection). Queue: prosecreator-analysis. Timeout: 5 min.
 */
export const prosecreatorAnalysis = task({
  id: 'prosecreator-analysis',
  queue: { name: 'prosecreator-analysis' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('analysis', 'analysis', payload, { timeoutMs: 300000 });
  },
});

/**
 * Run a critique session with persona-based feedback on manuscript content.
 * Queue: prosecreator-analysis. Timeout: 5 min.
 */
export const prosecreatorCritique = task({
  id: 'prosecreator-critique',
  queue: { name: 'prosecreator-analysis' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('critique', 'critique', payload, { timeoutMs: 300000 });
  },
});

/**
 * Invoke a Writers Room persona to generate in-character feedback or dialogue.
 * Queue: prosecreator-analysis. Timeout: 5 min.
 */
export const prosecreatorRoomPersona = task({
  id: 'prosecreator-room-persona',
  queue: { name: 'prosecreator-analysis' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('room-persona', 'room_persona', payload, { timeoutMs: 300000 });
  },
});

/**
 * Generate a full character bible — comprehensive character profile, voice fingerprint,
 * relationship map, arc outline. Uses CharacterBibleManager.
 * Queue: prosecreator-analysis. Timeout: 30 min.
 */
export const prosecreatorCharacterBible = task({
  id: 'prosecreator-character-bible',
  queue: { name: 'prosecreator-analysis' },
  retry: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 1800000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('character-bible', 'character_bible', payload, { timeoutMs: 1800000 });
  },
});

/**
 * Generate a single section of a character bible (e.g. backstory, voice, motivations).
 * Queue: prosecreator-analysis. Timeout: 25 min.
 */
export const prosecreatorCharacterBibleSection = task({
  id: 'prosecreator-character-bible-section',
  queue: { name: 'prosecreator-analysis' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 1500000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('character-bible-section', 'character_bible_section', payload, { timeoutMs: 1500000 });
  },
});

// ── Canvas tasks (9 types) ─────────────────────────────────────────────────

/**
 * Canvas brainstorm — generate ideas for a story element.
 * Queue: prosecreator-canvas. Timeout: 5 min.
 */
export const prosecreatorCanvasBrainstorm = task({
  id: 'prosecreator-canvas-brainstorm',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-brainstorm', 'canvas_brainstorm', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas expand — elaborate on a story element node.
 */
export const prosecreatorCanvasExpand = task({
  id: 'prosecreator-canvas-expand',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-expand', 'canvas_expand', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas connect — find relationships between story elements.
 */
export const prosecreatorCanvasConnect = task({
  id: 'prosecreator-canvas-connect',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-connect', 'canvas_connect', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas challenge — generate "what if" scenarios and contradictions.
 */
export const prosecreatorCanvasChallenge = task({
  id: 'prosecreator-canvas-challenge',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-challenge', 'canvas_challenge', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas synthesize — merge multiple nodes into a coherent summary.
 */
export const prosecreatorCanvasSynthesize = task({
  id: 'prosecreator-canvas-synthesize',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-synthesize', 'canvas_synthesize', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas research — generate research notes for a story element.
 */
export const prosecreatorCanvasResearch = task({
  id: 'prosecreator-canvas-research',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-research', 'canvas_research', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas outline — generate a structured outline from canvas elements.
 */
export const prosecreatorCanvasOutline = task({
  id: 'prosecreator-canvas-outline',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-outline', 'canvas_outline', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas critique — provide feedback on a canvas node's narrative quality.
 */
export const prosecreatorCanvasCritique = task({
  id: 'prosecreator-canvas-critique',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-critique', 'canvas_critique', payload, { timeoutMs: 300000 });
  },
});

/**
 * Canvas transform — convert a story element from one form to another.
 */
export const prosecreatorCanvasTransform = task({
  id: 'prosecreator-canvas-transform',
  queue: { name: 'prosecreator-canvas' },
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 300000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('canvas-transform', 'canvas_transform', payload, { timeoutMs: 300000 });
  },
});

// ── Audiobook tasks (4 types) ──────────────────────────────────────────────

/**
 * Generate full audiobook — TTS for all chapters, assembly, metadata.
 * Queue: prosecreator-audiobook. Timeout: 30 min.
 */
export const prosecreatorAudiobookFull = task({
  id: 'prosecreator-audiobook-full',
  queue: { name: 'prosecreator-audiobook' },
  retry: { maxAttempts: 2, minTimeoutInMs: 10000, maxTimeoutInMs: 1800000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('audiobook-full', 'audiobook_full', payload, { timeoutMs: 1800000, pollIntervalMs: 10000 });
  },
});

/**
 * Generate TTS audio for a single chapter.
 * Queue: prosecreator-audiobook. Timeout: 25 min.
 */
export const prosecreatorAudiobookChapter = task({
  id: 'prosecreator-audiobook-chapter',
  queue: { name: 'prosecreator-audiobook' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 1500000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('audiobook-chapter', 'audiobook_chapter', payload, { timeoutMs: 1500000, pollIntervalMs: 10000 });
  },
});

/**
 * Assemble individual chapter audio files into a complete audiobook.
 * Queue: prosecreator-audiobook. Timeout: 15 min.
 */
export const prosecreatorAudiobookAssemble = task({
  id: 'prosecreator-audiobook-assemble',
  queue: { name: 'prosecreator-audiobook' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('audiobook-assemble', 'audiobook_assemble', payload, { timeoutMs: 900000 });
  },
});

/**
 * Export assembled audiobook to final format (M4B, MP3 chapters, etc.).
 * Queue: prosecreator-audiobook. Timeout: 15 min.
 */
export const prosecreatorAudiobookExport = task({
  id: 'prosecreator-audiobook-export',
  queue: { name: 'prosecreator-audiobook' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('audiobook-export', 'audiobook_export', payload, { timeoutMs: 900000 });
  },
});

// ── Forge tasks (5 phases) ─────────────────────────────────────────────────

/**
 * Forge phase: outline generation from user brief.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorForgeOutline = task({
  id: 'prosecreator-forge-outline',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('forge-outline', 'forge_outline', payload, { timeoutMs: 900000 });
  },
});

/**
 * Forge phase: draft generation from approved outline.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorForgeDraft = task({
  id: 'prosecreator-forge-draft',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('forge-draft', 'forge_draft', payload, { timeoutMs: 900000 });
  },
});

/**
 * Forge phase: revision pass on draft.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorForgeRevise = task({
  id: 'prosecreator-forge-revise',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('forge-revise', 'forge_revise', payload, { timeoutMs: 900000 });
  },
});

/**
 * Forge phase: polish pass — final grammar, style, voice refinement.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorForgePolish = task({
  id: 'prosecreator-forge-polish',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('forge-polish', 'forge_polish', payload, { timeoutMs: 900000 });
  },
});

/**
 * Forge phase: final quality check and formatting.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorForgeFinalize = task({
  id: 'prosecreator-forge-finalize',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('forge-finalize', 'forge_finalize', payload, { timeoutMs: 900000 });
  },
});

// ── GitHub Scaffold (Tier 2 callback) ──────────────────────────────────────

/**
 * Generate complete series folder structure in a GitHub repo via callback.
 * Loads all series data, generates AI READMEs, writes files, git push.
 * This is the Tier 2 callback version — the existing prosecreator-github-scaffold
 * task (Tier 3, already migrated) handles the LLM README generation directly.
 * Queue: prosecreator-generation. Timeout: 15 min.
 */
export const prosecreatorGitHubScaffoldCallback = task({
  id: 'prosecreator-github-scaffold-callback',
  queue: { name: 'prosecreator-generation' },
  retry: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 900000, factor: 2 },
  run: async (payload: CallbackTaskPayload): Promise<CallbackTaskResult> => {
    return executeCallbackTask('github-scaffold', 'github_repo_scaffold', payload, { timeoutMs: 900000 });
  },
});
