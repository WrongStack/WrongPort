import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../core/config.js';
import { startServer } from './app.js';

const config = resolveConfig({});

const serveMock = vi.hoisted(() => vi.fn());
vi.mock('@hono/node-server', () => ({ serve: serveMock }));

interface FakeServerOptions {
  error?: { code?: string; message?: string };
  address?: { port: number } | null;
}

function fakeServer({ error, address = { port: 1234 } }: FakeServerOptions) {
  const server = new EventEmitter() as EventEmitter & {
    address: () => { port: number } | null;
    close: (cb?: () => void) => unknown;
  };
  server.address = () => address;
  server.close = (cb?: () => void) => {
    cb?.();
    return server;
  };
  serveMock.mockReturnValue(server);
  queueMicrotask(() => {
    if (error !== undefined) {
      server.emit('error', Object.assign(new Error(error.message ?? 'boom'), error));
    } else {
      server.emit('listening');
    }
  });
  return server;
}

afterEach(() => {
  serveMock.mockReset();
});

describe('startServer bind handling (serve mocked)', () => {
  it('maps EACCES to an elevated-privileges hint', async () => {
    fakeServer({ error: { code: 'EACCES', message: 'denied' } });
    await expect(startServer({ port: 80, host: '127.0.0.1' }, config)).rejects.toThrow(
      /needs elevated privileges/,
    );
  });

  it('maps unknown bind errors to a generic could-not-bind message', async () => {
    fakeServer({ error: { code: 'ENOENT', message: 'nope' } });
    await expect(startServer({ port: 4000, host: '0.0.0.0' }, config)).rejects.toThrow(
      /could not bind 0\.0\.0\.0:4000: nope/,
    );
  });

  it('falls back to the requested port when address() has nothing yet', async () => {
    fakeServer({ address: null });
    const started = await startServer({ port: 45_999, host: '127.0.0.1' }, config);
    expect(started.url).toBe('http://127.0.0.1:45999');
    started.close();
  });

  it('displays localhost for a wildcard IPv6 bind', async () => {
    fakeServer({});
    const started = await startServer({ port: 1, host: '::' }, config);
    expect(started.url).toBe('http://localhost:1234');
    started.close();
  });

  it('swallows stray socket errors raised after a successful bind', async () => {
    const server = fakeServer({});
    const started = await startServer({ port: 45_998, host: '127.0.0.1' }, config);
    // A late socket hiccup must not crash the process (app.ts registers a noop).
    server.emit('error', Object.assign(new Error('stray'), { code: 'EPIPE' }));
    started.close();
  });
});
