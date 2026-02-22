'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  ListTodo,
  Play,
  CalendarClock,
  Workflow,
  Timer,
  Plug,
  Rocket,
  Settings,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useState } from 'react';
import { clsx } from 'clsx';

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Tasks', href: '/tasks', icon: ListTodo },
  { label: 'Runs', href: '/runs', icon: Play },
  { label: 'Schedules', href: '/schedules', icon: CalendarClock },
  { label: 'Workflows', href: '/workflows', icon: Workflow },
  { label: 'Waitpoints', href: '/waitpoints', icon: Timer },
  { label: 'Integrations', href: '/integrations', icon: Plug },
  { label: 'Deployments', href: '/deployments', icon: Rocket },
  { label: 'Settings', href: '/settings', icon: Settings },
];

const basePath = '/trigger/ui';

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (href: string) => {
    const fullHref = `${basePath}${href}`;
    if (href === '/') {
      return pathname === basePath || pathname === `${basePath}/`;
    }
    return pathname.startsWith(fullHref);
  };

  return (
    <aside
      className={clsx(
        'h-screen sticky top-0 flex flex-col bg-surface-raised border-r border-border transition-all duration-200',
        collapsed ? 'w-16' : 'w-56'
      )}
    >
      {/* Logo area */}
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border shrink-0">
        <div className="h-7 w-7 rounded-lg bg-accent flex items-center justify-center shrink-0">
          <Play className="h-3.5 w-3.5 text-white fill-white" />
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-slate-200 truncate">
            Trigger.dev
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={`${basePath}${item.href}`}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors group',
                active
                  ? 'bg-accent/15 text-accent'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-surface-overlay'
              )}
              title={collapsed ? item.label : undefined}
            >
              <Icon
                className={clsx(
                  'h-4.5 w-4.5 shrink-0',
                  active ? 'text-accent' : 'text-slate-500 group-hover:text-slate-300'
                )}
              />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className="px-2 py-3 border-t border-border shrink-0">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center w-full px-3 py-2 rounded-md text-slate-500 hover:text-slate-300 hover:bg-surface-overlay transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4 mr-2" />
              <span className="text-xs">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
