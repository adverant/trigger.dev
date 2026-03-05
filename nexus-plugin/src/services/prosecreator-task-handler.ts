/**
 * ProseCreator Task Handler — In-process handler for ProseCreator tasks.
 *
 * Runs entirely inside the Nexus Workflows engine pod. Calls Claude Max Proxy
 * directly for LLM generation (no external routing, no MageAgent).
 *
 * Pattern follows SkillsEngineTaskHandler:
 * 1. Receives all project data + skill instructions in payload
 * 2. Calls Claude Max Proxy (POST /v1/chat/completions) with structured prompt
 * 3. Returns generated blueprint JSON
 */

import axios from 'axios';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'prosecreator-task-handler' });

export interface ProseCreatorBlueprintResult {
  blueprint: any;
  durationMs: number;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}

export class ProseCreatorTaskHandler {
  private proxyUrl: string;
  private model: string;

  constructor(private orgId: string, private userId: string) {
    this.proxyUrl = process.env.CLAUDE_CODE_PROXY_URL
      || process.env.LLM_CLAUDE_CODE_PROXY_URL
      || 'http://claude-code-proxy.nexus.svc.cluster.local:3100';
    this.model = process.env.CLAUDE_BLUEPRINT_MODEL || 'claude-opus-4-20250514';
  }

  /**
   * Generate a blueprint by calling Claude Max Proxy with skill instructions + project data.
   * This is a synchronous call (blocks until Claude responds, typically 30-120s).
   */
  async generateBlueprint(payload: any): Promise<ProseCreatorBlueprintResult> {
    const startTime = Date.now();
    const d = payload.inputData || payload;

    const systemPrompt = this.buildSystemPrompt(d);
    const userMessage = this.buildUserMessage(d);

    logger.info('ProseCreator blueprint generation starting', {
      orgId: this.orgId,
      genre: d.genre,
      characterCount: d.characters?.length || 0,
      plotThreadCount: d.plot_threads?.length || 0,
      chapterCount: d.chapter_summaries?.length || 0,
      hasConstitution: !!d.constitution_guidelines,
      hasDocuments: !!d.reference_documents,
      hasSkillInstructions: !!d.skill_instructions,
      hasCharacterBible: !!d.character_bible,
      hasWorldBuilding: !!d.world_building,
      systemPromptLength: systemPrompt.length,
      userMessageLength: userMessage.length,
    });

    const res = await axios.post(`${this.proxyUrl}/v1/chat/completions`, {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 16384,
      temperature: 0.7,
      stream: false,
    }, {
      timeout: 300000, // 5 min
      headers: { 'Content-Type': 'application/json' },
    });

    const content = res.data?.choices?.[0]?.message?.content || '';
    const durationMs = Date.now() - startTime;

    logger.info('ProseCreator blueprint generation complete', {
      orgId: this.orgId,
      durationMs,
      contentLength: content.length,
      promptTokens: res.data?.usage?.prompt_tokens,
      completionTokens: res.data?.usage?.completion_tokens,
    });

    // Parse response — try JSON first, fall back to raw text
    let blueprint: any;
    try {
      const jsonStr = content
        .replace(/^```(?:json)?\s*\n?/m, '')
        .replace(/\n?\s*```\s*$/m, '')
        .trim();
      blueprint = JSON.parse(jsonStr);
    } catch {
      // If not valid JSON, wrap content as-is
      blueprint = { content, raw: true };
      logger.warn('Blueprint response was not valid JSON, storing as raw text', {
        orgId: this.orgId,
        contentLength: content.length,
      });
    }

    return {
      blueprint,
      durationMs,
      model: this.model,
      promptTokens: res.data?.usage?.prompt_tokens,
      completionTokens: res.data?.usage?.completion_tokens,
    };
  }

