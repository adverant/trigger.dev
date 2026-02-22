'use client';

import { useState, useCallback, useEffect } from 'react';
import { Copy, Check, Maximize2, Minimize2 } from 'lucide-react';
import { clsx } from 'clsx';

interface JsonEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  maxHeight?: string;
  label?: string;
  className?: string;
}

interface TokenSpan {
  type: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation';
  text: string;
}

function tokenize(json: string): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  const regex = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|([-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}[\],:])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(json)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'punctuation', text: json.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      tokens.push({ type: 'key', text: match[1] });
      tokens.push({ type: 'punctuation', text: ':' });
      regex.lastIndex = match.index + match[0].length;
    } else if (match[2]) {
      tokens.push({ type: 'string', text: match[2] });
    } else if (match[3]) {
      tokens.push({ type: 'number', text: match[3] });
    } else if (match[4]) {
      tokens.push({ type: 'boolean', text: match[4] });
    } else if (match[5]) {
      tokens.push({ type: 'null', text: match[5] });
    } else if (match[6]) {
      tokens.push({ type: 'punctuation', text: match[6] });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < json.length) {
    tokens.push({ type: 'punctuation', text: json.slice(lastIndex) });
  }

  return tokens;
}

const tokenColors: Record<string, string> = {
  key: 'text-purple-400',
  string: 'text-green-400',
  number: 'text-amber-400',
  boolean: 'text-blue-400',
  null: 'text-red-400',
  punctuation: 'text-slate-500',
};

export default function JsonEditor({
  value,
  onChange,
  readOnly = false,
  maxHeight = '400px',
  label,
  className,
}: JsonEditorProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalValue, setInternalValue] = useState(value);

  useEffect(() => {
    setInternalValue(value);
  }, [value]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(internalValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select textarea content
    }
  }, [internalValue]);

  const handleChange = useCallback(
    (newVal: string) => {
      setInternalValue(newVal);
      setError(null);
      try {
        if (newVal.trim()) {
          JSON.parse(newVal);
        }
        if (onChange) onChange(newVal);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [onChange]
  );

  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(internalValue);
      const formatted = JSON.stringify(parsed, null, 2);
      setInternalValue(formatted);
      setError(null);
      if (onChange) onChange(formatted);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [internalValue, onChange]);

  const tokens = tokenize(internalValue);

  return (
    <div className={clsx('rounded-lg border border-border bg-surface-overlay', className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">
          {label || 'JSON'}
        </span>
        <div className="flex items-center gap-1.5">
          {!readOnly && (
            <button
              onClick={handleFormat}
              className="text-xs text-slate-500 hover:text-slate-300 px-2 py-0.5 rounded hover:bg-surface-raised transition-colors"
            >
              Format
            </button>
          )}
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-surface-raised transition-colors text-slate-500 hover:text-slate-300"
            title="Copy to clipboard"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 rounded hover:bg-surface-raised transition-colors text-slate-500 hover:text-slate-300"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="relative" style={{ maxHeight: expanded ? 'none' : maxHeight }}>
        {readOnly ? (
          <div className="overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap" style={{ maxHeight: expanded ? 'none' : maxHeight }}>
            {tokens.map((token, i) => (
              <span key={i} className={tokenColors[token.type] || 'text-slate-300'}>
                {token.text}
              </span>
            ))}
          </div>
        ) : (
          <textarea
            value={internalValue}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full bg-transparent p-3 font-mono text-xs leading-relaxed text-slate-200 resize-y focus:outline-none"
            style={{ minHeight: '120px', maxHeight: expanded ? 'none' : maxHeight }}
            spellCheck={false}
            placeholder='{ }'
          />
        )}
      </div>

      {error && (
        <div className="px-3 py-1.5 border-t border-red-500/20 bg-red-500/5 text-xs text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
