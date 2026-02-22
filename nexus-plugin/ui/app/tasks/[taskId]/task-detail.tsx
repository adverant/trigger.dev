'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Play,
  Clock,
  FileCode,
  Layers,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { useTriggerApi, Task, Run } from '@/hooks/useTriggerApi';
import StatusBadge from '@/components/common/StatusBadge';
import JsonEditor from '@/components/common/JsonEditor';
import { format } from 'date-fns';

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.taskId as string;
  const { getTask, triggerTask, getRuns } = useTriggerApi();

  const [task, setTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState('{}');
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskRes, runsRes] = await Promise.all([
        getTask(taskId),
        getRuns({ taskId, limit: 20 }),
      ]);
      setTask(taskRes.data);
      setRuns(runsRes.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load task');
    } finally {
      setLoading(false);
    }
  }, [taskId, getTask, getRuns]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleTrigger = async () => {
    setTriggering(true);
    setTriggerError(null);
    try {
      const parsed = JSON.parse(payload);
      const response = await triggerTask(taskId, parsed);
      router.push(`/runs/${response.data.id}`);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setTriggerError('Invalid JSON payload');
      } else {
        setTriggerError((err as Error).message || 'Failed to trigger task');
      }
    } finally {
      setTriggering(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface-overlay rounded animate-pulse" />
        <div className="card h-48 animate-pulse" />
        <div className="card h-64 animate-pulse" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-slate-200 mb-2">Task Not Found</h2>
        <p className="text-sm text-slate-400 mb-6">{error || 'Task could not be loaded'}</p>
        <button onClick={() => router.push('/tasks')} className="btn-secondary">
          Back to Tasks
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <button
        onClick={() => router.push('/tasks')}
        className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Tasks
      </button>

      {/* Task header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100 font-mono">{task.slug}</h1>
          <p className="text-sm text-slate-500 mt-1">Version {task.version}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} className="btn-secondary flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Metadata cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card flex items-center gap-3">
          <FileCode className="h-4.5 w-4.5 text-slate-500" />
          <div>
            <p className="text-xs text-slate-500">File Path</p>
            <p className="text-sm text-slate-300 font-mono truncate">{task.filePath}</p>
          </div>
        </div>
        <div className="card flex items-center gap-3">
          <Layers className="h-4.5 w-4.5 text-slate-500" />
          <div>
            <p className="text-xs text-slate-500">Queue</p>
            <p className="text-sm text-slate-300">{task.queue}</p>
          </div>
        </div>
        <div className="card flex items-center gap-3">
          <Clock className="h-4.5 w-4.5 text-slate-500" />
          <div>
            <p className="text-xs text-slate-500">Last Run</p>
            <p className="text-sm text-slate-300">
              {task.lastRunAt ? format(new Date(task.lastRunAt), 'MMM d, HH:mm:ss') : 'Never'}
            </p>
          </div>
        </div>
        <div className="card flex items-center gap-3">
          <Play className="h-4.5 w-4.5 text-slate-500" />
          <div>
            <p className="text-xs text-slate-500">Last Status</p>
            {task.lastRunStatus ? (
              <StatusBadge status={task.lastRunStatus} />
            ) : (
              <p className="text-sm text-slate-500">N/A</p>
            )}
          </div>
        </div>
      </div>

      {/* Retry config */}
      {task.retry && (
        <div className="card">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Retry Configuration</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-slate-500">Max Attempts</p>
              <p className="text-slate-300">{task.retry.maxAttempts}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Min Timeout</p>
              <p className="text-slate-300">{task.retry.minTimeout}ms</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Max Timeout</p>
              <p className="text-slate-300">{task.retry.maxTimeout}ms</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Backoff Factor</p>
              <p className="text-slate-300">{task.retry.factor}x</p>
            </div>
          </div>
        </div>
      )}

      {/* Input schema */}
      {task.schema && Object.keys(task.schema).length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Input Schema</h2>
          <JsonEditor value={JSON.stringify(task.schema, null, 2)} readOnly />
        </div>
      )}

      {/* Trigger form */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Trigger Task</h2>
        <JsonEditor
          value={payload}
          onChange={setPayload}
          label="Payload"
          maxHeight="200px"
        />
        {triggerError && (
          <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {triggerError}
          </div>
        )}
        <button
          onClick={handleTrigger}
          disabled={triggering}
          className="btn-primary mt-4 flex items-center gap-2"
        >
          <Play className="h-3.5 w-3.5" />
          {triggering ? 'Triggering...' : 'Trigger Run'}
        </button>
      </div>

      {/* Recent runs for this task */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-200 mb-4">Recent Runs</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border">
                <th className="text-left px-3 py-2 font-medium">Run ID</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Started</th>
                <th className="text-left px-3 py-2 font-medium">Duration</th>
                <th className="text-left px-3 py-2 font-medium">Version</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-8 text-slate-500">
                    No runs yet for this task
                  </td>
                </tr>
              ) : (
                runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-b border-border/50 hover:bg-surface-overlay/50 cursor-pointer transition-colors"
                    onClick={() => router.push(`/runs/${run.id}`)}
                  >
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-300">
                      {run.id.slice(0, 12)}...
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400">
                      {run.startedAt ? format(new Date(run.startedAt), 'MMM d, HH:mm:ss') : '-'}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-400">
                      {run.duration != null ? `${(run.duration / 1000).toFixed(1)}s` : '-'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-400">
                      {run.version || '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
