'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  RefreshCw,
  AlertTriangle,
  Rocket,
  CheckCircle,
  Clock,
  Package,
  ArrowUpCircle,
  ChevronDown,
  ChevronRight,
  X,
  Loader2,
} from 'lucide-react';
import { useTriggerApi, Deployment } from '@/hooks/useTriggerApi';
import { apiClient } from '@/lib/api-client';
import StatusBadge from '@/components/common/StatusBadge';
import { format, formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';

export default function DeploymentsPage() {
  const { getDeployments } = useTriggerApi();

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchDeployments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getDeployments();
      setDeployments(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load deployments');
    } finally {
      setLoading(false);
    }
  }, [getDeployments]);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  const activeDeployment = deployments.find((d) => d.status === 'active');

  const handlePromote = async (deploymentId: string) => {
    if (!confirm('Are you sure you want to promote this deployment? This will make it the active deployment.')) return;
    setPromotingId(deploymentId);
    setActionError(null);
    try {
      await apiClient.post(`/deployments/${deploymentId}/promote`);
      await fetchDeployments();
    } catch (err) {
      setActionError((err as Error).message || 'Failed to promote deployment');
    } finally {
      setPromotingId(null);
    }
  };

  if (loading && deployments.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-surface-overlay rounded animate-pulse" />
          <div className="h-9 w-24 bg-surface-overlay rounded animate-pulse" />
        </div>
        <div className="card h-40 animate-pulse" />
        <div className="card h-64 animate-pulse" />
      </div>
    );
  }

  if (error && deployments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-slate-200 mb-2">Failed to Load Deployments</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <button onClick={fetchDeployments} className="btn-primary flex items-center gap-2">
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
          <h1 className="text-xl font-bold text-slate-100">Deployments</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            View deployment history and manage promotions
          </p>
        </div>
        <button onClick={fetchDeployments} className="btn-secondary flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Error banners */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {actionError && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {actionError}
          <button onClick={() => setActionError(null)} className="ml-auto">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Active deployment card */}
      {activeDeployment ? (
        <div className="card border-accent/30">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-accent/10 shrink-0">
              <Rocket className="h-6 w-6 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-lg font-bold text-slate-100">Current Active Deployment</h2>
                <StatusBadge status={activeDeployment.status} size="md" />
                {activeDeployment.promoted && (
                  <span className="text-xs px-2 py-0.5 bg-accent/10 text-accent rounded-full border border-accent/20">
                    Promoted
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-slate-500" />
                  <div>
                    <p className="text-xs text-slate-500">Version</p>
                    <p className="text-sm text-slate-200 font-mono">{activeDeployment.version}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-slate-500" />
                  <div>
                    <p className="text-xs text-slate-500">Tasks</p>
                    <p className="text-sm text-slate-200">{activeDeployment.taskCount} registered</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-slate-500" />
                  <div>
                    <p className="text-xs text-slate-500">Deployed</p>
                    <p className="text-sm text-slate-200">
                      {format(new Date(activeDeployment.deployedAt), 'MMM d yyyy, HH:mm')}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Age</p>
                  <p className="text-sm text-slate-200">
                    {formatDistanceToNow(new Date(activeDeployment.deployedAt), { addSuffix: false })}
                  </p>
                </div>
              </div>

              {activeDeployment.changelog && (
                <div className="mt-4 pt-3 border-t border-border">
                  <p className="text-xs text-slate-500 mb-1">Changelog</p>
                  <p className="text-sm text-slate-300 whitespace-pre-wrap">{activeDeployment.changelog}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="card flex flex-col items-center justify-center py-16">
          <Rocket className="h-12 w-12 text-slate-600 mb-4" />
          <h2 className="text-lg font-semibold text-slate-300 mb-2">No Deployments</h2>
          <p className="text-sm text-slate-500">
            No deployments have been recorded yet. Deploy your tasks to get started.
          </p>
        </div>
      )}

      {/* Deployment history */}
      {deployments.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-200 mb-3">
            Deployment History ({deployments.length})
          </h2>
          <div className="space-y-2">
            {deployments.map((deployment) => {
              const isActive = deployment.status === 'active';
              const isExpanded = expandedId === deployment.id;

              return (
                <div
                  key={deployment.id}
                  className={clsx(
                    'card transition-colors',
                    isActive && 'border-accent/20 bg-accent/5'
                  )}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Expand toggle (if has changelog) */}
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : deployment.id)}
                        className="p-0.5 rounded text-slate-500 hover:text-slate-300 transition-colors shrink-0"
                        disabled={!deployment.changelog}
                      >
                        {deployment.changelog ? (
                          isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )
                        ) : (
                          <div className="h-4 w-4" />
                        )}
                      </button>

                      {/* Version */}
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-slate-200 font-medium">
                          {deployment.version}
                        </span>
                        {deployment.promoted && (
                          <span className="text-xs px-1.5 py-0.5 bg-accent/10 text-accent rounded border border-accent/20">
                            Promoted
                          </span>
                        )}
                        {isActive && (
                          <span className="text-xs px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded border border-green-500/20">
                            Active
                          </span>
                        )}
                      </div>

                      {/* Status */}
                      <StatusBadge status={deployment.status} />

                      {/* Tasks count */}
                      <span className="text-xs text-slate-500 hidden md:inline">
                        {deployment.taskCount} task{deployment.taskCount !== 1 ? 's' : ''}
                      </span>

                      {/* Deployed time */}
                      <span className="text-xs text-slate-400 hidden lg:inline">
                        {format(new Date(deployment.deployedAt), 'MMM d yyyy, HH:mm')}
                      </span>
                      <span className="text-xs text-slate-600 hidden lg:inline">
                        ({formatDistanceToNow(new Date(deployment.deployedAt), { addSuffix: true })})
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {!deployment.promoted && deployment.status !== 'failed' && deployment.status !== 'deploying' && (
                        <button
                          onClick={() => handlePromote(deployment.id)}
                          disabled={promotingId === deployment.id}
                          className="btn-primary !px-3 !py-1.5 text-xs flex items-center gap-1.5"
                        >
                          {promotingId === deployment.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ArrowUpCircle className="h-3.5 w-3.5" />
                          )}
                          {promotingId === deployment.id ? 'Promoting...' : 'Promote'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Mobile metadata */}
                  <div className="flex items-center gap-4 mt-2 ml-7 md:hidden text-xs text-slate-500">
                    <span>{deployment.taskCount} tasks</span>
                    <span>{format(new Date(deployment.deployedAt), 'MMM d, HH:mm')}</span>
                  </div>

                  {/* Expanded changelog */}
                  {isExpanded && deployment.changelog && (
                    <div className="mt-3 ml-7 pt-3 border-t border-border">
                      <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1.5">
                        Changelog
                      </p>
                      <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
                        {deployment.changelog}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
