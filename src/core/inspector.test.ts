import { describe, expect, it } from 'vitest';
import { joinListenRows, parseLsofOutput, type ProcessInfo } from './inspector.js';

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
