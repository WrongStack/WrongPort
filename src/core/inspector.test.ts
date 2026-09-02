import { describe, expect, it } from 'vitest';
import { parseLsofOutput } from './inspector.js';

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
