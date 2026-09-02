import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProcesses } from './api';
import type { Snapshot } from './types';

interface UseProcessesOptions {
  /** Poll interval in ms; 0 pauses polling. */
  intervalMs: number;
  all: boolean;
  /** Server-side extra include pattern (only=). */
  only?: string;
  /** Server-side port narrowing (ports=). */
  ports?: string;
}

export function useProcesses({ intervalMs, all, only, ports }: UseProcessesOptions) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);
    try {
      const next = await fetchProcesses({ all, only, ports, signal: controller.signal });
      setSnapshot(next);
      setError(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setRefreshing(false);
      }
    }
  }, [all, only, ports]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    // Debounce filter-driven refetches; the interval keeps the view fresh after.
    const start = window.setTimeout(() => void load(), 250);
    const timer = window.setInterval(() => {
      // Don't hammer lsof while the tab is in the background.
      if (document.visibilityState === 'visible') void load();
    }, intervalMs);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(timer);
      inFlight.current?.abort();
    };
  }, [load, intervalMs]);

  useEffect(() => {
    // The interval skips hidden-tab ticks, so returning to the tab can wait a
    // full period — refresh immediately instead.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  return { snapshot, error, refreshing, refresh: load };
}
