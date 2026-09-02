import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevProcess, Snapshot } from '../core/types.js';
import { isMainModule, program } from './index.js';

// The CLI module wires commander at import time; every I/O boundary is mocked
// so the command actions can be driven through program.parseAsync.
const loadConfigMock = vi.hoisted(() => vi.fn());
const resolveConfigMock = vi.hoisted(() => vi.fn());
const scanMock = vi.hoisted(() => vi.fn());
const killMock = vi.hoisted(() => vi.fn());
const startServerMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const questionMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('../core/config.js', () => ({
  loadConfig: loadConfigMock,
  resolveConfig: resolveConfigMock,
}));
vi.mock('../core/inspector.js', () => ({ scanProcesses: scanMock }));
vi.mock('../core/kill.js', () => ({
  killProcess: killMock,
  ProcessNotFoundError: class ProcessNotFoundError extends Error {
    constructor(public readonly pid: number) {
      super(`No process with pid ${pid}`);
      this.name = 'ProcessNotFoundError';
    }
  },
}));
vi.mock('../server/app.js', () => ({ startServer: startServerMock }));
vi.mock('node:fs/promises', () => ({ stat: statMock }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: questionMock, close: vi.fn() }),
}));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const proc = (over: Partial<DevProcess> = {}): DevProcess => ({
  pid: 111,
  name: 'node',
  command: 'node server.js',
  user: 'ersin',
  ports: [{ port: 3000, address: '*:3000' }],
  matched: true,
  ...over,
});

const snap = (processes: DevProcess[] = [proc()]): Snapshot => ({
  createdAt: 0,
  platform: 'test',
  processes,
  scannedCount: processes.length,
});

const CONFIG_TOKEN = { includePatterns: [], excludePatterns: [] } as never;

const parse = (args: string[]): Promise<unknown> =>
  program.parseAsync(['node', 'wrongport', ...args]);

const logged = (): string[] =>
  vi.mocked(console.log).mock.calls.map((call) => call.map((arg) => String(arg)).join(' '));

const errored = (): string[] =>
  vi.mocked(console.error).mock.calls.map((call) => call.map((arg) => String(arg)).join(' '));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'clear').mockImplementation(() => {});
  loadConfigMock.mockResolvedValue({});
  resolveConfigMock.mockReturnValue(CONFIG_TOKEN);
  scanMock.mockResolvedValue(snap());
  process.exitCode = 0;
});

