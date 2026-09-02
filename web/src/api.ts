import type { Snapshot } from './types';

async function raise(res: Response): Promise<never> {
  let message = `HTTP ${res.status}`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // keep the generic message
  }
  throw new Error(message);
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
