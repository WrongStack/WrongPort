import { describe, expect, it } from 'vitest';
import { isLoopbackBinding, isWildcardBinding } from './portAddress';

describe('isWildcardBinding', () => {
  it('treats wildcard binds as exposed', () => {
    expect(isWildcardBinding('*:3000')).toBe(true);
    expect(isWildcardBinding('0.0.0.0:3000')).toBe(true);
    expect(isWildcardBinding('[::]:5173')).toBe(true);
    expect(isWildcardBinding(':::5173')).toBe(true);
  });

  it('treats loopback and LAN-address binds as not wildcard', () => {
    expect(isWildcardBinding('127.0.0.1:5432')).toBe(false);
    expect(isWildcardBinding('[::1]:3000')).toBe(false);
    expect(isWildcardBinding('192.168.1.20:8080')).toBe(false);
    expect(isWildcardBinding('::1:3000')).toBe(false);
  });

  it('handles addresses without a port suffix', () => {
    expect(isWildcardBinding('*')).toBe(true);
    expect(isLoopbackBinding('127.0.0.1')).toBe(true);
    expect(isLoopbackBinding('*')).toBe(false);
  });

  it('parses by host, not by substring', () => {
    // "[::1]" contains "[::" but is loopback — must not be flagged.
    expect(isWildcardBinding('[::1]:3000')).toBe(false);
    // "10.0.0.10:3000" contains "0.0.0" but is a specific address.
    expect(isWildcardBinding('10.0.0.10:3000')).toBe(false);
  });
});

describe('isLoopbackBinding', () => {
  it('recognizes the 127.0.0.0/8 range and IPv6 loopback', () => {
    expect(isLoopbackBinding('127.0.0.1:5432')).toBe(true);
    expect(isLoopbackBinding('127.9.9.9:80')).toBe(true);
    expect(isLoopbackBinding('[::1]:3000')).toBe(true);
    expect(isLoopbackBinding('::1:3000')).toBe(true);
  });

  it('never claims loopback for wildcard or specific-interface binds', () => {
    expect(isLoopbackBinding('*:3000')).toBe(false);
    expect(isLoopbackBinding('0.0.0.0:3000')).toBe(false);
    expect(isLoopbackBinding('[::]:5173')).toBe(false);
    expect(isLoopbackBinding('192.168.1.20:8080')).toBe(false);
    expect(isLoopbackBinding('[::ffff:192.168.1.5]:3000')).toBe(false);
  });
});
