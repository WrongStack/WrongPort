import { useEffect, useMemo, useState } from 'react';
import { killProcess } from './api';
import { filterBoxToQuery, SUGGESTED_ONLY_PATTERNS } from './filterQuery';
import { KillButton } from './components/KillButton';
import type { DevProcess, PortEntry } from './types';
import { useProcesses } from './useProcesses';

const INTERVAL_OPTIONS = [
  { label: '1s', value: 1000 },
  { label: '3s', value: 3000 },
  { label: '10s', value: 10000 },
  { label: 'off', value: 0 },
];

type KillAction = (pid: number, force: boolean) => void;

export default function App() {
  const [filter, setFilter] = useState('');
  const [all, setAll] = useState(false);
  const [intervalMs, setIntervalMs] = useState(3000);
  const [actionError, setActionError] = useState<string | null>(null);
  const debouncedFilter = useDebouncedValue(filter, 250);
  const filterQuery = useMemo(() => filterBoxToQuery(debouncedFilter), [debouncedFilter]);
  const { snapshot, error, refreshing, refresh } = useProcesses({
    intervalMs,
    all,
    only: filterQuery.only,
    ports: filterQuery.ports,
  });

  // Filtering is server-side now: digits narrow by port (ports=), other text
  // acts as an extra include pattern (only=) that can reveal processes the
  // dev filter hides — something client-side substring could never do.
  const processes = snapshot?.processes ?? [];

  const portCount = processes.reduce((sum, proc) => sum + proc.ports.length, 0);

  const kill: KillAction = async (pid, force) => {
    setActionError(null);
    try {
      await killProcess(pid, force);
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  return (
    <div className="flex min-h-screen flex-col font-sans text-sm">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-border bg-bg/90 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
          <h1 className="font-mono text-base font-semibold tracking-tight">wrongport</h1>
          <span className="hidden text-xs text-muted sm:inline">
            · dev ports on {snapshot?.platform ?? '…'}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2 font-mono text-xs text-muted">
          <span>{processes.length} procs</span>
          <span aria-hidden>·</span>
          <span>{portCount} ports</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/60 px-4 py-3 md:px-6">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter — text = server regex (only), numbers = ports"
          aria-label="Filter processes"
          className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-xs placeholder:text-muted/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:w-64"
        />
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => setAll(event.target.checked)}
            className="accent-primary size-3.5"
          />
          all processes
        </label>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          refresh
          <select
            value={intervalMs}
            onChange={(event) => setIntervalMs(Number(event.target.value))}
            className="rounded-md border border-border bg-surface px-1.5 py-1 font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {INTERVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="rounded-md border border-border bg-raised px-2.5 py-1 text-xs font-medium transition-colors duration-150 hover:border-muted disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {refreshing ? '…' : '↻'} refresh
        </button>
      </div>

      <div
        role="group"
        aria-label="Suggested only patterns"
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface/60 px-4 pb-3 pt-1 md:px-6"
      >
        {SUGGESTED_ONLY_PATTERNS.map((pattern) => {
          const active = filter.trim() === pattern;
          return (
            <button
              key={pattern}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(active ? '' : pattern)}
              className={`rounded-sm border px-2 py-1 font-mono text-xs transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                active
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border bg-raised text-muted hover:border-muted hover:text-fg'
              }`}
            >
              {pattern}
            </button>
          );
        })}
      </div>

      <main className="flex-1 px-4 py-4 md:px-6">
        {(error ?? actionError) && (
          <div
            role="alert"
            className="mb-3 flex items-center gap-2 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            <span className="font-mono">✗</span>
            <span className="flex-1">{error ?? actionError}</span>
            {actionError && (
              <button
                type="button"
                onClick={() => setActionError(null)}
                aria-label="Dismiss"
                className="text-danger/70 transition-colors duration-150 hover:text-danger"
              >
                ✕
              </button>
            )}
          </div>
        )}
        {processes.length === 0 ? (
          <EmptyState query={filter} scanned={snapshot?.scannedCount ?? 0} loading={snapshot === null} />
        ) : (
          <ProcessTable processes={processes} onKill={(pid, force) => void kill(pid, force)} />
        )}
      </main>

      <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2 font-mono text-xs text-muted md:px-6">
        <span>last update {snapshot ? new Date(snapshot.createdAt).toLocaleTimeString() : '—'}</span>
        <span className="hidden sm:inline">polling {intervalMs === 0 ? 'off' : `${intervalMs / 1000}s`}</span>
        <span className="hidden md:inline">api: /api/processes · kill: POST /api/kill</span>
      </footer>
    </div>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function PortBadges({ ports }: { ports: PortEntry[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ports.map((entry) => (
        <span
          key={`${entry.address}:${entry.port}`}
          title={entry.address}
          className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary"
        >
          {entry.port}
        </span>
      ))}
    </div>
  );
}

function ProcessTable({ processes, onKill }: { processes: DevProcess[]; onKill: KillAction }) {
  return (
    <>
      {/* md+: dense table */}
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border font-mono text-xs text-muted">
              <th scope="col" className="px-3 py-2 font-medium">PORTS</th>
              <th scope="col" className="px-3 py-2 font-medium">PROCESS</th>
              <th scope="col" className="px-3 py-2 font-medium">PID</th>
              <th scope="col" className="px-3 py-2 font-medium">USER</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {processes.map((proc) => (
              <tr
                key={proc.pid}
                className="border-b border-border/60 transition-colors duration-150 last:border-0 hover:bg-raised/40"
              >
                <td className="px-3 py-2">
                  <PortBadges ports={proc.ports} />
                </td>
                <td className="max-w-[26rem] px-3 py-2">
                  <div className="font-medium">
                    {proc.name}
                    {!proc.matched && <span className="ml-2 text-xs text-warning">unfiltered</span>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted" title={proc.command}>
                    {proc.command}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{proc.pid}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{proc.user}</td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    <KillButton label="kill" armedLabel="confirm?" onConfirm={() => onKill(proc.pid, false)} />
                    <KillButton
                      label="-9"
                      armedLabel="sure?"
                      title="SIGKILL"
                      onConfirm={() => onKill(proc.pid, true)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* below md: stacked cards */}
      <ul className="flex flex-col gap-2 md:hidden">
        {processes.map((proc) => (
          <li key={proc.pid} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {proc.name}
                {!proc.matched && <span className="ml-2 text-xs text-warning">unfiltered</span>}
              </span>
              <span className="font-mono text-xs text-muted">pid {proc.pid}</span>
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted" title={proc.command}>
              {proc.command}
            </div>
            <div className="mt-2">
              <PortBadges ports={proc.ports} />
            </div>
            <div className="mt-2 flex gap-1.5">
              <KillButton label="kill" armedLabel="confirm?" onConfirm={() => onKill(proc.pid, false)} />
              <KillButton
                label="-9"
                armedLabel="sure?"
                title="SIGKILL"
                onConfirm={() => onKill(proc.pid, true)}
              />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function EmptyState({ query, scanned, loading }: { query: string; scanned: number; loading: boolean }) {
  if (loading) {
    return <p className="font-mono text-xs text-muted">scanning…</p>;
  }
  const filtered = query.trim().length > 0;
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface/50 px-6 py-12 text-center">
      <p className="font-mono text-sm">
        {filtered ? `Nothing matches "${query.trim()}"` : 'No listening dev processes found.'}
      </p>
      <p className="mt-1 text-xs text-muted">
        {filtered
          ? 'Clear the filter to see everything.'
          : scanned > 0
            ? `${scanned} listening process(es) hidden by the dev filter — enable "all processes".`
            : 'Nothing is listening on TCP ports right now.'}
      </p>
    </div>
  );
}
