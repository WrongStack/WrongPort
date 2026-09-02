import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './config.js';
import { joinListenRows, parseLsofOutput, ScanError, scanProcesses, type ProcessInfo } from './inspector.js';

const HEADER = 'COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME';

describe('parseLsofOutput', () => {
  it('parses a typical macOS LISTEN row with the (LISTEN) suffix', () => {
    const out = [
      HEADER,
      'node    1234 ersin   23u  IPv4  0xabcdef1234567890      0t0  TCP *:3000 (LISTEN)',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([
      { pid: 1234, name: 'node', user: 'ersin', entry: { port: 3000, address: '*:3000' } },
    ]);
  });

  it('parses rows without a state suffix', () => {
    const out = [
      HEADER,
      'node    1234 ersin   23u  IPv4  0xabcdef1234567890      0t0  TCP 127.0.0.1:5432',
    ].join('\n');
    expect(parseLsofOutput(out)[0]?.entry).toEqual({ port: 5432, address: '127.0.0.1:5432' });
  });

  it('parses IPv6 binds', () => {
    const out = [
      HEADER,
      'node    1234 ersin   24u  IPv6  0xabcdef1234567890      0t0  TCP [::]:5173 (LISTEN)',
    ].join('\n');
    expect(parseLsofOutput(out)[0]?.entry).toEqual({ port: 5173, address: '[::]:5173' });
  });

  it('keeps every listening socket of one process as separate rows', () => {
    const out = [
      HEADER,
      'node    1234 ersin   23u  IPv4  0x1      0t0  TCP *:3000 (LISTEN)',
      'node    1234 ersin   24u  IPv6  0x2      0t0  TCP [::]:3000 (LISTEN)',
    ].join('\n');
    expect(parseLsofOutput(out)).toHaveLength(2);
  });

  it('skips the header, blank lines, garbage and non-numeric pids', () => {
    const out = [
      HEADER,
      '',
      'some garbage line',
      'devin  notapid ersin 5u IPv4 0x1 0t0 TCP *:4000 (LISTEN)',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([]);
  });

  it('skips rows whose NAME carries no port', () => {
    const out = [HEADER, 'node    1234 ersin   23u  IPv4  0x1      0t0  TCP *:*'].join('\n');
    expect(parseLsofOutput(out)).toEqual([]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseLsofOutput('')).toEqual([]);
  });

  it('skips rows with out-of-range ports or non-positive pids', () => {
    const out = [
      HEADER,
      'node    1234 ersin   23u  IPv4  0x1      0t0  TCP *:0 (LISTEN)',
      'node    1234 ersin   24u  IPv4  0x2      0t0  TCP *:70000 (LISTEN)',
      'node    0    ersin   25u  IPv4  0x3      0t0  TCP *:4000 (LISTEN)',
      'node    -5   ersin   26u  IPv4  0x4      0t0  TCP *:4001 (LISTEN)',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([]);
  });
});

describe('joinListenRows', () => {
  const row = (
    pid: number,
    port: number,
    address = `*:${port}`,
    name = 'node',
    user = 'ersin',
  ) => ({ pid, name, user, entry: { port, address } });

  it('prefers ps information when the pid is known', () => {
    const infos = new Map<number, ProcessInfo>([
      [1234, { name: 'node', command: 'node server.js', user: 'ersin' }],
    ]);
    expect(joinListenRows([row(1234, 3000)], infos)).toEqual([
      { pid: 1234, name: 'node', command: 'node server.js', user: 'ersin', matched: false, ports: [{ port: 3000, address: '*:3000' }] },
    ]);
  });

  it('falls back to lsof columns when ps missed the pid (scan race)', () => {
    expect(joinListenRows([row(1234, 3000, '*:3000', 'vite', 'ersin')], new Map())).toEqual([
      { pid: 1234, name: 'vite', command: 'vite', user: 'ersin', matched: false, ports: [{ port: 3000, address: '*:3000' }] },
    ]);
  });

  it('merges multiple sockets of one pid into sorted, deduplicated ports', () => {
    const infos = new Map<number, ProcessInfo>([
      [7, { name: 'node', command: 'node srv.js', user: 'u' }],
    ]);
    const rows = [
      row(7, 5173, '[::]:5173'),
      row(7, 3000),
      row(7, 3000, '*:3000'), // duplicate row from a second socket on the same port
    ];
    const [proc] = joinListenRows(rows, infos);
    expect(proc?.ports).toEqual([
      { port: 3000, address: '*:3000' },
      { port: 5173, address: '[::]:5173' },
    ]);
  });
});

// scanProcesses talks to lsof/ps through promisify(execFile); node resolves the
// promise via execFile's custom promisify symbol, so the stub must provide it.
const execState = vi.hoisted(() => ({
  lsof: null as null | (() => Promise<{ stdout: string }>),
  ps: null as null | (() => Promise<{ stdout: string }>),
}));

vi.mock('node:child_process', () => {
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(() => {}, {
    [promisifyCustom]: (file: string) => {
      const handler = file === 'lsof' ? execState.lsof : execState.ps;
      if (handler === null) throw new Error(`no ${file} stub configured for this test`);
      return handler();
    },
  });
  return { execFile };
});

// Two node processes share port 3000 (SO_REUSEPORT) so the pid tiebreak of the
// result sort is exercised; 111 also owns 3001 to cover multi-port rows.
const LSOF_ROWS = [
  HEADER,
  'node      111  ersin  23u  IPv4  0x1      0t0  TCP *:3000 (LISTEN)',
  'node      111  ersin  24u  IPv4  0x2      0t0  TCP 127.0.0.1:3001 (LISTEN)',
  'node      555  ersin  25u  IPv4  0x3      0t0  TCP *:3000 (LISTEN)',
  'nc        222  ersin  21u  IPv6  0x4      0t0  TCP [::]:45943 (LISTEN)',
  'postgres  333  dba    40u  IPv4  0x5      0t0  TCP 127.0.0.1:5432 (LISTEN)',
  'node      111  ersin  26u  IPv4  0x6      0t0  TCP *:3000 (LISTEN)', // exact duplicate socket row
].join('\n');

// The trailing lines cover the guard branches of the ps parser: pid-only row,
// non-numeric pid, and a user without a command.
const PS_ROWS = [
  '  PID USER     COMMAND',
  '  111 ersin    /usr/local/bin/node server.js --port 3000',
  '  555 ersin    node worker.js',
  '  222 ersin    nc -l 45943',
  '  333 dba      /usr/lib/postgresql/bin/postgres -D data',
  '',
  '  444',
  '  notapid ersin cmd',
  '  445 ersin',
].join('\n');

function stubScan(): void {
  execState.lsof = async () => ({ stdout: LSOF_ROWS });
  execState.ps = async () => ({ stdout: PS_ROWS });
}

describe('scanProcesses (execFile stubbed, platform-independent)', () => {
  afterEach(() => {
    execState.lsof = null;
    execState.ps = null;
  });

  it('joins lsof + ps output and applies the default dev filter', async () => {
    stubScan();
    const snap = await scanProcesses(resolveConfig({}));
    expect(snap.platform).toBe(process.platform);
    expect(snap.scannedCount).toBe(4);
    // postgres matches the built-in dev list; nc is the only hidden one.
    expect(snap.processes.map((proc) => `${proc.name}#${proc.pid}`)).toEqual([
      'node#111',
      'node#555',
      'postgres#333',
    ]);
    const first = snap.processes[0];
    expect(first?.matched).toBe(true);
    expect(first?.user).toBe('ersin');
    expect(first?.command).toBe('/usr/local/bin/node server.js --port 3000');
    expect(first?.ports).toEqual([
      { port: 3000, address: '*:3000' },
      { port: 3001, address: '127.0.0.1:3001' },
    ]);
  });

  it('sorts all scans by first port and breaks ties by pid', async () => {
    stubScan();
    const snap = await scanProcesses(resolveConfig({}), { all: true });
    expect(snap.processes.map((proc) => proc.pid)).toEqual([111, 555, 333, 222]);
    const byName = new Map(snap.processes.map((proc) => [proc.name, proc]));
    expect(byName.get('node')?.matched).toBe(true);
    expect(byName.get('nc')?.matched).toBe(false);
  });

  it('treats only= as additive over the default filter', async () => {
    stubScan();
    const snap = await scanProcesses(resolveConfig({}), { only: ['\\bnc\\b'] });
    // only= widens the filter: everything the defaults already matched stays,
    // and nc is revealed on top.
    expect(snap.processes.map((proc) => `${proc.name}#${proc.pid}`)).toEqual([
      'node#111',
      'node#555',
      'postgres#333',
      'nc#222',
    ]);
    expect(snap.processes.every((proc) => proc.matched)).toBe(true);
  });

  it('narrows all scans when only= is given explicitly', async () => {
    stubScan();
    const hit = await scanProcesses(resolveConfig({}), { all: true, only: ['\\bnc\\b'] });
    expect(hit.processes.map((proc) => proc.name)).toEqual(['nc']);
    const miss = await scanProcesses(resolveConfig({}), { all: true, only: ['noSuchToken'] });
    expect(miss.processes).toEqual([]);
  });

  it('treats ports= as a hard constraint in every mode', async () => {
    stubScan();
    const narrowed = await scanProcesses(resolveConfig({}), { all: true, ports: [3000] });
    expect(narrowed.processes.map((proc) => proc.pid)).toEqual([111, 555]);
    const conflict = await scanProcesses(resolveConfig({}), {
      all: true,
      only: ['\\bnc\\b'],
      ports: [3000],
    });
    expect(conflict.processes).toEqual([]);
  });

  it('falls back to config ports when options.ports is absent', async () => {
    stubScan();
    const snap = await scanProcesses(resolveConfig({ ports: [5432] }));
    expect(snap.processes.map((proc) => proc.name)).toEqual(['postgres']);
  });

  it('honors exclude patterns over matching includes', async () => {
    stubScan();
    const config = resolveConfig({ include: ['\\bnode\\b'], exclude: ['server\\.js'] });
    const snap = await scanProcesses(config, { all: true });
    // 111 runs `node server.js` (excluded), 555 runs `node worker.js` (kept).
    expect(
      snap.processes.filter((proc) => proc.name === 'node').map((proc) => proc.matched),
    ).toEqual([false, true]);
    const filtered = await scanProcesses(config);
    expect(filtered.processes.map((proc) => `${proc.name}#${proc.pid}`)).toEqual(['node#555']);
  });

  it('maps an invalid only= pattern to a ScanError', async () => {
    stubScan();
    await expect(scanProcesses(resolveConfig({}), { only: ['['] })).rejects.toThrow(ScanError);
    await expect(scanProcesses(resolveConfig({}), { only: ['['] })).rejects.toThrow(
      /invalid only pattern "\["/,
    );
  });

  it('maps a missing lsof to a descriptive ScanError', async () => {
    stubScan();
    execState.lsof = async () => {
      throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' });
    };
    await expect(scanProcesses(resolveConfig({}))).rejects.toThrow(/`lsof` was not found on PATH/);
  });

  it('treats an lsof exit status of 1 as an empty result', async () => {
    stubScan();
    execState.lsof = async () => {
      throw Object.assign(new Error('exit status 1'), { code: 1 });
    };
    const snap = await scanProcesses(resolveConfig({}), { all: true });
    expect(snap.processes).toEqual([]);
    expect(snap.scannedCount).toBe(0);
  });

  it('wraps unexpected lsof failures in a ScanError', async () => {
    stubScan();
    execState.lsof = async () => {
      throw new Error('kaboom');
    };
    await expect(scanProcesses(resolveConfig({}))).rejects.toThrow('lsof failed: kaboom');
    // Non-Error throwables degrade to their string form.
    execState.lsof = async () => {
      throw 'plain lsof failure';
    };
    await expect(scanProcesses(resolveConfig({}))).rejects.toThrow('lsof failed: plain lsof failure');
  });

  it('maps a missing ps to a descriptive ScanError', async () => {
    stubScan();
    execState.ps = async () => {
      throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' });
    };
    await expect(scanProcesses(resolveConfig({}))).rejects.toThrow(/`ps` was not found on PATH/);
  });

  it('wraps unexpected ps failures in a ScanError', async () => {
    stubScan();
    execState.ps = async () => {
      throw new Error('kaboom');
    };
    await expect(scanProcesses(resolveConfig({}))).rejects.toThrow('ps failed: kaboom');
    execState.ps = async () => {
      throw 'plain ps failure';
    };
    await expect(scanProcesses(resolveConfig({}))).rejects.toThrow('ps failed: plain ps failure');
  });
});
