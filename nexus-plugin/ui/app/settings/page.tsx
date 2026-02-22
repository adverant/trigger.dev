'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Key,
  Globe,
  Webhook,
  Bell,
  RefreshCw,
  Plus,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  AlertTriangle,
  X,
  Settings,
} from 'lucide-react';
import { useTriggerApi, Webhook as WebhookType, Environment } from '@/hooks/useTriggerApi';
import { clsx } from 'clsx';
import { format } from 'date-fns';

type TabKey = 'api-keys' | 'environments' | 'webhooks' | 'notifications';

interface ApiKey {
  id: string;
  name: string;
  maskedKey: string;
  createdAt: string;
}

const EVENT_OPTIONS = [
  'run.completed',
  'run.failed',
  'run.started',
  'run.canceled',
  'task.registered',
  'schedule.fired',
  'waitpoint.created',
  'waitpoint.resolved',
  'deployment.active',
];

export default function SettingsPage() {
  const {
    getApiKeys,
    regenerateApiKey,
    getEnvironments,
    getWebhooks,
    createWebhook,
    deleteWebhook,
  } = useTriggerApi();

  const [activeTab, setActiveTab] = useState<TabKey>('api-keys');

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ id: string; key: string } | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  // Environments state
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [envsLoading, setEnvsLoading] = useState(true);

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookType[]>([]);
  const [webhooksLoading, setWebhooksLoading] = useState(true);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>([]);
  const [webhookCreating, setWebhookCreating] = useState(false);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [deletingWebhookId, setDeletingWebhookId] = useState<string | null>(null);

  // Notifications state
  const [notifRunFailed, setNotifRunFailed] = useState(true);
  const [notifWaitpoint, setNotifWaitpoint] = useState(true);
  const [notifDeployment, setNotifDeployment] = useState(false);
  const [notifScheduleError, setNotifScheduleError] = useState(true);

  const [error, setError] = useState<string | null>(null);

  // Fetch data based on active tab
  const fetchApiKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await getApiKeys();
      setApiKeys(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load API keys');
    } finally {
      setKeysLoading(false);
    }
  }, [getApiKeys]);

  const fetchEnvironments = useCallback(async () => {
    setEnvsLoading(true);
    try {
      const res = await getEnvironments();
      setEnvironments(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load environments');
    } finally {
      setEnvsLoading(false);
    }
  }, [getEnvironments]);

  const fetchWebhooks = useCallback(async () => {
    setWebhooksLoading(true);
    try {
      const res = await getWebhooks();
      setWebhooks(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load webhooks');
    } finally {
      setWebhooksLoading(false);
    }
  }, [getWebhooks]);

  useEffect(() => {
    if (activeTab === 'api-keys') fetchApiKeys();
    if (activeTab === 'environments') fetchEnvironments();
    if (activeTab === 'webhooks') fetchWebhooks();
  }, [activeTab, fetchApiKeys, fetchEnvironments, fetchWebhooks]);

  const handleRegenerateKey = async (keyId: string) => {
    setRegeneratingId(keyId);
    try {
      const res = await regenerateApiKey(keyId);
      setRevealedKey({ id: keyId, key: res.data.key });
      await fetchApiKeys();
    } catch (err) {
      setError((err as Error).message || 'Failed to regenerate key');
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleCopyKey = async (keyId: string, key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKeyId(keyId);
      setTimeout(() => setCopiedKeyId(null), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  const handleCreateWebhook = async () => {
    if (!newWebhookUrl) {
      setWebhookError('URL is required');
      return;
    }
    if (newWebhookEvents.length === 0) {
      setWebhookError('Select at least one event');
      return;
    }
    setWebhookCreating(true);
    setWebhookError(null);
    try {
      await createWebhook({ url: newWebhookUrl, events: newWebhookEvents });
      setShowWebhookModal(false);
      setNewWebhookUrl('');
      setNewWebhookEvents([]);
      await fetchWebhooks();
    } catch (err) {
      setWebhookError((err as Error).message || 'Failed to create webhook');
    } finally {
      setWebhookCreating(false);
    }
  };

  const handleDeleteWebhook = async (webhookId: string) => {
    setDeletingWebhookId(webhookId);
    try {
      await deleteWebhook(webhookId);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
    } catch (err) {
      setError((err as Error).message || 'Failed to delete webhook');
    } finally {
      setDeletingWebhookId(null);
    }
  };

  const toggleWebhookEvent = (event: string) => {
    setNewWebhookEvents((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event]
    );
  };

  const tabs: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: 'api-keys', label: 'API Keys', icon: Key },
    { key: 'environments', label: 'Environments', icon: Globe },
    { key: 'webhooks', label: 'Webhooks', icon: Webhook },
    { key: 'notifications', label: 'Notifications', icon: Bell },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Manage API keys, environments, webhooks, and notification preferences
        </p>
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

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
                  activeTab === tab.key
                    ? 'border-accent text-accent'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div>
        {/* API Keys Tab */}
        {activeTab === 'api-keys' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-400">
                Manage API keys used to authenticate with the Trigger.dev API.
              </p>
              <button onClick={fetchApiKeys} className="btn-secondary flex items-center gap-1.5 text-xs">
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>

            {/* Revealed key alert */}
            {revealedKey && (
              <div className="card border-amber-500/20 bg-amber-500/5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-amber-400 mb-1">
                      New API Key Generated
                    </p>
                    <p className="text-xs text-slate-400 mb-2">
                      Copy this key now. It will not be shown again.
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="bg-surface-overlay px-3 py-1.5 rounded font-mono text-sm text-slate-200 select-all">
                        {revealedKey.key}
                      </code>
                      <button
                        onClick={() => handleCopyKey(revealedKey.id, revealedKey.key)}
                        className="p-1.5 rounded hover:bg-surface-overlay transition-colors"
                      >
                        {copiedKeyId === revealedKey.id ? (
                          <Check className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4 text-slate-400" />
                        )}
                      </button>
                    </div>
                  </div>
                  <button
                    onClick={() => setRevealedKey(null)}
                    className="p-1 rounded text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {keysLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="card h-16 animate-pulse" />
                ))}
              </div>
            ) : apiKeys.length === 0 ? (
              <div className="card flex flex-col items-center justify-center py-12">
                <Key className="h-10 w-10 text-slate-600 mb-3" />
                <p className="text-sm text-slate-400">No API keys configured</p>
              </div>
            ) : (
              <div className="space-y-3">
                {apiKeys.map((key) => (
                  <div key={key.id} className="card flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-200">{key.name}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <code className="text-xs font-mono text-slate-400">{key.maskedKey}</code>
                        <span className="text-xs text-slate-500">
                          Created {format(new Date(key.createdAt), 'MMM d yyyy')}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRegenerateKey(key.id)}
                      disabled={regeneratingId === key.id}
                      className="btn-secondary !px-3 !py-1.5 text-xs flex items-center gap-1.5"
                    >
                      <RefreshCw className={clsx('h-3 w-3', regeneratingId === key.id && 'animate-spin')} />
                      {regeneratingId === key.id ? 'Regenerating...' : 'Regenerate'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Environments Tab */}
        {activeTab === 'environments' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Deployment environments for task isolation.
            </p>

            {envsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="card h-20 animate-pulse" />
                ))}
              </div>
            ) : environments.length === 0 ? (
              <div className="card flex flex-col items-center justify-center py-12">
                <Globe className="h-10 w-10 text-slate-600 mb-3" />
                <p className="text-sm text-slate-400">No environments configured</p>
              </div>
            ) : (
              <div className="space-y-3">
                {environments.map((env) => (
                  <div
                    key={env.id}
                    className={clsx(
                      'card flex items-center justify-between',
                      env.current && 'border-accent/30'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={clsx(
                          'h-3 w-3 rounded-full',
                          env.current ? 'bg-green-400' : 'bg-slate-600'
                        )}
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-slate-200">{env.name}</p>
                          {env.current && (
                            <span className="text-xs px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded">
                              Active
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs text-slate-500 font-mono">{env.slug}</span>
                          {env.apiUrl && (
                            <span className="text-xs text-slate-500">{env.apiUrl}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Webhooks Tab */}
        {activeTab === 'webhooks' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-400">
                Receive HTTP callbacks when events occur.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={fetchWebhooks} className="btn-secondary flex items-center gap-1.5 text-xs">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
                <button
                  onClick={() => setShowWebhookModal(true)}
                  className="btn-primary flex items-center gap-1.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Webhook
                </button>
              </div>
            </div>

            {webhooksLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="card h-20 animate-pulse" />
                ))}
              </div>
            ) : webhooks.length === 0 ? (
              <div className="card flex flex-col items-center justify-center py-12">
                <Webhook className="h-10 w-10 text-slate-600 mb-3" />
                <p className="text-sm text-slate-400">No webhooks configured</p>
                <button
                  onClick={() => setShowWebhookModal(true)}
                  className="btn-primary text-xs mt-4 flex items-center gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Webhook
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {webhooks.map((wh) => (
                  <div key={wh.id} className="card">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <code className="text-sm text-slate-200 font-mono break-all">{wh.url}</code>
                          <span
                            className={clsx(
                              'text-xs px-1.5 py-0.5 rounded',
                              wh.enabled
                                ? 'bg-green-500/10 text-green-400'
                                : 'bg-slate-500/10 text-slate-400'
                            )}
                          >
                            {wh.enabled ? 'Active' : 'Disabled'}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {wh.events.map((evt) => (
                            <span key={evt} className="text-xs bg-surface-overlay px-2 py-0.5 rounded text-slate-400">
                              {evt}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-slate-500 mt-2">
                          Created {format(new Date(wh.createdAt), 'MMM d yyyy, HH:mm')}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeleteWebhook(wh.id)}
                        disabled={deletingWebhookId === wh.id}
                        className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notifications Tab */}
        {activeTab === 'notifications' && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Configure which events trigger in-app notifications.
            </p>

            <div className="card space-y-4">
              <NotifToggle
                label="Run Failed"
                description="Notify when a task run fails"
                enabled={notifRunFailed}
                onChange={setNotifRunFailed}
              />
              <NotifToggle
                label="Waitpoint Created"
                description="Notify when a new human-in-the-loop approval is needed"
                enabled={notifWaitpoint}
                onChange={setNotifWaitpoint}
              />
              <NotifToggle
                label="Deployment Active"
                description="Notify when a new deployment becomes active"
                enabled={notifDeployment}
                onChange={setNotifDeployment}
              />
              <NotifToggle
                label="Schedule Error"
                description="Notify when a scheduled job fails to fire"
                enabled={notifScheduleError}
                onChange={setNotifScheduleError}
              />
            </div>
          </div>
        )}
      </div>

      {/* Create Webhook Modal */}
      {showWebhookModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowWebhookModal(false)}
          />
          <div className="relative z-50 w-full max-w-lg mx-4 bg-surface-raised border border-border rounded-xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-slate-100">Add Webhook</h2>
              <button
                onClick={() => setShowWebhookModal(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-surface-overlay transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div>
                <label className="text-sm font-medium text-slate-300 mb-1.5 block">
                  Endpoint URL
                </label>
                <input
                  type="url"
                  value={newWebhookUrl}
                  onChange={(e) => setNewWebhookUrl(e.target.value)}
                  placeholder="https://example.com/webhooks/trigger"
                  className="input-field w-full"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-slate-300 mb-2 block">Events</label>
                <div className="grid grid-cols-2 gap-2">
                  {EVENT_OPTIONS.map((evt) => (
                    <label
                      key={evt}
                      className={clsx(
                        'flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer transition-colors',
                        newWebhookEvents.includes(evt)
                          ? 'bg-accent/10 border-accent/30 text-accent'
                          : 'bg-surface-overlay border-border text-slate-400 hover:border-border-hover'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={newWebhookEvents.includes(evt)}
                        onChange={() => toggleWebhookEvent(evt)}
                        className="sr-only"
                      />
                      <span
                        className={clsx(
                          'h-4 w-4 rounded border flex items-center justify-center',
                          newWebhookEvents.includes(evt)
                            ? 'bg-accent border-accent'
                            : 'border-slate-600'
                        )}
                      >
                        {newWebhookEvents.includes(evt) && (
                          <Check className="h-3 w-3 text-white" />
                        )}
                      </span>
                      <span className="text-xs">{evt}</span>
                    </label>
                  ))}
                </div>
              </div>

              {webhookError && (
                <div className="flex items-center gap-2 text-sm text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {webhookError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
              <button onClick={() => setShowWebhookModal(false)} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={handleCreateWebhook}
                disabled={webhookCreating}
                className="btn-primary flex items-center gap-2"
              >
                <Plus className="h-3.5 w-3.5" />
                {webhookCreating ? 'Creating...' : 'Create Webhook'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Notification toggle sub-component
function NotifToggle({
  label,
  description,
  enabled,
  onChange,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm font-medium text-slate-200">{label}</p>
        <p className="text-xs text-slate-500 mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={clsx(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
          enabled ? 'bg-accent' : 'bg-surface-overlay'
        )}
      >
        <span
          className={clsx(
            'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
            enabled ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  );
}
