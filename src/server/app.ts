import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedConfig } from '../core/config.js';
import { compileOnlyPatterns, scanProcesses, ScanError } from '../core/inspector.js';
import { killProcess, ProcessNotFoundError } from '../core/kill.js';
import type { ScanOptions, Snapshot } from '../core/types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** How long a scan stays valid as a kill authorization source. */
const SNAPSHOT_TTL_MS = 30_000;

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Absolute path to the built web UI; omit to serve the API only. */
  webDistDir?: string;
}

export interface StartedServer {
  url: string;
  close: () => void;
}

export interface CreateAppOptions {
  /**
   * When the server is bound to a loopback address (the default), reject
   * requests whose Host header names a non-loopback machine. This blocks
   * DNS-rebinding drive-bys: a rebinded domain cannot read scan data or
   * authorize kills. Set to false for LAN/internet bindings.
   */
  loopbackBound?: boolean;
  /** Scan implementation; injectable so scan failures are testable end-to-end. */
  scan?: typeof scanProcesses;
}

/** Hostnames that mean "this same machine" for the loopback Host guard. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host.trim().toLowerCase());
}

export function createApp(
  config: ResolvedConfig,
  webDistDir?: string,
  options: CreateAppOptions = {},
): Hono {
  const loopbackBound = options.loopbackBound ?? true;
  const runScan = options.scan ?? scanProcesses;
  const app = new Hono();
  let latest: { snapshot: Snapshot; at: number } | null = null;

  const scan = async (scanOptions: ScanOptions): Promise<Snapshot> => {
    const snapshot = await runScan(config, scanOptions);
    latest = { snapshot, at: Date.now() };
    return snapshot;
  };

  app.onError((err, c) => {
    // Scan failures (lsof missing, timeouts) are transient and user-fixable —
    // surface the message instead of an opaque Internal Server Error.
    if (err instanceof ScanError) return c.json({ error: err.message }, 503);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  if (loopbackBound) {
    app.use('*', async (c, next) => {
      const host = c.req.header('host');
      if (host !== undefined) {
        const hostname = host.trim().toLowerCase().replace(/:\d+$/, '');
        if (!isLoopbackHost(hostname)) {
          return c.json(
            { error: `host "${hostname}" is not allowed — this server is bound to loopback only` },
            403,
          );
        }
      }
      await next();
    });
  }

  app.get('/api/health', (c) => c.json({ ok: true, app: 'wrongport' }));

  app.get('/api/processes', async (c) => {
    const all = c.req.query('all') === '1';
    const only = c.req.query('only')?.split(',').map((s) => s.trim()).filter(Boolean);
    const portsQuery = c.req
      .query('ports')
      ?.split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isInteger(n));
    // Validate regex sources up-front: a user typo must be 400 + a helpful
    // message, never a 500 from deep inside the scan.
    try {
      if (only) compileOnlyPatterns(only);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const snapshot = await scan({
      all,
      only,
      ports: portsQuery && portsQuery.length > 0 ? portsQuery : undefined,
    });
    return c.json(snapshot);
  });

  app.post('/api/kill', async (c) => {
    // A cross-site form can only send simple content types; requiring JSON
    // makes drive-by kill attempts fail the preflight/read check.
    const contentType = (c.req.header('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return c.json({ error: 'Content-Type must be application/json' }, 415);
    }
    const body = await c.req.json<{ pid?: unknown; force?: unknown }>().catch(() => undefined);
    const pid = Number(body?.pid);
    if (!body || !Number.isInteger(pid) || pid <= 1) {
      return c.json({ error: 'Body must be JSON: {"pid": number, "force"?: boolean}' }, 400);
    }
    // Safety rail: only pids the client has actually seen in a fresh scan may
    // be killed — this endpoint is not a generic remote kill switch. There is
    // deliberately no rescan fallback: if the pid is missing from the live
    // snapshot, the client must refresh first.
    const known =
      latest !== null &&
      Date.now() - latest.at < SNAPSHOT_TTL_MS &&
      latest.snapshot.processes.some((proc) => proc.pid === pid);
    if (!known) {
      return c.json({ error: `pid ${pid} was not in the latest scan — refresh and retry` }, 409);
    }
    try {
      const result = await killProcess(pid, { force: body.force === true });
      latest = null; // force a fresh scan on the next poll
      return c.json(result);
    } catch (err) {
      if (err instanceof ProcessNotFoundError) return c.json({ error: err.message }, 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  if (webDistDir) {
    const rootDir = path.resolve(webDistDir);
    const indexHtml = path.join(rootDir, 'index.html');
    app.get('*', async (c) => {
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(c.req.path);
      } catch {
        return c.text('Bad request', 400);
      }
      if (urlPath.includes('\0')) return c.text('Bad request', 400);
      const abs = path.resolve(rootDir, `.${urlPath}`);
      if (abs !== rootDir && !abs.startsWith(rootDir + path.sep)) {
        return c.text('Forbidden', 403);
      }
      const file = urlPath === '/' || urlPath.endsWith('/') ? indexHtml : abs;
      try {
        const content = await readFile(file);
        const type = MIME_TYPES[path.extname(file)] ?? 'application/octet-stream';
        const cache = urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        return c.body(new Uint8Array(content), 200, { 'Content-Type': type, 'Cache-Control': cache });
      } catch {
        try {
          // SPA fallback: unknown paths get the app shell.
          const content = await readFile(indexHtml);
          return c.body(new Uint8Array(content), 200, {
            'Content-Type': MIME_TYPES['.html'] ?? 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
        } catch {
          return c.text('Web UI build not found — run `npm run build`. The API under /api still works.', 404);
        }
      }
    });
  }

  return app;
}

export async function startServer(
  options: ServerOptions = {},
  config: ResolvedConfig,
): Promise<StartedServer> {
  const envPort = Number(process.env.WRONGPORT_PORT);
  // `||` would coerce an explicit port 0 ("pick a free port") to the default.
  const port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 3_789);
  const host = options.host ?? process.env.WRONGPORT_HOST ?? '127.0.0.1';
  const app = createApp(config, options.webDistDir, { loopbackBound: isLoopbackHost(host) });
  const server = serve({ fetch: app.fetch, port, hostname: host });
  // `serve()` only returns the un-listened server: without waiting here, a
  // taken port surfaces as an uncaught 'error' event and crashes the CLI.
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      const message =
        err.code === 'EADDRINUSE'
          ? `port ${port} is already in use — stop the other process or pick another --port`
          : err.code === 'EACCES'
            ? `port ${port} needs elevated privileges — pick a port above 1024`
            : `could not bind ${host}:${port}: ${err.message}`;
      reject(new Error(message));
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
  // After listening, stray socket errors must not kill the whole process.
  server.on('error', () => {});
  // A port-0 bind gets an ephemeral port; report the one actually assigned.
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return { url: `http://${displayHost}:${boundPort}`, close: () => server.close() };
}
