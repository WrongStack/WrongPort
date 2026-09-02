#!/usr/bin/env node
import { Command } from 'commander';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfig } from '../core/config.js';
import { scanProcesses } from '../core/inspector.js';
import { killProcess, ProcessNotFoundError } from '../core/kill.js';
import type { ScanOptions, Snapshot } from '../core/types.js';
import { startServer } from '../server/app.js';
import { bold, cyan, dim, green, red, renderTable, yellow } from './table.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(here, '../../web-dist');

interface ListOptions {
  all?: boolean;
  json?: boolean;
  only?: string;
  ports?: string;
  watch?: string | boolean;
}

interface KillOptions {
  force?: boolean;
  yes?: boolean;
  all?: boolean;
}

interface ServeOptions {
  port?: string;
  host?: string;
  open?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const splitList = (value?: string): string[] | undefined =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const splitPorts = (value?: string): number[] | undefined => {
  if (value === undefined) return undefined;
  const ports: number[] = [];
  for (const token of value.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      // An empty or bogus list would silently disable the port constraint.
      throw new Error(`invalid port "${trimmed}" — --ports expects comma-separated integers 1–65535`);
    }
    ports.push(port);
  }
  if (ports.length === 0) {
    // An empty --ports list must error, not silently disable the constraint.
    throw new Error('empty --ports list — expected comma-separated integers 1–65535');
  }
  return ports;
};

async function scanFromOptions(options: ListOptions): Promise<Snapshot> {
  const resolved = resolveConfig(await loadConfig());
  const scanOptions: ScanOptions = {
    all: options.all,
    only: splitList(options.only),
    ports: splitPorts(options.ports),
  };
  return scanProcesses(resolved, scanOptions);
}

async function runList(options: ListOptions): Promise<void> {
  const snapshot = await scanFromOptions(options);
  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  renderTable(snapshot);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function fail(err: unknown): void {
  console.error(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
}

function openBrowser(url: string): void {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const command = isMac ? 'open' : isWindows ? 'cmd' : 'xdg-open';
  const args = isWindows ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' })
      .on('error', () => console.error(yellow('! Could not open a browser automatically.')))
      .unref();
  } catch {
    console.error(yellow('! Could not open a browser automatically.'));
  }
}

const program = new Command();

program
  .name('wrongport')
  .description('See which dev processes own which ports — list, watch, kill. Web UI: `wrongport serve`.')
  .version('0.2.0');

program
  .action(async () => {
    // Bare `wrongport` behaves like `wrongport ls`.
    try {
      await runList({});
    } catch (err) {
      fail(err);
    }
  });

program
  .command('ls')
  .description('List dev processes with listening TCP ports')
  .option('-a, --all', 'include every listening process, not just known dev tools')
  .option('--only <patterns>', 'extra include patterns, comma-separated regex', undefined)
  .option('--ports <ports>', 'restrict to these ports, comma-separated', undefined)
  .option('--json', 'print the raw JSON snapshot')
  .option('-w, --watch [seconds]', 'refresh continuously (default 3s)')
  .action(async (options: ListOptions) => {
    try {
      if (options.watch !== undefined) {
        const seconds = typeof options.watch === 'string' ? Number(options.watch) || 3 : 3;
        let consecutiveFailures = 0;
        for (;;) {
          console.clear();
          try {
            await runList(options);
            consecutiveFailures = 0;
            // Recovered from an earlier transient failure: leave no stale error code.
            process.exitCode = 0;
          } catch (err) {
            // A transient scan failure (timeout, busy machine) must not kill
            // the monitoring loop; bail out only on a persistent streak.
            fail(err);
            consecutiveFailures += 1;
            if (consecutiveFailures >= 5) {
              console.error(red('✗ scan failed 5 times in a row — stopping watch mode.'));
              process.exitCode = 1;
              return;
            }
          }
          console.log(dim(`\nRefreshing every ${seconds}s — press Ctrl+C to exit`));
          await sleep(seconds * 1000);
        }
      }
      await runList(options);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('kill')
  .description('Kill a dev process by PID or port')
  .argument('<target>', 'PID or local port number')
  .option('-f, --force', 'send SIGKILL instead of SIGTERM')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('-a, --all', 'consider every listening process, not only dev-filtered ones')
  .action(async (target: string, options: KillOptions) => {
    try {
      const snapshot = await scanFromOptions(options);
      const pid = Number(target);
      const proc = Number.isInteger(pid)
        ? (snapshot.processes.find((p) => p.pid === pid) ??
          snapshot.processes.find((p) => p.ports.some((entry) => entry.port === pid)))
        : undefined;
      if (!proc) {
        console.error(
          red(`✗ ${target} matched no ${options.all ? '' : 'dev-filtered '}process in the latest scan.`) +
            dim(' Try `wrongport ls --all` or check the port.'),
        );
        process.exitCode = 1;
        return;
      }
      const ports = proc.ports.map((entry) => entry.port).join(', ');
      if (!options.yes) {
        const scope = options.all ? 'non-dev process' : 'dev process';
        const answer = await prompt(
          `Kill ${bold(proc.name)} (pid ${proc.pid}, port${proc.ports.length === 1 ? '' : 's'} ${cyan(ports)}, ${scope})? [y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log(dim('Aborted.'));
          return;
        }
      }
      const result = await killProcess(proc.pid, { force: options.force });
      if (result.exited) {
        console.log(green(`✓ ${proc.name} (pid ${proc.pid}) exited after ${result.signal}`));
      } else {
        console.log(yellow(`~ ${result.signal} sent to ${proc.name} (pid ${proc.pid}); still shutting down`));
      }
    } catch (err) {
      if (err instanceof ProcessNotFoundError) {
        console.error(red(`✗ ${err.message}`));
        process.exitCode = 1;
        return;
      }
      fail(err);
    }
  });

program
  .command('serve')
  .description('Serve the WrongPort web UI + API')
  .option('-p, --port <port>', `HTTP port (default $WRONGPORT_PORT or 3789)`)
  .option('-H, --host <host>', `bind address (default $WRONGPORT_HOST or 127.0.0.1)`)
  .option('-o, --open', 'open the UI in a browser')
  .action(async (options: ServeOptions) => {
    try {
      const uiExists = await stat(webDistDir).then(
        () => true,
        () => false,
      );
      if (!uiExists) {
        console.error(
          yellow(`! Web UI build not found at ${webDistDir} — run \`npm run build\`. Serving the API only.`),
        );
      }
      const resolved = resolveConfig(await loadConfig());
      const { url } = await startServer(
        {
          port: options.port !== undefined ? Number(options.port) : undefined,
          host: options.host,
          webDistDir: uiExists ? webDistDir : undefined,
        },
        resolved,
      );
      console.log(green(`✓ WrongPort is listening → ${url}`));
      if (options.open) openBrowser(url);
      console.log(dim('Press Ctrl+C to stop.'));
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
