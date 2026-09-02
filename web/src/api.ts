import type { Snapshot } from './types';

/** Fetch failure carrying the HTTP status — the API contract callers key on. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function raise(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // keep the generic message
  }
  throw new ApiError(message, res.status);
}

export async function fetchProcesses(options: {
  all: boolean;
  only?: string;
  ports?: string;
  signal: AbortSignal;
}): Promise<Snapshot> {
  const params = new URLSearchParams({ all: options.all ? '1' : '0' });
  if (options.only) params.set('only', options.only);
  if (options.ports) params.set('ports', options.ports);
  const res = await fetch(`/api/processes?${params.toString()}`, { signal: options.signal });
  if (!res.ok) await raise(res);
  return (await res.json()) as Snapshot;
}

export async function killProcess(pid: number, force: boolean): Promise<void> {
  const res = await fetch('/api/kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, force }),
  });
  if (!res.ok) await raise(res);
}

/**
 * Kill a pid, surviving one stale-snapshot rejection: the server only
 * authorizes pids seen in a scan from the last 30 seconds and marks that case
 * with 409 — regardless of message wording — so a user who paused polling (or
 * hesitated at the confirm step) gets an automatic refresh and one retry
 * instead of an error.
 */
export async function killWithStaleRecovery(
  pid: number,
  force: boolean,
  refresh: () => Promise<void>,
): Promise<void> {
  try {
    await killProcess(pid, force);
    return;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
  }
  await refresh();
  await killProcess(pid, force);
}
