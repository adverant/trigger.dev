'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  RefreshCw,
  Trash2,
  AlertTriangle,
  CalendarClock,
  X,
  Clock,
} from 'lucide-react';
import { useTriggerApi, Schedule, Task } from '@/hooks/useTriggerApi';
import StatusBadge from '@/components/common/StatusBadge';
import CronBuilder from '@/components/common/CronBuilder';
import JsonEditor from '@/components/common/JsonEditor';
import { format, addMinutes } from 'date-fns';
import { clsx } from 'clsx';

const TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function computeNextExecutions(cron: string, count: number): Date[] {
  // Simple next-execution estimator for display
  // Parses cron and projects forward from now
  const now = new Date();
  const dates: Date[] = [];
  const parts = cron.split(' ');
  if (parts.length !== 5) return dates;

  const [minPart, hourPart] = parts;

  // For simple cases, estimate next N occurrences
  let cursor = new Date(now);
  let attempts = 0;

  while (dates.length < count && attempts < 1440) {
    cursor = addMinutes(cursor, 1);
    attempts++;

    const m = cursor.getMinutes();
    const h = cursor.getHours();

    const minMatch =
      minPart === '*' ||
      (minPart.startsWith('*/') && m % parseInt(minPart.slice(2)) === 0) ||
      parseInt(minPart) === m;

    const hourMatch =
      hourPart === '*' ||
      (hourPart.startsWith('*/') && h % parseInt(hourPart.slice(2)) === 0) ||
      parseInt(hourPart) === h;

    if (minMatch && hourMatch) {
      dates.push(new Date(cursor));
    }
  }

  return dates;
}

