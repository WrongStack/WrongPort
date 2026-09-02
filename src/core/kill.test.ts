import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
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
});
