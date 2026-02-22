'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { clsx } from 'clsx';

interface CronBuilderProps {
  value: string;
  onChange: (cron: string) => void;
  className?: string;
}

interface FieldOption {
  value: string;
  label: string;
}

const minuteOptions: FieldOption[] = [
  { value: '*', label: 'Every minute' },
  ...Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: String(i).padStart(2, '0') })),
  { value: '*/5', label: 'Every 5 min' },
  { value: '*/10', label: 'Every 10 min' },
  { value: '*/15', label: 'Every 15 min' },
  { value: '*/30', label: 'Every 30 min' },
];

const hourOptions: FieldOption[] = [
  { value: '*', label: 'Every hour' },
  ...Array.from({ length: 24 }, (_, i) => ({ value: String(i), label: `${String(i).padStart(2, '0')}:00` })),
  { value: '*/2', label: 'Every 2 hours' },
  { value: '*/4', label: 'Every 4 hours' },
  { value: '*/6', label: 'Every 6 hours' },
  { value: '*/12', label: 'Every 12 hours' },
];

const dayOptions: FieldOption[] = [
  { value: '*', label: 'Every day' },
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
  { value: '1,15', label: '1st & 15th' },
];

const monthOptions: FieldOption[] = [
  { value: '*', label: 'Every month' },
  { value: '1', label: 'January' },
  { value: '2', label: 'February' },
  { value: '3', label: 'March' },
  { value: '4', label: 'April' },
  { value: '5', label: 'May' },
  { value: '6', label: 'June' },
  { value: '7', label: 'July' },
  { value: '8', label: 'August' },
  { value: '9', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
  { value: '*/3', label: 'Every quarter' },
];

const weekdayOptions: FieldOption[] = [
  { value: '*', label: 'Every day' },
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '1-5', label: 'Weekdays' },
  { value: '0,6', label: 'Weekends' },
];

const presets: { label: string; cron: string }[] = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at midnight', cron: '0 0 * * *' },
  { label: 'Every day at 9am', cron: '0 9 * * *' },
  { label: 'Every Monday at 9am', cron: '0 9 * * 1' },
  { label: 'Every weekday at 9am', cron: '0 9 * * 1-5' },
  { label: 'First of month', cron: '0 0 1 * *' },
];

function describeField(value: string, unit: string, names?: string[]): string {
  if (value === '*') return `every ${unit}`;
  if (value.startsWith('*/')) return `every ${value.slice(2)} ${unit}s`;
  if (value.includes(',')) {
    const parts = value.split(',').map((v) => (names ? names[parseInt(v)] || v : v));
    return parts.join(' and ');
  }
  if (value.includes('-')) {
    const [a, b] = value.split('-');
    const start = names ? names[parseInt(a)] || a : a;
    const end = names ? names[parseInt(b)] || b : b;
    return `${start} through ${end}`;
  }
  return names ? names[parseInt(value)] || value : value;
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function describeCron(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return 'Invalid cron expression';

  const [minute, hour, day, month, weekday] = parts;
  const segments: string[] = [];

  if (minute === '*' && hour === '*') {
    segments.push('Every minute');
  } else if (minute.startsWith('*/')) {
    segments.push(`Every ${minute.slice(2)} minutes`);
  } else if (hour === '*') {
    segments.push(`At minute ${minute} of every hour`);
  } else {
    const h = parseInt(hour);
    const m = parseInt(minute) || 0;
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    segments.push(`At ${displayHour}:${String(m).padStart(2, '0')} ${period}`);
  }

  if (weekday !== '*') {
    segments.push(`on ${describeField(weekday, 'day', dayNames)}`);
  }

  if (day !== '*') {
    segments.push(`on day ${describeField(day, 'day')} of the month`);
  }

  if (month !== '*') {
    segments.push(`in ${describeField(month, 'month', monthNames)}`);
  }

  return segments.join(', ');
}

function CronField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: FieldOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-slate-400 font-medium uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="select-field"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function CronBuilder({ value, onChange, className }: CronBuilderProps) {
  const parts = useMemo(() => {
    const p = value.split(' ');
    return {
      minute: p[0] || '*',
      hour: p[1] || '*',
      day: p[2] || '*',
      month: p[3] || '*',
      weekday: p[4] || '*',
    };
  }, [value]);

  const [minute, setMinute] = useState(parts.minute);
  const [hour, setHour] = useState(parts.hour);
  const [day, setDay] = useState(parts.day);
  const [month, setMonth] = useState(parts.month);
  const [weekday, setWeekday] = useState(parts.weekday);

  useEffect(() => {
    const p = value.split(' ');
    if (p.length === 5) {
      setMinute(p[0]);
      setHour(p[1]);
      setDay(p[2]);
      setMonth(p[3]);
      setWeekday(p[4]);
    }
  }, [value]);

  const buildCron = useCallback(
    (m: string, h: string, d: string, mo: string, w: string) => {
      const cron = `${m} ${h} ${d} ${mo} ${w}`;
      onChange(cron);
    },
    [onChange]
  );

  const updateField = (field: string, val: string) => {
    const newVals = { minute, hour, day, month, weekday, [field]: val };
    if (field === 'minute') setMinute(val);
    if (field === 'hour') setHour(val);
    if (field === 'day') setDay(val);
    if (field === 'month') setMonth(val);
    if (field === 'weekday') setWeekday(val);
    buildCron(newVals.minute, newVals.hour, newVals.day, newVals.month, newVals.weekday);
  };

  const cronString = `${minute} ${hour} ${day} ${month} ${weekday}`;
  const description = describeCron(cronString);

  return (
    <div className={clsx('space-y-4', className)}>
      {/* Presets */}
      <div>
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2 block">
          Presets
        </label>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.cron}
              onClick={() => onChange(preset.cron)}
              className={clsx(
                'text-xs px-2.5 py-1 rounded-full border transition-colors',
                cronString === preset.cron
                  ? 'bg-accent/20 text-accent border-accent/40'
                  : 'bg-surface-overlay text-slate-400 border-border hover:border-border-hover hover:text-slate-300'
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Field dropdowns */}
      <div className="grid grid-cols-5 gap-3">
        <CronField label="Minute" options={minuteOptions} value={minute} onChange={(v) => updateField('minute', v)} />
        <CronField label="Hour" options={hourOptions} value={hour} onChange={(v) => updateField('hour', v)} />
        <CronField label="Day" options={dayOptions} value={day} onChange={(v) => updateField('day', v)} />
        <CronField label="Month" options={monthOptions} value={month} onChange={(v) => updateField('month', v)} />
        <CronField label="Weekday" options={weekdayOptions} value={weekday} onChange={(v) => updateField('weekday', v)} />
      </div>

      {/* Expression preview */}
      <div className="card flex items-start gap-3">
        <Clock className="h-4 w-4 text-accent mt-0.5 shrink-0" />
        <div>
          <code className="text-sm text-slate-200 font-mono">{cronString}</code>
          <p className="text-xs text-slate-400 mt-1">{description}</p>
        </div>
      </div>
    </div>
  );
}