export default function SchedulesPage() {
  const {
    getSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    getTasks,
  } = useTriggerApi();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Create form state
  const [newTaskId, setNewTaskId] = useState('');
  const [newCron, setNewCron] = useState('0 * * * *');
  const [newTimezone, setNewTimezone] = useState('UTC');
  const [newPayload, setNewPayload] = useState('{}');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schedRes, taskRes] = await Promise.all([
        getSchedules(),
        getTasks({ limit: 200 }),
      ]);
      setSchedules(schedRes.data);
      setTasks(taskRes.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [getSchedules, getTasks]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleToggle = async (scheduleId: string, enabled: boolean) => {
    setTogglingId(scheduleId);
    try {
      await updateSchedule(scheduleId, { enabled: !enabled });
      setSchedules((prev) =>
        prev.map((s) => (s.id === scheduleId ? { ...s, enabled: !enabled } : s))
      );
    } catch (err) {
      setError((err as Error).message || 'Failed to toggle schedule');
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (scheduleId: string) => {
    setDeletingId(scheduleId);
    try {
      await deleteSchedule(scheduleId);
      setSchedules((prev) => prev.filter((s) => s.id !== scheduleId));
    } catch (err) {
      setError((err as Error).message || 'Failed to delete schedule');
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreate = async () => {
    if (!newTaskId) {
      setCreateError('Please select a task');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      let parsedPayload: unknown;
      try {
        parsedPayload = newPayload.trim() ? JSON.parse(newPayload) : undefined;
      } catch {
        setCreateError('Invalid JSON payload');
        setCreating(false);
        return;
      }
      await createSchedule({
        taskId: newTaskId,
        cron: newCron,
        timezone: newTimezone,
        payload: parsedPayload,
      });
      setShowCreateModal(false);
      setNewTaskId('');
      setNewCron('0 * * * *');
      setNewTimezone('UTC');
      setNewPayload('{}');
      await fetchData();
    } catch (err) {
      setCreateError((err as Error).message || 'Failed to create schedule');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-surface-overlay rounded animate-pulse" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card h-24 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Schedules</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage cron-based task schedules</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} className="btn-secondary flex items-center gap-2">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="h-3.5 w-3.5" />
            New Schedule
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Schedule list */}
      {schedules.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16">
          <CalendarClock className="h-12 w-12 text-slate-600 mb-4" />
          <h2 className="text-lg font-semibold text-slate-300 mb-2">No Schedules</h2>
          <p className="text-sm text-slate-500 mb-6">Create a schedule to automatically run tasks on a cron expression.</p>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create Schedule
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((schedule) => {
            const task = tasks.find((t) => t.id === schedule.taskId);
            const nextExecs = computeNextExecutions(schedule.cron, 3);

            return (
              <div key={schedule.id} className="card">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    {/* Toggle */}
                    <button
                      onClick={() => handleToggle(schedule.id, schedule.enabled)}
                      disabled={togglingId === schedule.id}
                      className={clsx(
                        'mt-1 relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                        schedule.enabled ? 'bg-accent' : 'bg-surface-overlay'
                      )}
                    >
                      <span
                        className={clsx(
                          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                          schedule.enabled ? 'translate-x-4' : 'translate-x-0'
                        )}
                      />
                    </button>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-200">
                          {task?.slug || schedule.taskId}
                        </span>
                        <StatusBadge status={schedule.health} showDot={false} />
                      </div>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-400">
                        <code className="bg-surface-overlay px-2 py-0.5 rounded font-mono">
                          {schedule.cron}
                        </code>
                        <span>{schedule.timezone}</span>
                      </div>

                      {/* Next executions */}
                      {schedule.enabled && nextExecs.length > 0 && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <Clock className="h-3 w-3 text-slate-600" />
                          <span className="text-xs text-slate-500">
                            Next: {nextExecs.map((d) => format(d, 'HH:mm')).join(', ')}
                          </span>
                        </div>
                      )}

                      {schedule.lastRunAt && (
                        <p className="text-xs text-slate-500 mt-1">
                          Last run: {format(new Date(schedule.lastRunAt), 'MMM d, HH:mm:ss')}
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(schedule.id)}
                    disabled={deletingId === schedule.id}
                    className="p-1.5 rounded text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Delete schedule"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowCreateModal(false)}
          />
          <div className="relative z-50 w-full max-w-2xl mx-4 bg-surface-raised border border-border rounded-xl shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-slate-100">Create Schedule</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-surface-overlay transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Task selection */}
              <div>
                <label className="text-sm font-medium text-slate-300 mb-1.5 block">Task</label>
                <select
                  value={newTaskId}
                  onChange={(e) => setNewTaskId(e.target.value)}
                  className="select-field w-full"
                >
                  <option value="">Select a task...</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>{t.slug}</option>
                  ))}
                </select>
              </div>

              {/* Cron builder */}
              <div>
                <label className="text-sm font-medium text-slate-300 mb-1.5 block">Schedule</label>
                <CronBuilder value={newCron} onChange={setNewCron} />
              </div>

              {/* Timezone */}
              <div>
                <label className="text-sm font-medium text-slate-300 mb-1.5 block">Timezone</label>
                <select
                  value={newTimezone}
                  onChange={(e) => setNewTimezone(e.target.value)}
                  className="select-field w-full"
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>

              {/* Next executions preview */}
              {newCron && (
                <div className="card !bg-surface-overlay">
                  <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">
                    Next Executions Preview
                  </h3>
                  <div className="space-y-1">
                    {computeNextExecutions(newCron, 5).map((d, i) => (
                      <p key={i} className="text-sm text-slate-300">
                        {format(d, 'MMM d yyyy, HH:mm:ss')}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* Payload */}
              <div>
                <label className="text-sm font-medium text-slate-300 mb-1.5 block">
                  Payload <span className="text-slate-500 font-normal">(optional)</span>
                </label>
                <JsonEditor value={newPayload} onChange={setNewPayload} maxHeight="150px" />
              </div>

              {createError && (
                <div className="flex items-center gap-2 text-sm text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {createError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
              <button
                onClick={() => setShowCreateModal(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="btn-primary flex items-center gap-2"
              >
                <Plus className="h-3.5 w-3.5" />
                {creating ? 'Creating...' : 'Create Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
