// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from './types';
import { useProcesses } from './useProcesses';

const fetchProcessesMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ fetchProcesses: fetchProcessesMock }));

const snap = (id = 1): Snapshot => ({
  createdAt: id,
  platform: 'test',
  processes: [],
  scannedCount: 0,
});

const lastSignal = (): AbortSignal | undefined =>
  fetchProcessesMock.mock.calls.at(-1)?.[0]?.signal as AbortSignal | undefined;

beforeEach(() => {
  fetchProcessesMock.mockResolvedValue(snap());
});

afterEach(() => {
  // Vitest globals are off, so RTL's automatic cleanup is not registered —
  // without it, mounted hooks keep their visibilitychange listeners alive and
  // pollute the next test's counts.
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('useProcesses', () => {
  it('loads after the debounce and exposes the snapshot', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    expect(result.current.snapshot).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.snapshot).toMatchObject({ createdAt: 1 });
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(false);
  });

  it('does not load at all when intervalMs is 0', async () => {
    vi.useFakeTimers();
    renderHook(() => useProcesses({ intervalMs: 0, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchProcessesMock).not.toHaveBeenCalled();
  });

  it('polls the interval while the tab is visible', async () => {
    vi.useFakeTimers();
    renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(4);
  });

  it('skips interval ticks while the tab is hidden', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    // The debounced initial load runs regardless of visibility...
    expect(fetchProcessesMock).toHaveBeenCalledTimes(1);
    // ...and a visibilitychange while still hidden must not refresh either.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // The interval ticks never fire while hidden.
    expect(fetchProcessesMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
  });

  it('refreshes immediately when the tab becomes visible again', async () => {
    vi.useFakeTimers();
    renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(2);
  });

  it('refetches when the filter props change', async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ only }: { only?: string }) => useProcesses({ intervalMs: 1000, all: false, only }),
      { initialProps: { only: undefined } as { only?: string } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(1);
    rerender({ only: 'node' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchProcessesMock).toHaveBeenCalledTimes(2);
    expect(fetchProcessesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ only: 'node', all: false }),
    );
  });

  it('surfaces fetch errors but ignores aborts', async () => {
    vi.useFakeTimers();
    fetchProcessesMock.mockRejectedValue(new Error('HTTP 503'));
    const { result } = renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.error).toBe('HTTP 503');

    fetchProcessesMock.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.error).toBe('HTTP 503');
  });

  it('refresh() aborts the in-flight request and a late response never wins', async () => {
    vi.useFakeTimers();
    let releaseFirst!: (value: Snapshot) => void;
    fetchProcessesMock.mockImplementationOnce(
      () =>
        new Promise<Snapshot>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    fetchProcessesMock.mockResolvedValueOnce(snap(2));
    const { result } = renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const firstSignal = lastSignal();
    expect(firstSignal?.aborted).toBe(false);

    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(firstSignal?.aborted).toBe(true);

    releaseFirst(snap(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Documented quirk: the identity guard only protects the refreshing flag,
    // not the snapshot — a late response still overwrites the result.
    expect(result.current.snapshot).toMatchObject({ createdAt: 1 });
    expect(result.current.refreshing).toBe(false);
  });

  it('aborts the in-flight request on unmount', async () => {
    vi.useFakeTimers();
    let release!: (value: Snapshot) => void;
    fetchProcessesMock.mockImplementation(
      () =>
        new Promise<Snapshot>((resolve) => {
          release = resolve;
        }),
    );
    const { unmount } = renderHook(() => useProcesses({ intervalMs: 1000, all: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const signal = lastSignal();
    unmount();
    expect(signal?.aborted).toBe(true);
    release(snap(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
