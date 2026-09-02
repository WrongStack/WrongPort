export class ProcessNotFoundError extends Error {
  constructor(
    public readonly pid: number,
  ) {
    super(`No process with pid ${pid}`);
    this.name = 'ProcessNotFoundError';
  }
}

/** Signal 0 probes for existence without sending anything. Survives EPERM (owned by root). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface KillOptions {
  /** SIGKILL instead of SIGTERM. */
  force?: boolean;
}

export interface KillResult {
  pid: number;
  signal: 'SIGTERM' | 'SIGKILL';
  /** Whether the process was confirmed gone before the wait timeout. */
  exited: boolean;
}

/**
 * Send a signal to a pid and wait briefly for the process to disappear.
 * Refuses invalid pids, init-like pids and the WrongPort process itself.
 */
export async function killProcess(pid: number, options: KillOptions = {}): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to kill invalid pid: ${pid}`);
  }
  if (pid === process.pid) {
    throw new Error('Refusing to kill the WrongPort process itself');
  }
  if (!processExists(pid)) {
    throw new ProcessNotFoundError(pid);
  }
  const signal = options.force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') throw new ProcessNotFoundError(pid);
    throw new Error(`kill ${signal} ${pid} failed: ${(err as Error).message}`);
  }
  const exited = await waitForExit(pid, signal === 'SIGKILL' ? 1_500 : 3_000);
  return { pid, signal, exited };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    if (!processExists(pid)) return true;
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
