import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevProcess, Snapshot } from '../core/types.js';
import { bold, cyan, dim, green, red, renderTable, yellow } from './table.js';

const proc = (over: Partial<DevProcess> = {}): DevProcess => ({
  pid: 1234,
  name: 'node',
  command: 'node server.js',
  user: 'ersin',
  ports: [{ port: 3000, address: '*:3000' }],
  matched: true,
  ...over,
});

const snapshot = (processes: DevProcess[], scannedCount = processes.length): Snapshot => ({
  createdAt: new Date('2026-01-01T10:20:30Z').getTime(),
  platform: process.platform,
  processes,
  scannedCount,
});

describe('ansi helpers', () => {
  it('wrap text in the matching escape codes', () => {
    expect(bold('x')).toBe('\x1b[1mx\x1b[22m');
    expect(dim('x')).toBe('\x1b[2mx\x1b[22m');
    expect(cyan('x')).toBe('\x1b[36mx\x1b[39m');
    expect(green('x')).toBe('\x1b[32mx\x1b[39m');
    expect(yellow('x')).toBe('\x1b[33mx\x1b[39m');
    expect(red('x')).toBe('\x1b[31mx\x1b[39m');
  });
});

describe('renderTable', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (process.stdout as { columns?: number }).columns;
  });

  it('prints header, rows and a footer', () => {
    renderTable(
      snapshot([
        proc(),
        proc({
          pid: 99,
          name: 'vite',
          command: 'npm run dev',
          user: 'ci',
          ports: [{ port: 5173, address: '127.0.0.1:5173' }],
        }),
      ]),
    );
    const out = logs.join('\n');
    expect(out).toContain('PID');
    expect(out).toContain('PORTS');
    expect(out).toContain('NAME');
    expect(out).toContain('COMMAND');
    expect(out).toContain('USER');
    expect(out).toContain('1234');
    expect(out).toContain('3000');
    expect(out).toContain('node server.js');
    expect(out).toContain('ersin');
    expect(out).toContain('2 process(es) · scanned 2 listening');
  });

  it('honors a narrow stdout when sizing the command column', () => {
    (process.stdout as { columns?: number }).columns = 60;
    renderTable(snapshot([proc({ command: 'x'.repeat(80) })]));
    expect(logs.join('\n')).toContain('…');
  });

  it('truncates over-wide process names', () => {
    renderTable(snapshot([proc({ name: 'n'.repeat(30), command: 'c' })]));
    expect(logs.join('\n')).toContain('…');
  });

  it('explains hidden processes when the dev filter hides everything', () => {
    renderTable(snapshot([], 7));
    expect(logs.join('\n')).toContain(
      'Nothing matched the dev filter — 7 listening process(es) hidden',
    );
  });

  it('reports an empty machine', () => {
    renderTable(snapshot([], 0));
    expect(logs.join('\n')).toContain('No listening TCP ports found.');
  });
});
