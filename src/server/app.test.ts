import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../core/config.js';
import { createApp } from './app.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const config = resolveConfig({});

/** Marker baked into spawned listeners' command lines for only= matching. */
const TOKEN = 'zebraDev42';

const LISTENER_SCRIPT =
  "(async()=>{const zebraDev42=1;const http=await import('node:http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(%%PORT%%,'127.0.0.1',()=>console.log('READY'));})();";

/** Spawn a node http listener on the given port (0 = ephemeral); resolves once it has spawned. */
function spawnListener(port = 0): Promise<{ child: ChildProcess; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', LISTENER_SCRIPT.replace('%%PORT%%', String(port))], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => reject(new Error('listener did not spawn within 5s')), 5_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`listener exited before READY (code ${code})`));
    });
    child.once('spawn', () => {
      clearTimeout(timer);
      if (typeof child.pid !== 'number') {
        reject(new Error('child pid missing'));
        return;
      }
      resolve({ child, pid: child.pid });
    });
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

describe('POST /api/kill safety rails', () => {
  it('health responds ok (sanity)', async () => {
    const app = createApp(config);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('rejects malformed bodies with 400 before touching any process', async () => {
    const app = createApp(config);
    for (const body of [undefined, {}, { pid: 'abc' }, { pid: -3 }]) {
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
    const app = createApp(config);
    const { child, pid } = await spawnListener();
    try {
      // Wait until the spawned listener is visible in the scan (port bound + lsof saw it).
      let visible = false;
      for (let i = 0; i < 30 && !visible; i++) {
        const list = await app.request('/api/processes');
        expect(list.status).toBe(200);
        const snapshot = (await list.json()) as { processes: { pid: number }[] };
        visible = snapshot.processes.some((proc) => proc.pid === pid);
        if (!visible) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(visible, 'spawned listener never appeared in the scan').toBe(true);

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
    const app = createApp(config);
    // The test runner only appears in scans while it owns a LISTENING port.
    const listener: Server = createServer(() => {});
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    try {
      await app.request('/api/processes?all=1'); // seed latest with every listener
      const res = await killRequest(app, { pid: process.pid });
      expect(res.status).toBe(500);
      const data = (await res.json()) as { error: string };
      expect(data.error).toMatch(/Refusing to kill the WrongPort process itself/);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it('returns snapshot metadata from /api/processes', async () => {
    const app = createApp(config);
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
    expect(Array.isArray(data.processes)).toBe(true);
    expect(data.scannedCount).toBeGreaterThanOrEqual(data.processes.length);
  });
});

interface SnapshotRow {
  pid: number;
  name: string;
  matched: boolean;
  ports: { port: number }[];
}

interface SnapshotLike {
  processes: SnapshotRow[];
}

describe('GET /api/processes query parameters', () => {
  it('ports=<bound port> narrows the snapshot to processes owning that port', async () => {
    const app = createApp(config);
    const port = 45_941;
    const { child, pid } = await spawnListener(port);
    try {
      let snapshot: SnapshotLike | undefined;
      let visible = false;
      for (let i = 0; i < 30 && !visible; i++) {
        const res = await app.request(`/api/processes?ports=${port}`);
        expect(res.status).toBe(200);
        snapshot = (await res.json()) as SnapshotLike;
        visible = snapshot.processes.some((proc) => proc.pid === pid);
        if (!visible) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(visible, 'listener never appeared for its own port').toBe(true);
      // Bind exclusivity: exactly one process can own the requested port.
      expect(snapshot?.processes).toHaveLength(1);
      expect(snapshot?.processes[0]?.pid).toBe(pid);
      expect(snapshot?.processes[0]?.ports[0]?.port).toBe(port);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('drops invalid ports tokens instead of failing', async () => {
    const app = createApp(config);
    const res = await app.request('/api/processes?ports=not-a-port,45942');
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as SnapshotLike;
    // 45942 has no listener; the junk token is filtered out during parsing.
    expect(snapshot.processes).toEqual([]);
  });

  it('only= adds include patterns on top of the defaults and reveals non-dev listeners', async () => {
    if (!existsSync('/usr/bin/nc')) return; // quietly skip where nc is unavailable
    const app = createApp(config);
    const nc = spawn('/usr/bin/nc', ['-l', '45943'], { stdio: 'ignore' });
    try {
      let revealed = false;
      for (let i = 0; i < 30 && !revealed; i++) {
        const res = await app.request(`/api/processes?only=${encodeURIComponent('\\bnc\\b')}`);
        expect(res.status).toBe(200);
        const snapshot = (await res.json()) as SnapshotLike;
        revealed = snapshot.processes.some((proc) => proc.name === 'nc');
        if (!revealed) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(revealed, 'nc never appeared with only=\\bnc\\b').toBe(true);

      // Without only=, the default dev filter hides it.
      const plain = await app.request('/api/processes');
      const plainSnapshot = (await plain.json()) as SnapshotLike;
      expect(plainSnapshot.processes.some((proc) => proc.name === 'nc')).toBe(false);

      // matched reflects the effective pattern set: hits with the extra
      // pattern, misses without it — nc matches no default pattern.
      const hit = await app.request(`/api/processes?all=1&only=${encodeURIComponent('\\bnc\\b')}`);
      const hitSnapshot = (await hit.json()) as SnapshotLike;
      expect(hitSnapshot.processes.find((proc) => proc.name === 'nc')?.matched).toBe(true);
      const miss = await app.request(`/api/processes?all=1&only=${encodeURIComponent('noSuchToken123')}`);
      const missSnapshot = (await miss.json()) as SnapshotLike;
      // all=1 + only= narrows to rows matching the extra pattern, so the miss
      // scan returns nothing at all — nc cannot be in it.
      expect(missSnapshot.processes.some((proc) => proc.name === 'nc')).toBe(false);
    } finally {
      nc.kill('SIGKILL');
    }
  });

  it('ports= narrows even in all=1 scans', async () => {
    const app = createApp(config);
    const port = 45_944;
    const { child, pid } = await spawnListener(port);
    try {
      let narrowed = false;
      for (let i = 0; i < 30 && !narrowed; i++) {
        const res = await app.request(`/api/processes?all=1&ports=${port}`);
        expect(res.status).toBe(200);
        const snapshot = (await res.json()) as SnapshotLike;
        narrowed = snapshot.processes.length === 1 && snapshot.processes[0]?.pid === pid;
        if (!narrowed) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      expect(narrowed, 'all=1 scan was not narrowed by ports=').toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('ports= is a hard constraint that wins over only= matches', async () => {
    const app = createApp(config);
    const { child, pid } = await spawnListener();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The child matches only=TOKEN but listens on the wrong port: the port
      // constraint must exclude it regardless of the pattern hit.
      const res = await app.request(
        `/api/processes?all=1&only=${encodeURIComponent(TOKEN)}&ports=45945`,
      );
      expect(res.status).toBe(200);
      const snapshot = (await res.json()) as SnapshotLike;
      expect(snapshot.processes.some((proc) => proc.pid === pid)).toBe(false);
      expect(snapshot.processes).toEqual([]);
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
