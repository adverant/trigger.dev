import { AxiosInstance, AxiosError } from 'axios';
import { createResilientClient } from './resilient-client';

// --- Interfaces ---

export interface PluginTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  costEstimate?: number;
}

export interface PluginCatalogItem {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  endpoint: string;
  tools: PluginTool[];
  category: string;
  tags: string[];
  pricingModel: string;
  hasWebUi: boolean;
  uiPath?: string;
  apiDocsUrl?: string;
  tierRequirements?: string[];
  certifications?: string[];
  status: string;
}

export interface PluginCatalogResponse {
  plugins: PluginCatalogItem[];
  total: number;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
}

// --- Client ---

export class PluginsClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.PLUGINS_API_URL;
    if (!baseURL) {
      throw new Error('PLUGINS_API_URL environment variable is not set');
    }

    this.client = createResilientClient({
      serviceName: 'nexus-plugins',
      baseURL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-Organization-ID': organizationId,
        'X-User-Id': organizationId,
      },
    });
  }

  /**
   * List all published plugins from the marketplace.
   * Paginates automatically if total > limit.
   */
  async listAllPlugins(params?: {
    category?: string;
    limit?: number;
  }): Promise<PluginCatalogResponse> {
    const limit = params?.limit || 100;
    const allPlugins: PluginCatalogItem[] = [];
    let offset = 0;
    let total = 0;

    try {
      do {
        const queryParams: Record<string, string | number> = { limit, offset };
        if (params?.category) queryParams.category = params.category;

        const response = await this.client.get('/api/v1/marketplace/plugins', {
          params: queryParams,
        });

        const body = response.data;
        const inner = body?.data || body;
        const plugins = inner?.plugins || [];
        total = inner?.pagination?.total || inner?.total || plugins.length;

        for (const p of plugins) {
          allPlugins.push({
            id: p.id,
            name: p.name,
            displayName: p.displayName || p.display_name || p.name,
            description: p.description || '',
            version: p.version || '1.0.0',
            endpoint: p.endpoint || '',
            tools: (p.tools || []).map((t: any) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema || t.input_schema,
              outputSchema: t.outputSchema || t.output_schema,
              costEstimate: t.costEstimate || t.cost_estimate,
            })),
            category: p.category || '',
            tags: p.tags || [],
            pricingModel: p.pricingModel || p.pricing_model || 'free',
            hasWebUi: p.hasWebUi ?? p.has_web_ui ?? false,
            uiPath: p.uiPath || p.ui_path,
            apiDocsUrl: p.apiDocsUrl || p.api_docs_url,
            tierRequirements: p.tierRequirements || p.tier_requirements,
            certifications: p.certifications || [],
            status: p.status || 'published',
          });
        }

        offset += limit;
      } while (allPlugins.length < total && offset < total);

      return { plugins: allPlugins, total };
    } catch (error) {
      throw this.handleError(error, 'Plugins listAllPlugins');
    }
  }

  /**
   * Get detailed information about a single plugin by ID.
   */
  async getPluginDetail(pluginId: string): Promise<PluginCatalogItem> {
    try {
      const response = await this.client.get(
        `/api/v1/marketplace/plugins/${pluginId}`
      );
      const p = response.data?.data || response.data;
      return {
        id: p.id,
        name: p.name,
        displayName: p.displayName || p.display_name || p.name,
        description: p.description || '',
        version: p.version || '1.0.0',
        endpoint: p.endpoint || '',
        tools: (p.tools || []).map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema || t.input_schema,
          outputSchema: t.outputSchema || t.output_schema,
          costEstimate: t.costEstimate || t.cost_estimate,
        })),
        category: p.category || '',
        tags: p.tags || [],
        pricingModel: p.pricingModel || p.pricing_model || 'free',
        hasWebUi: p.hasWebUi ?? p.has_web_ui ?? false,
        uiPath: p.uiPath || p.ui_path,
        apiDocsUrl: p.apiDocsUrl || p.api_docs_url,
        tierRequirements: p.tierRequirements || p.tier_requirements,
        certifications: p.certifications || [],
        status: p.status || 'published',
      };
    } catch (error) {
      throw this.handleError(error, 'Plugins getPluginDetail');
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get('/health');
      const latency = Date.now() - start;
      return {
        status: ['ok', 'healthy'].includes(response.data?.status)
          ? 'healthy'
          : 'degraded',
        latency,
      };
    } catch {
      const latency = Date.now() - start;
      return { status: 'unhealthy', latency };
    }
  }

  private handleError(error: unknown, operation: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      return new Error(`${operation} failed (HTTP ${status}): ${message}`);
    }
    if (error instanceof Error) {
      return new Error(`${operation} failed: ${error.message}`);
    }
    return new Error(`${operation} failed: Unknown error`);
  }
}
