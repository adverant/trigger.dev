'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Filter, RefreshCw, AlertTriangle } from 'lucide-react';
import { useTriggerApi, Run, Task } from '@/hooks/useTriggerApi';
import DataTable, { Column } from '@/components/common/DataTable';
import StatusBadge from '@/components/common/StatusBadge';
import { format } from 'date-fns';

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'QUEUED', label: 'Queued' },
  { value: 'EXECUTING', label: 'Executing' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELED', label: 'Canceled' },
  { value: 'FROZEN', label: 'Frozen' },
  { value: 'REATTEMPTING', label: 'Reattempting' },
  { value: 'WAITING_FOR_DEPLOY', label: 'Waiting for Deploy' },
];

export default function RunsPage() {
  const router = useRouter();
  const { getRuns, getTasks } = useTriggerApi();

  const [runs, setRuns] = useState<Run[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Fetch tasks for filter dropdown
  useEffect(() => {
    getTasks({ limit: 200 }).then((res) => setTasks(res.data)).catch(() => {});
  }, [getTasks]);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getRuns({
        status: statusFilter || undefined,
        taskId: taskFilter || undefined,
        from: dateFrom || undefined,
        to: dateTo || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      setRuns(response.data);
      setTotalItems(response.meta?.total ?? response.data.length);
    } catch (err) {
      setError((err as Error).message || 'Failed to load runs');
    } finally {
      setLoading(false);
    }
  }, [getRuns, statusFilter, taskFilter, dateFrom, dateTo, page]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const columns: Column<Run>[] = [
    {
      key: 'id',
      header: 'Run ID',
      sortable: true,
      render: (row) => (
        <span className="font-mono text-xs text-slate-300">{row.id.slice(0, 16)}...</span>
      ),
    },
    {
      key: 'taskSlug',
      header: 'Task',
      sortable: true,
      render: (row) => (
        <span className="text-sm text-slate-300">{row.taskSlug}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '140px',
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'startedAt',
      header: 'Started',
      sortable: true,
      width: '160px',
      render: (row) => (
        <span className="text-xs text-slate-400">
          {row.startedAt ? format(new Date(row.startedAt), 'MMM d, HH:mm:ss') : '-'}
        </span>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      sortable: true,
      width: '100px',
      render: (row) => (
        <span className="text-xs text-slate-400">
          {row.duration != null ? `${(row.duration / 1000).toFixed(1)}s` : '-'}
        </span>
      ),
    },
    {
      key: 'isTest',
      header: 'Test',
      width: '60px',
      render: (row) =>
        row.isTest ? (
          <span className="text-xs px-1.5 py-0.5 bg-yellow-500/10 text-yellow-400 rounded">Test</span>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Runs</h1>
          <p className="text-sm text-slate-500 mt-0.5">Monitor and inspect task executions</p>
        </div>
        <button onClick={fetchRuns} className="btn-secondary flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-300">Filters</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Status */}
          <div>
            <label className="text-xs text-slate-500 mb-1 block">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="select-field w-full"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Task filter */}
          <div>
            <label className="text-xs text-slate-500 mb-1 block">Task</label>
            <select
              value={taskFilter}
              onChange={(e) => {
                setTaskFilter(e.target.value);
                setPage(1);
              }}
              className="select-field w-full"
            >
              <option value="">All Tasks</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>{t.slug}</option>
              ))}
            </select>
          </div>

          {/* Date from */}
          <div>
            <label className="text-xs text-slate-500 mb-1 block">From</label>
            <input
              type="datetime-local"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="input-field w-full"
            />
          </div>

          {/* Date to */}
          <div>
            <label className="text-xs text-slate-500 mb-1 block">To</label>
            <input
              type="datetime-local"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="input-field w-full"
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      <DataTable<Run & Record<string, unknown>>
        columns={columns as Column<Run & Record<string, unknown>>[]}
        data={runs as (Run & Record<string, unknown>)[]}
        loading={loading}
        pageSize={pageSize}
        currentPage={page}
        totalItems={totalItems}
        onPageChange={setPage}
        serverPagination
        onRowClick={(row) => router.push(`/trigger/ui/runs/${row.id as string}`)}
        emptyMessage="No runs match the current filters"
      />
    </div>
  );
}
