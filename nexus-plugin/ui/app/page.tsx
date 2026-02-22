'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ListTodo,
  Play,
  CalendarClock,
  Timer,
  AlertTriangle,
  RefreshCw,
  ArrowRight,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { useTriggerApi, RunStatistics, Run, Integration } from '@/hooks/useTriggerApi';
import StatusBadge from '@/components/common/StatusBadge';
import { clsx } from 'clsx';
import { format } from 'date-fns';

interface KpiCard {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
  bgColor: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const { getStatistics, getRuns, getIntegrations } = useTriggerApi();

  const [stats, setStats] = useState<RunStatistics | null>(null);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, runsRes, intRes] = await Promise.all([
        getStatistics(),
        getRuns({ limit: 10 }),
        getIntegrations(),
      ]);
      setStats(statsRes.data);
      setRecentRuns(runsRes.data);
      setIntegrations(intRes.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, [getStatistics, getRuns, getIntegrations]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const kpiCards: KpiCard[] = stats
    ? [
        { label: 'Total Tasks', value: stats.totalTasks, icon: ListTodo, color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
        { label: 'Active Runs', value: stats.activeRuns, icon: Play, color: 'text-green-400', bgColor: 'bg-green-500/10' },
        { label: 'Scheduled Jobs', value: stats.scheduledJobs, icon: CalendarClock, color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
        { label: 'Pending Waitpoints', value: stats.pendingWaitpoints, icon: Timer, color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
        { label: 'Failed 24h', value: stats.failedLast24h, icon: AlertTriangle, color: 'text-red-400', bgColor: 'bg-red-500/10' },
      ]
    : [];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 bg-surface-overlay rounded animate-pulse" />
          <div className="h-9 w-24 bg-surface-overlay rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="card h-28 animate-pulse" />
          ))}
        </div>
        <div className="card h-80 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-lg font-semibold text-slate-200 mb-2">Failed to Load Dashboard</h2>
        <p className="text-sm text-slate-400 mb-6">{error}</p>
        <button onClick={fetchData} className="btn-primary flex items-center gap-2">
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
          <h1 className="text-xl font-bold text-slate-100">Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Task orchestration overview</p>
        </div>
        <button onClick={fetchData} className="btn-secondary flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {kpiCards.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className="card flex items-start gap-3">
              <div className={clsx('p-2 rounded-lg', kpi.bgColor)}>
                <Icon className={clsx('h-5 w-5', kpi.color)} />
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-100">{kpi.value.toLocaleString()}</p>
                <p className="text-xs text-slate-500 mt-0.5">{kpi.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Run activity chart */}
      <div className="card">
        <h2 className="text-sm font-semibold text-slate-200 mb-4">Run Activity (Last 24h)</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats?.runsByHour || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2e3345" />
              <XAxis
                dataKey="hour"
                tick={{ fill: '#64748b', fontSize: 11 }}
                stroke="#2e3345"
              />
              <YAxis
                tick={{ fill: '#64748b', fontSize: 11 }}
                stroke="#2e3345"
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1d27',
                  border: '1px solid #2e3345',
                  borderRadius: '8px',
                  color: '#e2e8f0',
                  fontSize: '12px',
                }}
              />
              <Legend
                wrapperStyle={{ fontSize: '12px', color: '#94a3b8' }}
              />
              <Line
                type="monotone"
                dataKey="count"
                name="Total Runs"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#6366f1' }}
              />
              <Line
                type="monotone"
                dataKey="failed"
                name="Failed"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#ef4444' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Recent runs table */}
        <div className="xl:col-span-2 card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-200">Recent Runs</h2>
            <button
              onClick={() => router.push('/trigger/ui/runs')}
              className="text-xs text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
            >
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wider border-b border-border">
                  <th className="text-left px-3 py-2 font-medium">Run ID</th>
                  <th className="text-left px-3 py-2 font-medium">Task</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Started</th>
                  <th className="text-left px-3 py-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-slate-500">
                      No recent runs
                    </td>
                  </tr>
                ) : (
                  recentRuns.map((run) => (
                    <tr
                      key={run.id}
                      className="border-b border-border/50 hover:bg-surface-overlay/50 cursor-pointer transition-colors"
                      onClick={() => router.push(`/trigger/ui/runs/${run.id}`)}
                    >
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-300">
                        {run.id.slice(0, 12)}...
                      </td>
                      <td className="px-3 py-2.5 text-slate-300">{run.taskSlug}</td>
                      <td className="px-3 py-2.5">
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="px-3 py-2.5 text-slate-400 text-xs">
                        {run.startedAt ? format(new Date(run.startedAt), 'MMM d, HH:mm:ss') : '-'}
                      </td>
                      <td className="px-3 py-2.5 text-slate-400 text-xs">
                        {run.duration != null ? `${(run.duration / 1000).toFixed(1)}s` : '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Integration status */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-200">Integrations</h2>
            <button
              onClick={() => router.push('/trigger/ui/integrations')}
              className="text-xs text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
            >
              Manage <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="space-y-2">
            {integrations.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">No integrations configured</p>
            ) : (
              integrations.map((integration) => (
                <div
                  key={integration.id}
                  className="flex items-center justify-between px-3 py-2.5 rounded-md bg-surface-overlay/50 hover:bg-surface-overlay transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={clsx(
                        'h-2 w-2 rounded-full shrink-0',
                        integration.health === 'healthy' && 'bg-green-400',
                        integration.health === 'degraded' && 'bg-yellow-400',
                        integration.health === 'unhealthy' && 'bg-red-400',
                        integration.health === 'unknown' && 'bg-slate-500'
                      )}
                    />
                    <span className="text-sm text-slate-300">{integration.displayName}</span>
                  </div>
                  <StatusBadge status={integration.health} showDot={false} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
