/**
 * Gemini 2.5 Pro client for AI-powered remediation analysis.
 *
 * Uses the @google/generative-ai SDK with a standard API key
 * (not Vertex AI). The key is read from the GEMINI_API_KEY env var.
 */

import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from '@google/generative-ai';

const DEFAULT_MODEL = 'gemini-2.5-pro';
const GENERATION_TIMEOUT_MS = 120_000;

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
}
