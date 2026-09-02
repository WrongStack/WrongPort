import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../core/config.js';
import { ScanError } from '../core/inspector.js';
import type { ScanOptions, Snapshot } from '../core/types.js';
import { createApp, startServer } from './app.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const config = resolveConfig({});

/** Spawn a node process that does nothing until signaled; keeps the handle. */
function spawnSleeper(): Promise<{ child: ChildProcess; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    child.once('spawn', () => {
      if (typeof child.pid !== 'number') {
        reject(new Error('child pid missing'));
        return;
      }
      resolve({ child, pid: child.pid });
    });
    child.once('error', () => reject(new Error('failed to spawn child')));
  });
}

function waitExit(child: ChildProcess): Promise<void> {
  // A signal-killed child keeps exitCode === null (signalCode is set instead),
  // and its 'exit' event may already have fired — check both before subscribing.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function killRequest(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return app.request('/api/kill', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

interface FakeProc {
  pid: number;
  name: string;
  command: string;
  user: string;
  ports: { port: number; address: string }[];
  matched: boolean;
}

const procRow = (pid: number = 111, port = 45_946): FakeProc => ({
  pid,
  name: 'node',
  command: `node dev-server.js marker-${pid}`,
  user: 'ersin',
  ports: [{ port, address: `127.0.0.1:${port}` }],
  matched: true,
});

const fakeSnapshot = (processes: FakeProc[]): Snapshot => ({
  createdAt: Date.now(),
  platform: process.platform,
  processes,
  scannedCount: processes.length,
});

/**
 * createApp wired to an injectable scan double. The kill path stays real
 * (actual spawned process, actual signal); only the lsof/ps scan is faked,
 * which keeps these tests platform-independent (Windows has no lsof).
 */
function appWithScan(snapshot = fakeSnapshot([procRow()])) {
  const scans: ScanOptions[] = [];
  const app = createApp(config, undefined, {
    scan: async (_config, options = {}) => {
      scans.push(options);
      const ports = options.ports;
      const visible =
        ports !== undefined && ports.length > 0
          ? snapshot.processes.filter((proc) => proc.ports.some((entry) => ports.includes(entry.port)))
          : snapshot.processes;
      return { ...snapshot, processes: visible };
    },
  });
  return { app, scans };
}

describe('POST /api/kill safety rails', () => {
  it('health responds ok (sanity)', async () => {
    const app = createApp(config);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('rejects malformed bodies with 400 before touching any process', async () => {
    const app = createApp(config);
    for (const body of [undefined, {}, { pid: 'abc' }, { pid: -3 }, { pid: 0 }, { pid: 1 }]) {
      const res = await app.request('/api/kill', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns 409 for a pid that appears in no scan', async () => {
    const app = createApp(config);
    const res = await killRequest(app, { pid: 999_999_999 });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/was not in the latest scan/);
  });

  it('kills a pid from the snapshot and returns 409 for the repeat', async () => {
    const { child, pid } = await spawnSleeper();
    try {
      const { app } = appWithScan(fakeSnapshot([procRow(pid)]));
      const list = await app.request('/api/processes');
      expect(list.status).toBe(200);
      const snapshot = (await list.json()) as { processes: { pid: number }[] };
      expect(snapshot.processes.map((proc) => proc.pid)).toContain(pid);

      const res = await killRequest(app, { pid });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { pid: number; signal: string; exited: boolean };
      expect(result).toMatchObject({ pid, signal: 'SIGTERM', exited: true });
      await waitExit(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

      // The kill invalidates the snapshot; a repeat must not be authorized.
      const repeat = await killRequest(app, { pid });
      expect(repeat.status).toBe(409);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('refuses to kill the server process itself via the self-pid guard', async () => {
    const { app } = appWithScan(fakeSnapshot([procRow(process.pid)]));
    await app.request('/api/processes?all=1'); // seed latest with the snapshot
    const res = await killRequest(app, { pid: process.pid });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/Refusing to kill the WrongPort process itself/);
  });

  it('returns 404 when the process vanished after the snapshot', async () => {
    const { child, pid } = await spawnSleeper();
    try {
      // The pid was seen in a scan, but died before the kill arrived.
      child.kill('SIGKILL');
      await waitExit(child);
      const { app } = appWithScan(fakeSnapshot([procRow(pid)]));
      await app.request('/api/processes'); // seed latest with the stale pid
      const res = await killRequest(app, { pid });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain(
        `No process with pid ${pid}`,
      );
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('returns snapshot metadata from /api/processes', async () => {
    const { app } = appWithScan(fakeSnapshot([procRow(1)]));
    const res = await app.request('/api/processes?all=1');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      createdAt: number;
      platform: string;
      processes: unknown[];
      scannedCount: number;
    };
    expect(typeof data.createdAt).toBe('number');
    expect(data.platform).toBe(process.platform);
    expect(data.processes).toHaveLength(1);
    expect(data.scannedCount).toBe(1);
  });
});

interface SnapshotRow {
  pid: number;
  ports: { port: number }[];
}

interface SnapshotLike {
  processes: SnapshotRow[];
}

describe('GET /api/processes query parameters', () => {
  it('forwards ports= to the scanner and narrows the snapshot', async () => {
    const { app, scans } = appWithScan(fakeSnapshot([procRow(11, 45_947)]));
    const res = await app.request('/api/processes?ports=45947');
    expect(res.status).toBe(200);
    expect(scans[0]?.ports).toEqual([45_947]);
    const snapshot = (await res.json()) as SnapshotLike;
    expect(snapshot.processes).toHaveLength(1);
    expect(snapshot.processes[0]?.ports[0]?.port).toBe(45_947);
  });

  it('drops invalid ports tokens instead of failing', async () => {
    const { app, scans } = appWithScan(fakeSnapshot([]));
    const res = await app.request('/api/processes?ports=not-a-port,45948');
    expect(res.status).toBe(200);
    expect(scans[0]?.ports).toEqual([45_948]);
    expect(((await res.json()) as SnapshotLike).processes).toEqual([]);
  });

  it('maps an empty ports= list to the (impossible) port 0', async () => {
    const { app, scans } = appWithScan(fakeSnapshot([procRow(12)]));
    const res = await app.request('/api/processes?ports=');
    expect(res.status).toBe(200);
    // Pre-existing quirk: Number('') === 0 passes the integer filter, so the
    // empty query narrows to port 0, which nothing can own.
    expect(scans[0]?.ports).toEqual([0]);
    expect(((await res.json()) as SnapshotLike).processes).toEqual([]);
  });

  it('forwards only= to the scanner in filtered and all modes', async () => {
    const { app, scans } = appWithScan(fakeSnapshot([procRow(13)]));
    const filtered = await app.request(`/api/processes?only=${encodeURIComponent('\\bnc\\b')}`);
    expect(filtered.status).toBe(200);
    expect(scans[0]?.only).toEqual(['\\bnc\\b']);
    expect(scans[0]?.all).toBe(false);
    const all = await app.request(`/api/processes?all=1&only=${encodeURIComponent('\\bnc\\b')}`);
    expect(all.status).toBe(200);
    expect(scans[1]?.all).toBe(true);
    expect(scans[1]?.only).toEqual(['\\bnc\\b']);
  });

  it('gives ports= precedence over only= matches (hard constraint)', async () => {
    // The only= match listens on port 45950 but the query demands 45951.
    const { app, scans } = appWithScan(fakeSnapshot([procRow(14, 45_950)]));
    const res = await app.request(`/api/processes?all=1&only=marker&ports=45951`);
    expect(res.status).toBe(200);
    expect(scans[0]).toMatchObject({ all: true, only: ['marker'], ports: [45_951] });
    expect(((await res.json()) as SnapshotLike).processes).toEqual([]);
  });

  it('never authorizes a kill without a prior snapshot (no fallback scan)', async () => {
    const app = createApp(config);
    const { child, pid } = await spawnSleeper();
    try {
      // No GET /api/processes first: the listener has never been listed.
      const res = await killRequest(app, { pid });
      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/was not in the latest scan/);
      // The target must still be alive — unlisted pids may not be killed.
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('returns 400 with a helpful message for an invalid only= regex', async () => {
    const app = createApp(config);
    const res = await app.request(`/api/processes?only=${encodeURIComponent('[')}`);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    // Exactly the string the web UI surfaces in its error banner via raise().
    expect(data.error).toMatch(/invalid only pattern "\["/);
  });
});

describe('POST /api/kill request hardening', () => {
  it('rejects non-JSON content types with 415 (cross-site form drive-by protection)', async () => {
    const app = createApp(config);
    const res = await app.request('/api/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ pid: 1234 }),
    });
    expect(res.status).toBe(415);
  });

  it('rejects kill requests that carry no content type at all', async () => {
    const app = createApp(config);
    // No body and no headers: undici would auto-add a content type for a
    // string body, so this request goes out truly header-less.
    const res = await app.request('/api/kill', { method: 'POST' });
    expect(res.status).toBe(415);
  });

  it('rejects a non-loopback Host header while loopback-bound (DNS rebinding guard)', async () => {
    const app = createApp(config);
    const res = await app.request('/api/health', { headers: { host: 'attacker.example' } });
    expect(res.status).toBe(403);
  });

  it('allows loopback Host headers with a port suffix', async () => {
    const app = createApp(config);
    const res = await app.request('/api/health', { headers: { host: 'localhost:3789' } });
    expect(res.status).toBe(200);
  });

  it('accepts non-loopback Host headers only when loopbackBound is disabled', async () => {
    const app = createApp(config, undefined, { loopbackBound: false });
    const health = await app.request('/api/health', { headers: { host: 'attacker.example' } });
    expect(health.status).toBe(200);
    // Past the host guard, the normal snapshot rail still applies.
    const kill = await killRequest(app, { pid: 999_999_999 });
    expect(kill.status).toBe(409);
  });
});

describe('scan failure mapping', () => {
  it('maps ScanError to 503 with the underlying message', async () => {
    const app = createApp(config, undefined, {
      scan: async () => {
        throw new ScanError('`lsof` was not found on PATH.');
      },
    });
    const res = await app.request('/api/processes');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: '`lsof` was not found on PATH.' });
  });

  it('maps unexpected scan errors to 500 JSON', async () => {
    const app = createApp(config, undefined, {
      scan: async () => {
        throw new Error('kaboom');
      },
    });
    const res = await app.request('/api/processes');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'kaboom' });
  });
});

describe('static web UI serving', () => {
  let webRoot: string;

  const uiApp = (): ReturnType<typeof createApp> => createApp(config, webRoot);

  afterEach(async () => {
    if (webRoot !== undefined) {
      await rm(webRoot, { recursive: true, force: true });
      webRoot = undefined as unknown as string;
    }
  });

  it('serves index.html at / with no-cache', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    const res = await uiApp().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('app-shell');
  });

  it('serves assets with immutable caching and known mime types', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    await writeFile(path.join(webRoot, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(path.join(webRoot, 'logo.png'), 'png-bytes');
    await writeFile(path.join(webRoot, 'data.yml'), 'yaml: yes');

    const script = await uiApp().request('/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toContain('immutable');

    const png = await uiApp().request('/logo.png');
    expect(png.headers.get('content-type')).toBe('image/png');

    // Unknown extension falls back to the octet-stream default.
    const yml = await uiApp().request('/data.yml');
    expect(yml.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('falls back to the app shell for unknown paths (SPA routing)', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    const res = await uiApp().request('/some/spa/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('app-shell');
  });

  it('treats a path that resolves to the web root itself as the shell', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    const res = await uiApp().request('/.');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('app-shell');
  });

  it('returns 404 with guidance when the shell itself is missing', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    const res = await uiApp().request('/nothing');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Web UI build not found');
  });

  it('serves the shell for directory paths with a trailing slash', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await mkdir(path.join(webRoot, 'sub'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    await writeFile(path.join(webRoot, 'sub', 'nested.txt'), 'nested');
    const res = await uiApp().request('/sub/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('app-shell');
  });

  it('blocks path traversal outside the web root', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    const res = await uiApp().request('/..%2f..%2fsecret.txt');
    expect(res.status).toBe(403);
  });

  it('rejects undecodable percent-escapes and NUL bytes', async () => {
    webRoot = await mkdtemp(path.join(tmpdir(), 'wrongport-web-'));
    await writeFile(path.join(webRoot, 'index.html'), '<html>app-shell</html>');
    const badEscape = await uiApp().request('/%E0%A4%A');
    expect(badEscape.status).toBe(400);
    const nul = await uiApp().request('/a%00b');
    expect(nul.status).toBe(400);
  });
});

describe('startServer environment and display handling', () => {
  it('honors WRONGPORT_PORT and WRONGPORT_HOST when no options are given', async () => {
    vi.stubEnv('WRONGPORT_PORT', '40017');
    vi.stubEnv('WRONGPORT_HOST', '127.0.0.1');
    try {
      const started = await startServer({}, config);
      try {
        expect(started.url).toBe('http://127.0.0.1:40017');
      } finally {
        started.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defaults the bind to loopback when neither options nor env say otherwise', async () => {
    const started = await startServer({ port: 45_996 }, config);
    try {
      expect(started.url).toBe('http://127.0.0.1:45996');
    } finally {
      started.close();
    }
  });

  it('treats a non-positive WRONGPORT_PORT as unset', async (ctx) => {
    vi.stubEnv('WRONGPORT_PORT', '0');
    try {
      // A running WrongPort serve (or any service) on the default port would
      // fail this bind through no fault of the fallback logic — probe first
      // and skip when 3789 is taken (CI always has it free).
      const defaultPortFree = await new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once('error', () => resolve(false));
        probe.listen(3789, '127.0.0.1', () => probe.close(() => resolve(true)));
      });
      if (!defaultPortFree) return ctx.skip();
      const started = await startServer({ host: '127.0.0.1' }, config);
      try {
        expect(started.url).toBe('http://127.0.0.1:3789');
      } finally {
        started.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('displays localhost for wildcard IPv4 binds', async () => {
    const started = await startServer({ port: 0, host: '0.0.0.0' }, config);
    try {
      expect(started.url).toMatch(/^http:\/\/localhost:\d+$/);
    } finally {
      started.close();
    }
  });

  it('rejects with a friendly message when the port is already in use', async () => {
    const { createServer } = await import('node:http');
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('no bound port');
    try {
      await expect(startServer({ port: address.port, host: '127.0.0.1' }, config)).rejects.toThrow(
        /already in use/,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('starts on a port-0 bind, reports the assigned port, and closes cleanly', async () => {
    const started = await startServer({ port: 0, host: '127.0.0.1' }, config);
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(started.url.endsWith(':0')).toBe(false);
    } finally {
      started.close();
    }
  });
});
