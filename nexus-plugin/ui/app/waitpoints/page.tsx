'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Timer,
  Clock,
  X,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useTriggerApi, Waitpoint } from '@/hooks/useTriggerApi';
import { useSocket } from '@/hooks/useSocket';
import StatusBadge from '@/components/common/StatusBadge';
import JsonEditor from '@/components/common/JsonEditor';
import { format, formatDistanceToNow, isPast } from 'date-fns';
import { clsx } from 'clsx';
import { WaitpointEvent } from '@/lib/socket-client';

export default function WaitpointsPage() {
  const router = useRouter();
  const { getWaitpoints, resolveWaitpoint } = useTriggerApi();
  const { socket, connected } = useSocket();

  const [waitpoints, setWaitpoints] = useState<Waitpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Resolve modal state
  const [resolveModalWp, setResolveModalWp] = useState<Waitpoint | null>(null);
  const [resolveAction, setResolveAction] = useState<'approve' | 'reject'>('approve');
  const [resolveOutput, setResolveOutput] = useState('{}');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const fetchWaitpoints = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getWaitpoints({ status: statusFilter || undefined });
      setWaitpoints(res.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load waitpoints');
    } finally {
      setLoading(false);
    }
  }, [getWaitpoints, statusFilter]);

  useEffect(() => {
    fetchWaitpoints();
  }, [fetchWaitpoints]);

  // Auto-refresh pending waitpoints every 15 seconds
  useEffect(() => {
    if (statusFilter !== 'pending') return;
    const interval = setInterval(fetchWaitpoints, 15000);
    return () => clearInterval(interval);
  }, [fetchWaitpoints, statusFilter]);

  // Listen for real-time waitpoint events
  useEffect(() => {
    if (!socket || !connected) return;

    const onWaitpointEvent = (event: WaitpointEvent) => {
      if (event.type === 'created') {
        fetchWaitpoints();
      } else if (event.type === 'resolved' || event.type === 'expired') {
        setWaitpoints((prev) =>
          prev.map((wp) =>
            wp.id === event.waitpointId
              ? { ...wp, status: event.type === 'resolved' ? 'resolved' : 'expired' }
              : wp
          )
        );
      }
    };

    socket.on('waitpoint_event', onWaitpointEvent);
    return () => {
      socket.off('waitpoint_event', onWaitpointEvent);
    };
  }, [socket, connected, fetchWaitpoints]);

  const pendingCount = waitpoints.filter((w) => w.status === 'pending').length;

  const openResolveModal = (wp: Waitpoint, action: 'approve' | 'reject') => {
    setResolveModalWp(wp);
    setResolveAction(action);
    setResolveOutput('{}');
    setResolveError(null);
  };

  const handleResolve = async () => {
    if (!resolveModalWp) return;
    setResolving(true);
    setResolveError(null);
    try {
      let parsedOutput: unknown = undefined;
      if (resolveOutput.trim() && resolveOutput.trim() !== '{}') {
        parsedOutput = JSON.parse(resolveOutput);
      }

      await resolveWaitpoint(resolveModalWp.id, {
        approved: resolveAction === 'approve',
        output: parsedOutput,
      });

      setResolveModalWp(null);

      // Optimistic update
      setWaitpoints((prev) =>
        prev.map((wp) =>
          wp.id === resolveModalWp.id
            ? {
                ...wp,
                status: resolveAction === 'approve' ? ('resolved' as const) : ('expired' as const),
                resolvedAt: new Date().toISOString(),
              }
            : wp
        )
      );
    } catch (err) {
      if (err instanceof SyntaxError) {
        setResolveError('Invalid JSON output');
      } else {
        setResolveError((err as Error).message || 'Failed to resolve waitpoint');
      }
    } finally {
      setResolving(false);
    }
  };

  if (loading && waitpoints.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-56 bg-surface-overlay rounded animate-pulse" />
          <div className="h-9 w-24 bg-surface-overlay rounded animate-pulse" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card h-24 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error && waitpoints.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-slate-200 mb-2">Failed to Load Waitpoints</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <button onClick={fetchWaitpoints} className="btn-primary flex items-center gap-2">
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
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-100">Waitpoint Queue</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Review and resolve pending human-in-the-loop approvals
            </p>
          </div>
          {pendingCount > 0 && (
            <span className="inline-flex items-center justify-center h-6 min-w-[24px] px-2 rounded-full bg-yellow-500/15 text-yellow-400 text-xs font-semibold border border-yellow-500/30">
              {pendingCount}
            </span>
          )}
        </div>
        <button onClick={fetchWaitpoints} className="btn-secondary flex items-center gap-2">
          <RefreshCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2">
        {['pending', 'resolved', 'expired', ''].map((status) => (
          <button
            key={status || 'all'}
            onClick={() => setStatusFilter(status)}
            className={clsx(
              'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
              statusFilter === status
                ? 'bg-accent/15 text-accent border-accent/30'
                : 'bg-surface-overlay text-slate-400 border-border hover:border-border-hover'
            )}
          >
            {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'All'}
          </button>
        ))}
        <span className="text-xs text-slate-500 ml-2">
          {waitpoints.length} waitpoint{waitpoints.length !== 1 ? 's' : ''}
        </span>
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

      {/* Waitpoint list */}
      {waitpoints.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16">
          <Timer className="h-12 w-12 text-slate-600 mb-4" />
          <h2 className="text-lg font-semibold text-slate-300 mb-2">No Waitpoints</h2>
          <p className="text-sm text-slate-500">
            {statusFilter === 'pending'
              ? 'No pending approvals at this time.'
              : 'No waitpoints match the selected filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {waitpoints.map((wp) => {
            const isExpired = wp.expiresAt ? isPast(new Date(wp.expiresAt)) : false;
            const expanded = expandedId === wp.id;

            return (
              <div key={wp.id} className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    {/* Top row */}
                    <div className="flex items-center gap-3 mb-2">
                      <button
                        onClick={() => setExpandedId(expanded ? null : wp.id)}
                        className="p-0.5 rounded text-slate-500 hover:text-slate-300 transition-colors"
                      >
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                      <h3 className="text-sm font-semibold text-slate-200">
                        {wp.description || `Waitpoint ${wp.id.slice(0, 12)}`}
                      </h3>
                      <StatusBadge status={wp.status} />
                    </div>

                    {/* Metadata row */}
                    <div className="flex items-center gap-4 ml-7 text-xs text-slate-500 flex-wrap">
                      <span>
                        Task: <code className="text-slate-400">{wp.taskId}</code>
                      </span>
                      <button
                        onClick={() => router.push(`/runs/${wp.runId}`)}
                        className="flex items-center gap-1 text-accent hover:text-accent-hover transition-colors"
                      >
                        Run: {wp.runId.slice(0, 12)}...
                        <ExternalLink className="h-3 w-3" />
                      </button>
                      <span>
                        Created: {format(new Date(wp.createdAt), 'MMM d, HH:mm:ss')}
                      </span>
                    </div>

                    {/* Expiry countdown */}
                    {wp.expiresAt && wp.status === 'pending' && (
                      <div className="flex items-center gap-1.5 mt-2 ml-7">
                        <Clock className={clsx('h-3.5 w-3.5', isExpired ? 'text-red-400' : 'text-amber-400')} />
                        <span className={clsx('text-xs', isExpired ? 'text-red-400' : 'text-amber-400')}>
                          {isExpired
                            ? 'Expired'
                            : `Expires ${formatDistanceToNow(new Date(wp.expiresAt), { addSuffix: true })}`}
                        </span>
                        <span className="text-xs text-slate-600 ml-1">
                          ({format(new Date(wp.expiresAt), 'MMM d, HH:mm:ss')})
                        </span>
                      </div>
                    )}

                    {/* Expanded details */}
                    {expanded && (
                      <div className="mt-4 ml-7 pt-3 border-t border-border space-y-3">
                        <div className="grid grid-cols-2 gap-4 text-xs">
                          <div>
                            <p className="text-slate-500 mb-0.5">Waitpoint ID</p>
                            <p className="text-slate-300 font-mono break-all">{wp.id}</p>
                          </div>
                          <div>
                            <p className="text-slate-500 mb-0.5">Run ID</p>
                            <p className="text-slate-300 font-mono break-all">{wp.runId}</p>
                          </div>
                        </div>

                        {wp.inputData && (
                          <div>
                            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1.5">
                              Input Data
                            </p>
                            <JsonEditor
                              value={JSON.stringify(wp.inputData, null, 2)}
                              readOnly
                              label="Input"
                              maxHeight="200px"
                            />
                          </div>
                        )}
                        {wp.outputData && (
                          <div>
                            <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1.5">
                              Output Data
                            </p>
                            <JsonEditor
                              value={JSON.stringify(wp.outputData, null, 2)}
                              readOnly
                              label="Output"
                              maxHeight="200px"
                            />
                          </div>
                        )}
                        {wp.resolvedAt && (
                          <p className="text-xs text-slate-500">
                            Resolved at: {format(new Date(wp.resolvedAt), 'MMM d yyyy, HH:mm:ss')}
                          </p>
                        )}
                        {!wp.inputData && !wp.outputData && !wp.resolvedAt && (
                          <p className="text-xs text-slate-500">No additional data</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Action buttons - only for pending */}
                  {wp.status === 'pending' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => openResolveModal(wp, 'reject')}
                        className="btn-danger !px-3 !py-1.5 text-xs flex items-center gap-1.5"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </button>
                      <button
                        onClick={() => openResolveModal(wp, 'approve')}
                        className="btn-success !px-3 !py-1.5 text-xs flex items-center gap-1.5"
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        Approve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Resolve Confirmation Modal */}
      {resolveModalWp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setResolveModalWp(null)}
          />
          <div className="relative z-50 w-full max-w-lg mx-4 bg-surface-raised border border-border rounded-xl shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                {resolveAction === 'approve' ? (
                  <div className="p-1.5 rounded-lg bg-green-500/10">
                    <CheckCircle className="h-5 w-5 text-green-400" />
                  </div>
                ) : (
                  <div className="p-1.5 rounded-lg bg-red-500/10">
                    <XCircle className="h-5 w-5 text-red-400" />
                  </div>
                )}
                <h2 className="text-lg font-semibold text-slate-200">
                  {resolveAction === 'approve' ? 'Approve' : 'Reject'} Waitpoint
                </h2>
              </div>
              <button
                onClick={() => setResolveModalWp(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-surface-overlay transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-6 py-4 space-y-4">
              <div className="text-sm text-slate-300">
                <p>
                  You are about to{' '}
                  <span
                    className={
                      resolveAction === 'approve'
                        ? 'text-green-400 font-medium'
                        : 'text-red-400 font-medium'
                    }
                  >
                    {resolveAction}
                  </span>{' '}
                  the following waitpoint:
                </p>
                <div className="mt-2 bg-surface-overlay px-3 py-2 rounded-md">
                  <p className="text-slate-200 font-medium text-sm">
                    {resolveModalWp.description || resolveModalWp.id}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Task: {resolveModalWp.taskId} | Run: {resolveModalWp.runId.slice(0, 16)}...
                  </p>
                </div>
              </div>

              {/* Input data preview */}
              {resolveModalWp.inputData && (
                <div>
                  <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1.5">
                    Input Data (read-only)
                  </p>
                  <JsonEditor
                    value={JSON.stringify(resolveModalWp.inputData, null, 2)}
                    readOnly
                    label="Input"
                    maxHeight="150px"
                  />
                </div>
              )}

              {/* Output editor */}
              <div>
                <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2 block">
                  Response Output (optional)
                </label>
                <JsonEditor
                  value={resolveOutput}
                  onChange={setResolveOutput}
                  label="Output"
                  maxHeight="200px"
                />
              </div>

              {resolveError && (
                <div className="flex items-center gap-2 text-sm text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {resolveError}
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
              <button onClick={() => setResolveModalWp(null)} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={handleResolve}
                disabled={resolving}
                className={clsx(
                  'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white transition-colors',
                  resolveAction === 'approve'
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-red-600 hover:bg-red-700'
                )}
              >
                {resolving ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : resolveAction === 'approve' ? (
                  <CheckCircle className="h-3.5 w-3.5" />
                ) : (
                  <XCircle className="h-3.5 w-3.5" />
                )}
                {resolving
                  ? 'Processing...'
                  : resolveAction === 'approve'
                    ? 'Confirm Approve'
                    : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
