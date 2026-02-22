'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  AlertTriangle,
  X,
  Settings,
  Zap,
  ExternalLink,
  Plug,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { useTriggerApi, Integration } from '@/hooks/useTriggerApi';
import StatusBadge from '@/components/common/StatusBadge';
import JsonEditor from '@/components/common/JsonEditor';
import { clsx } from 'clsx';
import { format } from 'date-fns';

const SERVICE_ICONS: Record<string, string> = {
  graphrag: 'GR',
  mageagent: 'MA',
  fileprocess: 'FP',
  learningagent: 'LA',
  geoagent: 'GA',
  jupyter: 'JU',
  cvat: 'CV',
  gpubridge: 'GP',
  sandbox: 'SB',
  n8n: 'N8',
};

const SERVICE_COLORS: Record<string, string> = {
  graphrag: 'from-violet-600 to-purple-600',
  mageagent: 'from-blue-600 to-cyan-600',
  fileprocess: 'from-emerald-600 to-green-600',
  learningagent: 'from-amber-600 to-orange-600',
  geoagent: 'from-sky-600 to-blue-600',
  jupyter: 'from-orange-500 to-red-500',
  cvat: 'from-pink-600 to-rose-600',
  gpubridge: 'from-green-600 to-teal-600',
  sandbox: 'from-slate-500 to-slate-600',
  n8n: 'from-red-500 to-orange-500',
};

const healthDotColor: Record<string, string> = {
  healthy: 'bg-green-400',
  degraded: 'bg-yellow-400 animate-pulse-fast',
  unhealthy: 'bg-red-400',
  unknown: 'bg-slate-500',
};

interface TestResult {
  id: string;
  success: boolean;
  message: string;
  latencyMs: number;
}

