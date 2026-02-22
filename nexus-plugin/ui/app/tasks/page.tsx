'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, RefreshCw, Play, AlertTriangle } from 'lucide-react';
import { useTriggerApi, Task } from '@/hooks/useTriggerApi';
import { apiClient } from '@/lib/api-client';
import DataTable, { Column } from '@/components/common/DataTable';
import StatusBadge from '@/components/common/StatusBadge';
import { format } from 'date-fns';

export default function TasksPage() {
  const router = useRouter();
  const { getTasks } = useTriggerApi();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getTasks({ search: search || undefined, limit: 100 });
      setTasks(response.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [getTasks, search]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await apiClient.post('/tasks/sync');
      await fetchTasks();
    } catch (err) {
      setError((err as Error).message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleTrigger = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTriggeringId(taskId);
    try {
      const response = await apiClient.post<{ id: string }>(`/tasks/${taskId}/trigger`, { payload: {} });
      router.push(`/runs/${response.data.id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to trigger task');
    } finally {
      setTriggeringId(null);
    }
  };

  const columns: Column<Task>[] = [
    {
      key: 'slug',
      header: 'Task ID',
      sortable: true,
      render: (row) => (
        <div>
          <span className="font-mono text-xs text-slate-200">{row.slug}</span>
          {row.nexusIntegration && (
            <span className="ml-2 text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded">
              {row.nexusIntegration}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      sortable: true,
      width: '100px',
      render: (row) => (
        <span className="font-mono text-xs text-slate-400">{row.version}</span>
      ),
    },
    {
      key: 'queue',
      header: 'Queue',
      sortable: true,
      width: '140px',
      render: (row) => (
        <span className="text-xs text-slate-400">{row.queue}</span>
      ),
    },
    {
      key: 'lastRunStatus',
      header: 'Last Status',
      sortable: true,
      width: '140px',
      render: (row) => (
        row.lastRunStatus ? <StatusBadge status={row.lastRunStatus} /> : <span className="text-xs text-slate-600">Never run</span>
      ),
    },
    {
      key: 'lastRunAt',
      header: 'Last Run',
      sortable: true,
      width: '150px',
      render: (row) => (
        <span className="text-xs text-slate-400">
          {row.lastRunAt ? format(new Date(row.lastRunAt), 'MMM d, HH:mm') : '-'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '80px',
      render: (row) => (
        <button
          onClick={(e) => handleTrigger(row.id, e)}
          disabled={triggeringId === row.id}
          className="btn-primary !px-2.5 !py-1 text-xs flex items-center gap-1.5 disabled:opacity-50"
        >
          <Play className="h-3 w-3" />
          {triggeringId === row.id ? '...' : 'Run'}
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Tasks</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage and trigger task definitions
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync Tasks'}
        </button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            placeholder="Search tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-field w-full pl-10"
          />
        </div>
        <span className="text-xs text-slate-500">
          {tasks.length} task{tasks.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      <DataTable<Task & Record<string, unknown>>
        columns={columns as Column<Task & Record<string, unknown>>[]}
        data={tasks as (Task & Record<string, unknown>)[]}
        loading={loading}
        onRowClick={(row) => router.push(`/tasks/${row.id}`)}
        emptyMessage="No tasks found. Click Sync Tasks to discover registered tasks."
        pageSize={25}
      />
    </div>
  );
}
