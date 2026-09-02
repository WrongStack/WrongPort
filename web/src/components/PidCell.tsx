import { useState } from 'react';

/**
 * Click-to-copy PID cell: copies the pid to the clipboard and flashes a
 * confirmation. Silently degrades when the clipboard is unavailable (e.g.
 * insecure origin) — the pid stays visible.
 */
export function PidCell({ pid }: { pid: number }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard
      ?.writeText(String(pid))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {
        // Clipboard unavailable (e.g. insecure origin) — the pid stays visible.
      });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy pid ${pid}`}
      className="font-mono text-xs text-muted transition-colors duration-150 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {copied ? 'copied ✓' : pid}
    </button>
  );
}