afterEach(() => {
  // resetAllMocks also clears vi.fn() mocks (calls, implementations and once
  // queues) — restoreAllMocks alone leaves them carrying over between tests.
  vi.resetAllMocks();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('isMainModule', () => {
  const script = path.resolve('src/cli/index.ts');
  const moduleUrl = (): string => pathToFileURL(script).href;

  it('is false when node was invoked without a script argument', () => {
    // Passing undefined explicitly would re-trigger the default parameter, so
    // empty the argv tail to exercise the guard itself.
    const originalArgv = process.argv;
    process.argv = ['node'];
    try {
      expect(isMainModule(moduleUrl())).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('accepts the direct script path', () => {
    expect(isMainModule(moduleUrl(), script)).toBe(true);
  });

  it('follows realpath for a symlinked bin shim', () => {
    const unnormalized = path.join(path.dirname(script), '..', 'cli', 'index.ts');
    expect(isMainModule(moduleUrl(), unnormalized)).toBe(true);
  });

  it('rejects an unrelated script', () => {
    expect(isMainModule(moduleUrl(), path.resolve('package.json'))).toBe(false);
  });

  it('survives a nonexistent argv[1]', () => {
    expect(isMainModule(moduleUrl(), path.resolve('nope', 'missing.js'))).toBe(false);
  });
});

describe('ls', () => {
  it('renders a table for the bare command', async () => {
    await parse([]);
    expect(scanMock).toHaveBeenCalledWith(CONFIG_TOKEN, {
      all: undefined,
      only: undefined,
      ports: undefined,
    });
    expect(logged().join('\n')).toContain('node');
  });

  it('prints the raw JSON snapshot with --json', async () => {
    await parse(['ls', '--json']);
    expect(JSON.parse(logged()[0] ?? '{}')).toMatchObject({ scannedCount: 1 });
  });

  it('forwards --only, --ports and --all to the scan', async () => {
    scanMock.mockResolvedValue(snap([]));
    await parse(['ls', '-a', '--only', 'a, b ,,c', '--ports', '3000, 4000']);
    expect(scanMock).toHaveBeenLastCalledWith(CONFIG_TOKEN, {
      all: true,
      only: ['a', 'b', 'c'],
      ports: [3000, 4000],
    });
  });

  it('rejects an invalid --ports list without scanning', async () => {
    await parse(['ls', '--ports', '3000,abc']);
    expect(scanMock).not.toHaveBeenCalled();
    expect(errored().join('\n')).toContain('invalid port "abc"');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-integer port', async () => {
    await parse(['ls', '--ports', '3000.5']);
    expect(errored().join('\n')).toContain('invalid port "3000.5"');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an empty --ports list without scanning', async () => {
    await parse(['ls', '--ports', ' , ']);
    expect(scanMock).not.toHaveBeenCalled();
    expect(errored().join('\n')).toContain('empty --ports list');
    expect(process.exitCode).toBe(1);
  });

  it('keeps watch mode alive through transient scan failures and stops after 5', async () => {
    scanMock.mockResolvedValueOnce(snap());
    for (let i = 0; i < 5; i += 1) scanMock.mockRejectedValueOnce(new Error('lsof timed out'));
    await parse(['ls', '--watch', '0.001']);
    expect(scanMock).toHaveBeenCalledTimes(6);
    expect(errored().join('\n')).toContain('lsof timed out');
    expect(errored().join('\n')).toContain('scan failed 5 times in a row');
    expect(process.exitCode).toBe(1);
  });

  it('clears the exit code after a watch recovery', async () => {
    scanMock.mockResolvedValueOnce(snap());
    scanMock.mockRejectedValueOnce(new Error('busy machine'));
    scanMock.mockResolvedValueOnce(snap());
    for (let i = 0; i < 5; i += 1) scanMock.mockRejectedValueOnce(new Error('busy machine'));
    await parse(['ls', '--watch', '0.001']);
    expect(scanMock).toHaveBeenCalledTimes(8);
    expect(process.exitCode).toBe(1);
  });

  it('supports bare --watch with the 3s default cadence', async () => {
    vi.useFakeTimers();
    try {
      scanMock.mockRejectedValue(new Error('still broken'));
      const run = parse(['ls', '--watch']);
      // Four sleeps separate the five attempts before the streak stops the loop.
      await vi.advanceTimersByTimeAsync(3_000 * 4 + 10);
      await run;
      expect(scanMock).toHaveBeenCalledTimes(5);
      expect(process.exitCode).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to a 3s cadence for a non-numeric --watch value', async () => {
    vi.useFakeTimers();
    try {
      scanMock.mockRejectedValue(new Error('still broken'));
      const run = parse(['ls', '--watch', 'abc']);
      await vi.advanceTimersByTimeAsync(3_000 * 4 + 10);
      await run;
      expect(scanMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails gracefully when the scan errors', async () => {
    scanMock.mockRejectedValue(new Error('config broken'));
    await parse(['ls']);
    expect(errored().join('\n')).toContain('config broken');
    expect(process.exitCode).toBe(1);
  });

  it('fails gracefully when the bare command scan errors', async () => {
    scanMock.mockRejectedValue('plain string failure');
    await parse([]);
    expect(errored().join('\n')).toContain('plain string failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('kill', () => {
  it('kills by pid with -y and reports a clean exit', async () => {
    killMock.mockResolvedValue({ pid: 111, signal: 'SIGTERM', exited: true });
    await parse(['kill', '111', '-y']);
    expect(killMock).toHaveBeenCalledWith(111, { force: undefined });
    expect(logged().join('\n')).toContain('exited after SIGTERM');
  });

  it('kills by port and reports a still-shutting-down process', async () => {
    killMock.mockResolvedValue({ pid: 111, signal: 'SIGKILL', exited: false });
    await parse(['kill', '3000', '-y', '-f']);
    expect(killMock).toHaveBeenCalledWith(111, { force: true });
    expect(logged().join('\n')).toContain('still shutting down');
  });

  it('reports an unmatched target and skips the kill', async () => {
    scanMock.mockResolvedValue(snap([]));
    await parse(['kill', '4242']);
    expect(killMock).not.toHaveBeenCalled();
    expect(errored().join('\n')).toContain('4242 matched no dev-filtered process');
    expect(process.exitCode).toBe(1);
  });

  it('labels non-dev matches when --all is set', async () => {
    scanMock.mockResolvedValue(snap([]));
    await parse(['kill', '4242', '-a']);
    expect(errored().join('\n')).toContain('4242 matched no process in the latest scan');
  });

  it('treats a non-numeric target as unmatched', async () => {
    await parse(['kill', 'vite', '-y']);
    expect(killMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('aborts when the confirmation is declined', async () => {
    scanMock.mockResolvedValue(
      snap([
        proc({
          pid: 222,
          ports: [
            { port: 3000, address: '*:3000' },
            { port: 3001, address: '127.0.0.1:3001' },
          ],
        }),
      ]),
    );
    questionMock.mockResolvedValue('nope');
    await parse(['kill', '222', '-a']);
    expect(questionMock).toHaveBeenCalled();
    expect(killMock).not.toHaveBeenCalled();
    expect(logged().join('\n')).toContain('Aborted.');
  });

  it('proceeds on y/yes confirmations but not on anything else', async () => {
    killMock.mockResolvedValue({ pid: 111, signal: 'SIGTERM', exited: true });

    questionMock.mockResolvedValue('y');
    await parse(['kill', '111']);
    expect(killMock).toHaveBeenCalledTimes(1);

    questionMock.mockResolvedValue('yes');
    await parse(['kill', '111']);
    expect(killMock).toHaveBeenCalledTimes(2);

    killMock.mockClear();
    questionMock.mockResolvedValue('maybe');
    await parse(['kill', '111']);
    expect(killMock).not.toHaveBeenCalled();
    expect(logged().join('\n')).toContain('Aborted.');
  });

  it('reports ProcessNotFoundError distinctly', async () => {
    const { ProcessNotFoundError } = await import('../core/kill.js');
    killMock.mockRejectedValue(new ProcessNotFoundError(111));
    await parse(['kill', '111', '-y']);
    expect(errored().join('\n')).toContain('No process with pid 111');
    expect(process.exitCode).toBe(1);
  });

  it('routes other kill failures through the generic handler', async () => {
    killMock.mockRejectedValue(new Error('EPERM'));
    await parse(['kill', '111', '-y']);
    expect(errored().join('\n')).toContain('EPERM');
    expect(process.exitCode).toBe(1);
  });

  it('routes non-Error failures through the generic handler too', async () => {
    killMock.mockRejectedValue('plain string failure');
    await parse(['kill', '111', '-y']);
    expect(errored().join('\n')).toContain('plain string failure');
    expect(process.exitCode).toBe(1);
  });
});

describe('serve', () => {
  it('serves the API and warns when the web build is missing', async () => {
    statMock.mockRejectedValue(new Error('missing'));
    startServerMock.mockResolvedValue({ url: 'http://127.0.0.1:3789', close: () => {} });
    await parse(['serve']);
    expect(startServerMock).toHaveBeenCalledWith(
      { port: undefined, host: undefined, webDistDir: undefined },
      CONFIG_TOKEN,
    );
    expect(errored().join('\n')).toContain('Web UI build not found');
  });

  it('passes the web dist dir and port when present', async () => {
    statMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ url: 'http://127.0.0.1:4004', close: () => {} });
    await parse(['serve', '-p', '4004', '-H', '0.0.0.0']);
    expect(startServerMock).toHaveBeenCalledWith(
      { port: 4004, host: '0.0.0.0', webDistDir: expect.any(String) },
      CONFIG_TOKEN,
    );
    expect(logged().join('\n')).toContain('WrongPort is listening');
  });

  it('maps serve startup failures to the failure path', async () => {
    statMock.mockRejectedValue(new Error('missing'));
    startServerMock.mockRejectedValue(new Error('port 3789 is already in use'));
    await parse(['serve']);
    expect(process.exitCode).toBe(1);
    expect(errored().join('\n')).toContain('already in use');
  });

  it('opens a browser with --open and tolerates spawn failures', async () => {
    statMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ url: 'http://127.0.0.1:3789', close: () => {} });
    const handlers: Record<string, (err?: unknown) => void> = {};
    spawnMock.mockReturnValue({
      on: (event: string, cb: (err?: unknown) => void) => {
        handlers[event] = cb;
      },
      unref: () => {},
    });

    await parse(['serve', '--open']);
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'http://127.0.0.1:3789'],
      { detached: true, stdio: 'ignore' },
    );
    handlers.error?.(new Error('no default browser'));
    expect(errored().join('\n')).toContain('Could not open a browser');

    spawnMock.mockImplementation(() => {
      throw new Error('spawn exploded');
    });
    await parse(['serve', '--open']);
    expect(errored().join('\n')).toContain('Could not open a browser');
  });

  it('picks the platform browser command', async () => {
    statMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ url: 'http://127.0.0.1:3789', close: () => {} });
    spawnMock.mockReturnValue({ on: () => {}, unref: () => {} });
    const original = process.platform;
    const setPlatform = (value: string): void => {
      Object.defineProperty(process, 'platform', { value, configurable: true });
    };
    try {
      setPlatform('darwin');
      await parse(['serve', '--open']);
      expect(spawnMock).toHaveBeenLastCalledWith(
        'open',
        ['http://127.0.0.1:3789'],
        expect.anything(),
      );
      setPlatform('linux');
      await parse(['serve', '--open']);
      expect(spawnMock).toHaveBeenLastCalledWith(
        'xdg-open',
        ['http://127.0.0.1:3789'],
        expect.anything(),
      );
    } finally {
      setPlatform(original);
    }
  });
});

describe('module entry', () => {
  it('executes the CLI when imported as the main module', async () => {
    const script = path.resolve('src/cli/index.ts');
    // commander answers --version with process.exit(0); vitest intercepts a
    // real exit, so stub it and assert the code instead.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const originalArgv = process.argv;
    process.argv = ['node', script, '--version'];
    try {
      vi.resetModules();
      await import('./index.js');
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      process.argv = originalArgv;
    }
  });

  it('keeps the CLI version in sync with package.json', () => {
    const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      version: string;
    };
    expect(program.version()).toBe(pkg.version);
  });
});
