'use client';

import { clsx } from 'clsx';

export type StatusType =
  | 'COMPLETED'
  | 'FAILED'
  | 'EXECUTING'
  | 'QUEUED'
  | 'CANCELED'
  | 'FROZEN'
  | 'REATTEMPTING'
  | 'WAITING_FOR_DEPLOY'
  | 'active'
  | 'superseded'
  | 'deploying'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unknown'
  | 'pending'
  | 'resolved'
  | 'expired';

const statusStyles: Record<string, string> = {
  COMPLETED: 'bg-green-500/15 text-green-400 border-green-500/30',
  FAILED: 'bg-red-500/15 text-red-400 border-red-500/30',
  EXECUTING: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  QUEUED: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  CANCELED: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  FROZEN: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  REATTEMPTING: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  WAITING_FOR_DEPLOY: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  active: 'bg-green-500/15 text-green-400 border-green-500/30',
  superseded: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  deploying: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  healthy: 'bg-green-500/15 text-green-400 border-green-500/30',
  degraded: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  unhealthy: 'bg-red-500/15 text-red-400 border-red-500/30',
  unknown: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
  pending: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  resolved: 'bg-green-500/15 text-green-400 border-green-500/30',
  expired: 'bg-red-500/15 text-red-400 border-red-500/30',
};

const statusDotColors: Record<string, string> = {
  COMPLETED: 'bg-green-400',
  FAILED: 'bg-red-400',
  EXECUTING: 'bg-blue-400 animate-pulse-fast',
  QUEUED: 'bg-slate-400',
  CANCELED: 'bg-orange-400',
  FROZEN: 'bg-cyan-400',
  REATTEMPTING: 'bg-yellow-400 animate-pulse-fast',
  WAITING_FOR_DEPLOY: 'bg-purple-400',
  active: 'bg-green-400',
  superseded: 'bg-slate-400',
  deploying: 'bg-blue-400 animate-pulse-fast',
  healthy: 'bg-green-400',
  degraded: 'bg-yellow-400',
  unhealthy: 'bg-red-400',
  unknown: 'bg-slate-400',
  pending: 'bg-yellow-400 animate-pulse-fast',
  resolved: 'bg-green-400',
  expired: 'bg-red-400',
};

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
  showDot?: boolean;
  className?: string;
}

export default function StatusBadge({ status, size = 'sm', showDot = true, className }: StatusBadgeProps) {
  const style = statusStyles[status] || statusStyles.unknown;
  const dotColor = statusDotColors[status] || statusDotColors.unknown;
  const label = (status || 'unknown').replace(/_/g, ' ');

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border font-medium capitalize',
        style,
        size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        className
      )}
    >
      {showDot && <span className={clsx('h-1.5 w-1.5 rounded-full', dotColor)} />}
      {label.toLowerCase()}
    </span>
  );
}
