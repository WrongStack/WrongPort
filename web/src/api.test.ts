import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProcesses, killWithStaleRecovery } from './api';
import type { Snapshot } from './types';

const SNAPSHOT: Snapshot = {
  createdAt: 1_700_000_000_000,
  platform: 'test',
  processes: [],
  scannedCount: 0,
};

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchProcesses', () => {
  it('builds the server query from all/only/ports', async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => jsonResponse(SNAPSHOT, 200));
    vi.stubGlobal('fetch', fetchMock);
    await fetchProcesses({ all: true, only: 'vite', ports: '3000', signal: new AbortController().signal });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/processes?all=1&only=vite&ports=3000');
  });

  it('omits unset filter params', async () => {
    const fetchMock = vi.fn(async (_url: string | URL) => jsonResponse(SNAPSHOT, 200));
    vi.stubGlobal('fetch', fetchMock);
    await fetchProcesses({ all: false, signal: new AbortController().signal });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/processes?all=0');
  });

  it('surfaces the server error message instead of a bare status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid only pattern "["' }, 400)),
    );
    await expect(
      fetchProcesses({ all: false, only: '[', signal: new AbortController().signal }),
    ).rejects.toThrow(/invalid only pattern/);
  });
});

describe('killWithStaleRecovery', () => {
  it('does not refresh when the first kill succeeds', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) =>
      jsonResponse({ pid: 7, signal: 'SIGTERM', exited: true }, 200),
    );
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn(async () => {});
    await killWithStaleRecovery(7, false, refresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes and retries exactly once when the snapshot went stale (409)', async () => {
    let kills = 0;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'POST') return jsonResponse(SNAPSHOT, 200);
      kills += 1;
      if (kills === 1) {
        return jsonResponse(
          { error: 'pid 7 was not in the latest scan — refresh and retry' },
          409,
        );
      }
      return jsonResponse({ pid: 7, signal: 'SIGTERM', exited: true }, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn(async () => {});
    await killWithStaleRecovery(7, false, refresh);
    expect(kills).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('propagates non-stale kill errors without refreshing or retrying', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'kill refused by policy' }, 403)),
    );
    const refresh = vi.fn(async () => {});
    await expect(killWithStaleRecovery(7, false, refresh)).rejects.toThrow(/refused by policy/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keys the retry on the 409 status, not on the message wording', async () => {
    let posts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') !== 'POST') return jsonResponse(SNAPSHOT, 200);
        posts += 1;
        if (posts === 1) return jsonResponse({ error: 'totally different wording' }, 409);
        return jsonResponse({ pid: 7, signal: 'SIGTERM', exited: true }, 200);
      }),
    );
    const refresh = vi.fn(async () => {});
    await killWithStaleRecovery(7, false, refresh);
    expect(posts).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
