/**
 * AI client for remediation analysis.
 *
 * Primary: Gemini 2.5 Pro via @google/generative-ai SDK (API key auth).
 * Fallback: Claude Code Max proxy (OpenAI-compatible, no auth, internal K8s).
 */

import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import axios from 'axios';

const DEFAULT_MODEL = 'gemini-2.5-pro';
const GENERATION_TIMEOUT_MS = 120_000;
const CLAUDE_PROXY_URL = process.env.CLAUDE_CODE_PROXY_URL || 'http://claude-code-proxy.nexus.svc.cluster.local:3100';
const CLAUDE_PROXY_MODEL = process.env.CLAUDE_PROXY_MODEL || 'claude-sonnet-4-5-20250514';
const CLAUDE_PROXY_TIMEOUT_MS = 300_000;

export interface GeminiResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  modelUsed: string;
}

export class GeminiClient {
  private genAI: GoogleGenerativeAI | null = null;
  private model: string;

  constructor(model: string = DEFAULT_MODEL) {
    this.model = model;
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    }
  }

  isAvailable(): boolean {
    return this.genAI !== null;
  }

  async generateContent(
    prompt: string,
    systemInstruction: string,
  ): Promise<GeminiResponse> {
    if (!this.genAI) {
      return {
        text: 'Gemini API key not configured — AI analysis unavailable.',
        promptTokens: 0,
        completionTokens: 0,
        modelUsed: this.model,
      };
    }

    const generativeModel = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
      generationConfig: {
        maxOutputTokens: 16384,
        temperature: 0.2,
      },
    });

    const result = await Promise.race([
      generativeModel.generateContent(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini generation timeout')), GENERATION_TIMEOUT_MS),
      ),
    ]);

    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata;

    return {
      text,
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      modelUsed: this.model,
    };
  }

  /**
   * Try Gemini first, fall back to Claude Code Max proxy if unavailable/failed.
   */
  async generateContentWithFallback(
    prompt: string,
    systemInstruction: string,
  ): Promise<GeminiResponse> {
    // 1. Try Gemini (if API key configured)
    if (this.isAvailable()) {
      try {
        return await this.generateContent(prompt, systemInstruction);
      } catch (err) {
        console.warn(`[remediation] Gemini failed, falling back to Claude proxy: ${(err as Error).message}`);
      }
    }

    // 2. Fall back to Claude Code Max proxy (OpenAI-compatible, no auth)
    try {
      const response = await axios.post(
        `${CLAUDE_PROXY_URL}/v1/chat/completions`,
        {
          model: CLAUDE_PROXY_MODEL,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
          max_tokens: 16384,
          temperature: 0.2,
        },
        { timeout: CLAUDE_PROXY_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } },
      );

      const choice = response.data.choices?.[0]?.message?.content ?? '';
      const usage = response.data.usage ?? {};
      return {
        text: choice,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        modelUsed: response.data.model ?? CLAUDE_PROXY_MODEL,
      };
    } catch (proxyErr) {
      console.error(`[remediation] Claude proxy also failed: ${(proxyErr as Error).message}`);
      return {
        text: `AI analysis unavailable — both Gemini and Claude proxy failed: ${(proxyErr as Error).message}`,
        promptTokens: 0,
        completionTokens: 0,
        modelUsed: 'none',
      };
    }
  }
}
