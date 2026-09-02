import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcess, ProcessNotFoundError, processExists } from './kill.js';

/** Spawn a node process that does nothing until signaled; resolves with its pid. */
async function spawnSleeper(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('failed to spawn child')));
  });
  if (typeof child.pid !== 'number') throw new Error('child pid missing');
  return child.pid;
}

describe('processExists', () => {
  it('detects the current process', () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it('returns false for a pid that cannot exist', () => {
    expect(processExists(999_999_999)).toBe(false);
  });
});

describe('killProcess', () => {
  it('refuses invalid pids', async () => {
    for (const pid of [0, 1, -5, Number.NaN, 1.5]) {
      await expect(killProcess(pid)).rejects.toThrow(/Refusing to kill invalid pid/);
    }
  });

  it('refuses to kill its own process', async () => {
    await expect(killProcess(process.pid)).rejects.toThrow(
      /Refusing to kill the WrongPort process itself/,
    );
  });

  it('throws ProcessNotFoundError for a pid that does not exist', async () => {
    await expect(killProcess(999_999_999)).rejects.toBeInstanceOf(ProcessNotFoundError);
  });

  it('terminates a spawned child with SIGTERM and reports the exit', async () => {
    const pid = await spawnSleeper();
    const result = await killProcess(pid);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exited).toBe(true);
    expect(processExists(pid)).toBe(false);
  });

  it('kills with SIGKILL when force is set', async () => {
    const pid = await spawnSleeper();
    const result = await killProcess(pid, { force: true });
    expect(result.signal).toBe('SIGKILL');
    expect(result.exited).toBe(true);
    expect(processExists(pid)).toBe(false);
  });

  it('maps a race-lost ESRCH to ProcessNotFoundError', async () => {
    const pid = await spawnSleeper();
    // The probe says alive, but the real signal hits ESRCH — the process died
    // between the existence check and the signal.
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
      return true;
    }) as typeof process.kill);
    let signalled = false;
    spy.mockImplementation(((pidArgument: number, signalArgument?: NodeJS.Signals | number) => {
      if (signalArgument === 0) return true;
      signalled = true;
      throw Object.assign(new Error('no process'), { code: 'ESRCH' });
    }) as typeof process.kill);
    try {
      await expect(killProcess(pid)).rejects.toBeInstanceOf(ProcessNotFoundError);
      expect(signalled).toBe(true);
    } finally {
      spy.mockRestore();
      process.kill(pid, 'SIGKILL');
    }
  });

  it('wraps unexpected signal errors', async () => {
    const pid = await spawnSleeper();
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pidArgument: number, signalArgument?: NodeJS.Signals | number) => {
      if (signalArgument === 0) return true;
      throw new Error('EPERM boom');
    }) as typeof process.kill);
    try {
      await expect(killProcess(pid)).rejects.toThrow(/kill SIGTERM \d+ failed: EPERM boom/);
    } finally {
      spy.mockRestore();
      process.kill(pid, 'SIGKILL');
    }
  });

  it('reports exited=false when the process survives the wait window', async () => {
    const pid = await spawnSleeper();
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);
    vi.useFakeTimers();
    try {
      // The stub swallows the real SIGTERM and keeps reporting the process as
      // alive, so waitForExit must run out its clock and return false.
      const pending = killProcess(pid);
      const result = await vi.advanceTimersByTimeAsync(3_100).then(() => pending);
      expect(result.exited).toBe(false);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
      process.kill(pid, 'SIGKILL');
    }
  });
});

describe('processExists error mapping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats EPERM (process owned by another user) as alive', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }) as typeof process.kill);
    expect(processExists(1234)).toBe(true);
  });

  it('treats other probe errors as not alive', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }) as typeof process.kill);
    expect(processExists(1234)).toBe(false);
  });
});