export default function IntegrationsPage() {
  const { getIntegrations, updateIntegration, testIntegration } = useTriggerApi();

  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Configure modal state
  const [configIntegration, setConfigIntegration] = useState<Integration | null>(null);
  const [configUrl, setConfigUrl] = useState('');
  const [configEnabled, setConfigEnabled] = useState(true);
  const [configJson, setConfigJson] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchIntegrations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getIntegrations();
      setIntegrations(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, [getIntegrations]);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  const handleTest = async (integrationId: string) => {
    setTestingId(integrationId);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[integrationId];
      return next;
    });
    try {
      const res = await testIntegration(integrationId);
      const result: TestResult = {
        id: integrationId,
        success: res.data.success,
        message: res.data.message,
        latencyMs: res.data.latencyMs,
      };
      setTestResults((prev) => ({ ...prev, [integrationId]: result }));

      // Update health on successful test
      if (res.data.success) {
        setIntegrations((prev) =>
          prev.map((i) =>
            i.id === integrationId
              ? { ...i, health: 'healthy' as const, lastCheckAt: new Date().toISOString() }
              : i
          )
        );
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [integrationId]: {
          id: integrationId,
          success: false,
          message: (err as Error).message || 'Test failed',
          latencyMs: 0,
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (integration: Integration) => {
    setTogglingId(integration.id);
    try {
      await updateIntegration(integration.id, { enabled: !integration.enabled });
      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === integration.id ? { ...i, enabled: !integration.enabled } : i
        )
      );
    } catch (err) {
      setError((err as Error).message || 'Failed to toggle integration');
    } finally {
      setTogglingId(null);
    }
  };

  const openConfigure = (integration: Integration) => {
    setConfigIntegration(integration);
    setConfigUrl(integration.url);
    setConfigEnabled(integration.enabled);
    setConfigJson(JSON.stringify(integration.config || {}, null, 2));
    setSaveError(null);
  };

  const handleSaveConfig = async () => {
    if (!configIntegration) return;
    setSaving(true);
    setSaveError(null);
    try {
      let parsedConfig: Record<string, unknown> | undefined;
      if (configJson.trim() && configJson.trim() !== '{}') {
        parsedConfig = JSON.parse(configJson);
      }

      await updateIntegration(configIntegration.id, {
        url: configUrl,
        enabled: configEnabled,
        config: parsedConfig,
      });

      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === configIntegration.id
            ? { ...i, url: configUrl, enabled: configEnabled, config: parsedConfig }
            : i
        )
      );
      setConfigIntegration(null);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setSaveError('Invalid JSON configuration');
      } else {
        setSaveError((err as Error).message || 'Failed to save configuration');
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-surface-overlay rounded animate-pulse" />
          <div className="h-9 w-24 bg-surface-overlay rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="card h-52 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error && integrations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-slate-200 mb-2">Failed to Load Integrations</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <button onClick={fetchIntegrations} className="btn-primary flex items-center gap-2">
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Integration Hub</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Connect and manage Nexus service integrations
          </p>
        </div>
        <button onClick={fetchIntegrations} className="btn-secondary flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Integration cards grid */}
      {integrations.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16">
          <Plug className="h-12 w-12 text-slate-600 mb-4" />
          <h2 className="text-lg font-semibold text-slate-300 mb-2">No Integrations</h2>
          <p className="text-sm text-slate-500">
            No service integrations are configured. Check your deployment configuration.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {integrations.map((integration) => {
            const serviceKey = integration.service.toLowerCase().replace(/[-_\s]/g, '');
            const iconText = SERVICE_ICONS[serviceKey] || integration.service.slice(0, 2).toUpperCase();
            const gradient = SERVICE_COLORS[serviceKey] || 'from-slate-600 to-slate-700';
            const dotColor = healthDotColor[integration.health] || healthDotColor.unknown;
            const thisTestResult = testResults[integration.id];

            return (
              <div
                key={integration.id}
                className={clsx(
                  'card flex flex-col transition-all hover:border-border-hover',
                  !integration.enabled && 'opacity-60'
                )}
              >
                {/* Card header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={clsx(
                        'h-10 w-10 rounded-lg bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold shrink-0',
                        gradient
                      )}
                    >
                      {iconText}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-slate-200">
                          {integration.displayName}
                        </h3>
                        <span className={clsx('h-2 w-2 rounded-full shrink-0', dotColor)} />
                      </div>
                      <p className="text-xs text-slate-500">{integration.service}</p>
                    </div>
                  </div>

                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(integration)}
                    disabled={togglingId === integration.id}
                    className={clsx(
                      'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                      integration.enabled ? 'bg-accent' : 'bg-surface-overlay'
                    )}
                    title={integration.enabled ? 'Disable' : 'Enable'}
                  >
                    <span
                      className={clsx(
                        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                        integration.enabled ? 'translate-x-4' : 'translate-x-0'
                      )}
                    />
                  </button>
                </div>

                {/* Health badge and last checked */}
                <div className="flex items-center gap-2 mb-3">
                  <StatusBadge status={integration.health} showDot={false} />
                  {integration.lastCheckAt && (
                    <span className="text-xs text-slate-600">
                      Checked {format(new Date(integration.lastCheckAt), 'HH:mm:ss')}
                    </span>
                  )}
                </div>

                {/* URL */}
                {integration.url && (
                  <a
                    href={integration.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-slate-500 hover:text-accent flex items-center gap-1 truncate mb-3 transition-colors"
                  >
                    {integration.url}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                )}

                {/* Task templates */}
                <div className="mb-3">
                  <p className="text-xs text-slate-500 mb-1">
                    {integration.taskTemplates.length} task template{integration.taskTemplates.length !== 1 ? 's' : ''}
                  </p>
                  {integration.taskTemplates.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {integration.taskTemplates.slice(0, 4).map((t) => (
                        <span
                          key={t.id}
                          className="text-xs px-2 py-0.5 bg-surface-overlay rounded text-slate-400 truncate max-w-[120px]"
                          title={t.description}
                        >
                          {t.name}
                        </span>
                      ))}
                      {integration.taskTemplates.length > 4 && (
                        <span className="text-xs text-slate-600 px-1">
                          +{integration.taskTemplates.length - 4} more
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Test result */}
                {thisTestResult && (
                  <div
                    className={clsx(
                      'px-3 py-2 rounded-md text-xs mb-3 flex items-center gap-2',
                      thisTestResult.success
                        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                        : 'bg-red-500/10 text-red-400 border border-red-500/20'
                    )}
                  >
                    {thisTestResult.success ? (
                      <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{thisTestResult.message}</span>
                    {thisTestResult.latencyMs > 0 && (
                      <span className="text-slate-500 shrink-0 ml-auto">
                        {thisTestResult.latencyMs}ms
                      </span>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="mt-auto pt-3 border-t border-border flex items-center gap-2">
                  <button
                    onClick={() => handleTest(integration.id)}
                    disabled={testingId === integration.id}
                    className="btn-secondary !px-2.5 !py-1.5 text-xs flex items-center gap-1.5 flex-1 justify-center"
                  >
                    {testingId === integration.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Zap className="h-3 w-3" />
                    )}
                    {testingId === integration.id ? 'Testing...' : 'Test'}
                  </button>
                  <button
                    onClick={() => openConfigure(integration)}
                    className="btn-secondary !px-2.5 !py-1.5 text-xs flex items-center gap-1.5 flex-1 justify-center"
                  >
                    <Settings className="h-3 w-3" />
                    Configure
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Configure Modal */}
      {configIntegration && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setConfigIntegration(null)}
          />
          <div className="relative z-50 w-full max-w-lg mx-4 bg-surface-raised border border-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                {(() => {
                  const serviceKey = configIntegration.service.toLowerCase().replace(/[-_\s]/g, '');
                  const iconText = SERVICE_ICONS[serviceKey] || configIntegration.service.slice(0, 2).toUpperCase();
                  const gradient = SERVICE_COLORS[serviceKey] || 'from-slate-600 to-slate-700';
                  return (
                    <div className={clsx('h-8 w-8 rounded-lg bg-gradient-to-br flex items-center justify-center text-white text-xs font-bold', gradient)}>
                      {iconText}
                    </div>
                  );
                })()}
                <div>
                  <h2 className="text-lg font-semibold text-slate-100">
                    Configure {configIntegration.displayName}
                  </h2>
                  <p className="text-xs text-slate-500">{configIntegration.service}</p>
                </div>
              </div>
              <button
                onClick={() => setConfigIntegration(null)}
                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-surface-overlay transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-6 py-5 space-y-5">
              {/* URL */}
              <div>
                <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2 block">
                  Service URL
                </label>
                <input
                  type="url"
                  value={configUrl}
                  onChange={(e) => setConfigUrl(e.target.value)}
                  placeholder="https://service.nexus.local:8080"
                  className="input-field w-full"
                />
              </div>

              {/* Enable/Disable */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-300">Enabled</p>
                  <p className="text-xs text-slate-500">
                    Allows tasks to connect to this integration
                  </p>
                </div>
                <button
                  onClick={() => setConfigEnabled(!configEnabled)}
                  className={clsx(
                    'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                    configEnabled ? 'bg-accent' : 'bg-surface-overlay'
                  )}
                >
                  <span
                    className={clsx(
                      'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                      configEnabled ? 'translate-x-5' : 'translate-x-0'
                    )}
                  />
                </button>
              </div>

              {/* Test connection in modal */}
              <div>
                <button
                  onClick={() => handleTest(configIntegration.id)}
                  disabled={testingId === configIntegration.id}
                  className="btn-secondary flex items-center gap-2 w-full justify-center"
                >
                  {testingId === configIntegration.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  {testingId === configIntegration.id ? 'Testing Connection...' : 'Test Connection'}
                </button>
                {testResults[configIntegration.id] && (
                  <div
                    className={clsx(
                      'mt-2 px-3 py-2 rounded-md text-xs flex items-center gap-2',
                      testResults[configIntegration.id].success
                        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                        : 'bg-red-500/10 text-red-400 border border-red-500/20'
                    )}
                  >
                    {testResults[configIntegration.id].success ? (
                      <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>{testResults[configIntegration.id].message}</span>
                    {testResults[configIntegration.id].latencyMs > 0 && (
                      <span className="text-slate-500 ml-auto">
                        {testResults[configIntegration.id].latencyMs}ms
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Advanced config JSON */}
              <div>
                <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2 block">
                  Advanced Configuration (JSON)
                </label>
                <JsonEditor
                  value={configJson}
                  onChange={setConfigJson}
                  label="Configuration"
                  maxHeight="200px"
                />
              </div>

              {/* Task templates list */}
              {configIntegration.taskTemplates.length > 0 && (
                <div>
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2">
                    Available Task Templates ({configIntegration.taskTemplates.length})
                  </p>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {configIntegration.taskTemplates.map((tpl) => (
                      <div
                        key={tpl.id}
                        className="flex items-center gap-2 px-3 py-2 bg-surface-overlay rounded-md"
                      >
                        <Zap className="h-3 w-3 text-accent shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs text-slate-300 truncate">{tpl.name}</p>
                          <p className="text-xs text-slate-500 truncate">{tpl.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {saveError && (
                <div className="flex items-center gap-2 text-sm text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {saveError}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
              <button onClick={() => setConfigIntegration(null)} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={handleSaveConfig}
                disabled={saving}
                className="btn-primary flex items-center gap-2"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle className="h-3.5 w-3.5" />
                )}
                {saving ? 'Saving...' : 'Save Configuration'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
