import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedConfig } from '../core/config.js';
import { compileOnlyPatterns, scanProcesses } from '../core/inspector.js';
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

export function createApp(config: ResolvedConfig, webDistDir?: string): Hono {
  const app = new Hono();
  let latest: { snapshot: Snapshot; at: number } | null = null;

  const scan = async (options: ScanOptions): Promise<Snapshot> => {
    const snapshot = await scanProcesses(config, options);
    latest = { snapshot, at: Date.now() };
    return snapshot;
  };

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
    const body = await c.req.json<{ pid?: unknown; force?: unknown }>().catch(() => undefined);
    const pid = Number(body?.pid);
    if (!body || !Number.isInteger(pid) || pid <= 0) {
      return c.json({ error: 'Body must be JSON: {"pid": number, "force"?: boolean}' }, 400);
    }
    // Safety rail: only pids that appeared in a recent scan may be killed —
    // this endpoint is not a generic remote kill switch.
    let known = false;
    if (latest && Date.now() - latest.at < SNAPSHOT_TTL_MS) {
      known = latest.snapshot.processes.some((proc) => proc.pid === pid);
    }
    if (!known) {
      known = (await scan({ all: true })).processes.some((proc) => proc.pid === pid);
    }
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
  const port = (options.port ?? Number(process.env.WRONGPORT_PORT)) || 3_789;
  const host = options.host ?? process.env.WRONGPORT_HOST ?? '127.0.0.1';
  const app = createApp(config, options.webDistDir);
  const server = serve({ fetch: app.fetch, port, hostname: host });
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return { url: `http://${displayHost}:${port}`, close: () => server.close() };
}
