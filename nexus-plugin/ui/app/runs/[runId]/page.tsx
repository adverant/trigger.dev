'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  XCircle,
  RotateCcw,
  Clock,
  AlertTriangle,
  RefreshCw,
  Terminal,
  FileJson,
  Info,
} from 'lucide-react';
import { useTriggerApi, Run } from '@/hooks/useTriggerApi';
import { useRunStream } from '@/hooks/useRunStream';
import StatusBadge from '@/components/common/StatusBadge';
import JsonEditor from '@/components/common/JsonEditor';
import { format } from 'date-fns';
import { clsx } from 'clsx';
import { RunLogEvent } from '@/lib/socket-client';

type TabKey = 'logs' | 'output' | 'metadata';

const logLevelColors: Record<string, string> = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
  debug: 'text-slate-500',
};

function LogLine({ log }: { log: RunLogEvent }) {
  return (
    <div className="flex gap-3 px-3 py-1.5 hover:bg-surface-overlay/30 font-mono text-xs leading-relaxed">
      <span className="text-slate-600 shrink-0 w-20">
        {format(new Date(log.timestamp), 'HH:mm:ss.SSS')}
      </span>
      <span className={clsx('uppercase font-medium w-12 shrink-0', logLevelColors[log.level] || 'text-slate-400')}>
        {log.level}
      </span>
      <span className="text-slate-300 break-all">{log.message}</span>
      {log.data && (
        <span className="text-slate-500 truncate ml-2">
          {JSON.stringify(log.data).slice(0, 120)}
        </span>
      )}
    </div>
  );
}

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const runId = params.runId as string;
  const { getRun, getRunLogs, cancelRun, replayRun } = useTriggerApi();

  const [run, setRun] = useState<Run | null>(null);
  const [initialLogs, setInitialLogs] = useState<RunLogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('logs');
  const [cancelling, setCancelling] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const logContainerRef = useRef<HTMLDivElement>(null);

  // Live streaming via websocket
  const {
    logs: streamLogs,
    status: streamStatus,
    output: streamOutput,
    isStreaming,
  } = useRunStream({ runId, enabled: true });

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [runRes, logsRes] = await Promise.all([
        getRun(runId),
        getRunLogs(runId),
      ]);
      setRun(runRes.data);
      setInitialLogs(
        logsRes.data.map((l) => ({
          runId,
          level: l.level as RunLogEvent['level'],
          message: l.message,
          timestamp: l.timestamp,
          data: l.data,
        }))
      );
    } catch (err) {
      setError((err as Error).message || 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }, [runId, getRun, getRunLogs]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Update run status from stream
  useEffect(() => {
    if (streamStatus && run) {
      setRun((prev) => (prev ? { ...prev, status: streamStatus } : prev));
    }
  }, [streamStatus, run]);

  // Auto-scroll logs
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [streamLogs, initialLogs]);

  const allLogs = [...initialLogs, ...streamLogs];

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await cancelRun(runId);
      await fetchData();
    } catch (err) {
      setError((err as Error).message || 'Failed to cancel run');
    } finally {
      setCancelling(false);
    }
  };

  const handleReplay = async () => {
    setReplaying(true);
    try {
      const response = await replayRun(runId);
      router.push(`/trigger/ui/runs/${response.data.id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to replay run');
    } finally {
      setReplaying(false);
    }
  };

  const isTerminal = run && ['COMPLETED', 'FAILED', 'CANCELED'].includes(run.status);
  const output = streamOutput ?? run?.output;

  const tabs: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: 'logs', label: 'Logs', icon: Terminal },
    { key: 'output', label: 'Output', icon: FileJson },
    { key: 'metadata', label: 'Metadata', icon: Info },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface-overlay rounded animate-pulse" />
        <div className="card h-20 animate-pulse" />
        <div className="card h-96 animate-pulse" />
      </div>
    );
  }

  if (error && !run) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-slate-200 mb-2">Run Not Found</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <button onClick={() => router.push('/trigger/ui/runs')} className="btn-secondary">
          Back to Runs
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <button
        onClick={() => router.push('/trigger/ui/runs')}
        className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Runs
      </button>

      {/* Status header */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <StatusBadge status={run!.status} size="md" />
            <div>
              <h1 className="text-lg font-bold text-slate-100 font-mono">{run!.id}</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                Task: <span className="text-slate-300">{run!.taskSlug}</span>
                {isStreaming && (
                  <span className="ml-3 inline-flex items-center gap-1 text-blue-400">
                    <span className="h-1.5 w-1.5 bg-blue-400 rounded-full animate-pulse-fast" />
                    Live
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isTerminal && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="btn-danger flex items-center gap-1.5 text-sm"
              >
                <XCircle className="h-3.5 w-3.5" />
                {cancelling ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
            <button
              onClick={handleReplay}
              disabled={replaying}
              className="btn-secondary flex items-center gap-1.5 text-sm"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {replaying ? 'Replaying...' : 'Replay'}
            </button>
            <button onClick={fetchData} className="btn-secondary flex items-center gap-1.5 text-sm">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Timing info */}
        <div className="flex items-center gap-6 mt-4 text-xs text-slate-400">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            <span>
              Started: {run!.startedAt ? format(new Date(run!.startedAt), 'MMM d yyyy, HH:mm:ss') : 'Pending'}
            </span>
          </div>
          {run!.completedAt && (
            <span>
              Completed: {format(new Date(run!.completedAt), 'MMM d yyyy, HH:mm:ss')}
            </span>
          )}
          {run!.duration != null && (
            <span>Duration: {(run!.duration / 1000).toFixed(2)}s</span>
          )}
        </div>

        {/* Error display */}
        {run!.error && (
          <div className="mt-4 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-md text-sm text-red-400">
            {run!.error}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div>
        <div className="flex border-b border-border">
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
                {tab.key === 'logs' && allLogs.length > 0 && (
                  <span className="ml-1 text-xs bg-surface-overlay px-1.5 py-0.5 rounded-full">
                    {allLogs.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="mt-4">
          {activeTab === 'logs' && (
            <div className="card !p-0">
              <div
                ref={logContainerRef}
                className="overflow-y-auto max-h-[500px] divide-y divide-border/30"
              >
                {allLogs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                    <Terminal className="h-8 w-8 mb-3 opacity-50" />
                    <p className="text-sm">No log entries yet</p>
                    {isStreaming && (
                      <p className="text-xs mt-1">Waiting for log output...</p>
                    )}
                  </div>
                ) : (
                  allLogs.map((log, i) => <LogLine key={i} log={log} />)
                )}
              </div>
            </div>
          )}

          {activeTab === 'output' && (
            <div>
              {output != null ? (
                <JsonEditor
                  value={JSON.stringify(output, null, 2)}
                  readOnly
                  label="Run Output"
                  maxHeight="500px"
                />
              ) : (
                <div className="card flex flex-col items-center justify-center py-16 text-slate-500">
                  <FileJson className="h-8 w-8 mb-3 opacity-50" />
                  <p className="text-sm">No output data available</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'metadata' && (
            <div className="space-y-4">
              {/* Run metadata */}
              <div className="card">
                <h3 className="text-sm font-semibold text-slate-200 mb-3">Run Details</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-500">Run ID</p>
                    <p className="text-slate-300 font-mono text-xs break-all">{run!.id}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Task ID</p>
                    <p className="text-slate-300 font-mono text-xs">{run!.taskId}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Task Slug</p>
                    <p className="text-slate-300">{run!.taskSlug}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Version</p>
                    <p className="text-slate-300 font-mono text-xs">{run!.version || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Test Run</p>
                    <p className="text-slate-300">{run!.isTest ? 'Yes' : 'No'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Idempotency Key</p>
                    <p className="text-slate-300 font-mono text-xs break-all">{run!.idempotencyKey || '-'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Created</p>
                    <p className="text-slate-300 text-xs">
                      {format(new Date(run!.createdAt), 'MMM d yyyy, HH:mm:ss')}
                    </p>
                  </div>
                  {run!.tags && run!.tags.length > 0 && (
                    <div className="col-span-full">
                      <p className="text-xs text-slate-500 mb-1">Tags</p>
                      <div className="flex flex-wrap gap-1.5">
                        {run!.tags.map((tag) => (
                          <span key={tag} className="text-xs bg-surface-overlay px-2 py-0.5 rounded text-slate-300">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Payload */}
              {run!.payload && (
                <JsonEditor
                  value={JSON.stringify(run!.payload, null, 2)}
                  readOnly
                  label="Input Payload"
                  maxHeight="300px"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
