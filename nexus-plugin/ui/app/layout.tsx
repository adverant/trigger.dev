import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import LayoutShell from './layout-shell';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Trigger.dev - Nexus Plugin',
  description: 'Task orchestration and automation for the Nexus platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased bg-surface text-slate-200`}>
        <LayoutShell>{children}</LayoutShell>
      </body>
    </html>
  );
}