  private buildSystemPrompt(d: any): string {
    const parts: string[] = [];

    if (d.skill_instructions) {
      parts.push(d.skill_instructions);
    } else {
      parts.push(`You are an expert creative writing AI that generates comprehensive story blueprints.
Analyze all provided project elements — characters, constitution, plot threads, documents, world-building —
and produce a detailed, structured blueprint that serves as the foundation for the entire creative writing pipeline.`);
    }

    parts.push(`
OUTPUT FORMAT: Return ONLY valid JSON (no markdown fences, no commentary) following this ProjectBlueprint structure:

{
  "metadata": {
    "title": "string",
    "premise": "string",
    "genre": "string",
    "subgenre": "string | null",
    "target_word_count": "number",
    "estimated_chapters": "number"
  },
  "characters": [
    {
      "name": "string",
      "role": "protagonist | antagonist | supporting | minor",
      "importance": "protagonist | antagonist | major | supporting | minor",
      "arc": {
        "starting_state": "string",
        "key_developments": ["string"],
        "transformation": "string",
        "ending_state": "string",
        "arc_type": "string"
      },
      "introduction_chapter": "number",
      "traits": ["string"],
      "background": "string",
      "goals": ["string"],
      "conflicts": ["string"],
      "psychological_profile": {
        "core_motivation": "string",
        "fears": ["string"],
        "attachment_style": "string",
        "coping_mechanisms": ["string"],
        "internal_conflict": "string",
        "emotional_range": "string"
      },
      "key_relationships": ["string"]
    }
  ],
  "plot_threads": [
    {
      "title": "string",
      "description": "string",
      "plot_type": "main | subplot | romantic | mystery | ...",
      "importance": "critical | major | moderate | minor",
      "start_chapter": "number",
      "resolution_chapter": "number | null",
      "key_beats": ["string"],
      "foreshadowing_elements": ["string"],
      "related_characters": ["string"],
      "related_threads": ["string"]
    }
  ],
  "chapters": [
    {
      "chapter_number": "number",
      "title": "string",
      "summary": "string",
      "pov_character": "string",
      "location": "string",
      "plot_threads_active": ["string"],
      "estimated_word_count": "number",
      "beats": [
        {
          "beat_number": "number",
          "beat_type": "action | dialogue | description | transition",
          "narrative_function": "string",
          "description": "string",
          "characters_present": ["string"],
          "emotional_tone": "string"
        }
      ],
      "emotional_arc": {
        "start_emotion": "string",
        "peak_emotion": "string",
        "end_emotion": "string"
      },
      "tension_level": "number (1-10)",
      "key_developments": ["string"]
    }
  ],
  "world_building": {
    "locations": [{ "name": "string", "description": "string", "significance": "string" }],
    "cultures": ["string"],
    "rules_and_laws": [{ "rule": "string", "scope": "string" }],
    "historical_events": ["string"]
  },
  "themes": ["string"],
  "foreshadowing_plan": [
    {
      "planted_chapter": "number",
      "planted_content": "string",
      "payoff_chapter": "number",
      "payoff_description": "string",
      "subtlety_level": "obvious | moderate | subtle"
    }
  ],
  "character_bible": {
    "relationship_matrix": { "character_pair": "relationship_description" },
    "character_arcs_timeline": [{ "character": "string", "chapter": "number", "development": "string" }]
  }
}`);

    return parts.join('\n\n');
  }

  private buildUserMessage(d: any): string {
    const sections: string[] = [];

    sections.push('Generate a comprehensive ProjectBlueprint for this project:');

    sections.push(`
## Project Overview
- Premise: ${d.premise || 'Not specified'}
- Genre: ${d.genre || 'Fiction'}${d.subgenre ? ` / ${d.subgenre}` : ''}
- Target Word Count: ${d.target_word_count || 80000}
- Blueprint Type: ${d.blueprint_type || 'project'}
- Depth: ${d.depth || 'standard'}`);

    if (d.constitution_guidelines) {
      sections.push(`
## Project Constitution (Author's Creative Guidelines — MUST be respected)
${d.constitution_guidelines}`);
    }

    if (d.characters?.length > 0) {
      sections.push(`
## Existing Characters (${d.characters.length})
${JSON.stringify(d.characters, null, 2)}`);
    }

    if (d.character_bible) {
      sections.push(`
## Existing Character Bible
${typeof d.character_bible === 'string' ? d.character_bible : JSON.stringify(d.character_bible, null, 2)}`);
    }

    if (d.plot_threads?.length > 0) {
      sections.push(`
## Existing Plot Threads (${d.plot_threads.length})
${JSON.stringify(d.plot_threads, null, 2)}`);
    }

    if (d.chapter_summaries?.length > 0) {
      sections.push(`
## Existing Chapters (${d.chapter_summaries.length})
${JSON.stringify(d.chapter_summaries, null, 2)}`);
    }

    if (d.world_building) {
      sections.push(`
## Existing World Building
${typeof d.world_building === 'string' ? d.world_building : JSON.stringify(d.world_building, null, 2)}`);
    }

    if (d.reference_documents) {
      sections.push(`
## Reference Documents (Source Material)
${d.reference_documents}`);
    }

    sections.push(`
## Requirements
Analyze ALL the above elements comprehensively. You MUST include:
1. Deep psychological profiles for every character (core motivation, fears, attachment style, coping mechanisms)
2. Character bible with relationship matrix and arc timelines for ALL characters
3. Complete plot structure with foreshadowing plan
4. Chapter-by-chapter breakdown with beat-level detail (8-12 beats per chapter)
5. World-building rules and consistency checks
6. Thematic analysis weaving through all elements
7. Resolve any conflicts between existing elements
8. Identify and flag any gaps in the narrative

Return valid JSON only — no markdown fences, no commentary.`);

    return sections.join('\n');
  }
}
