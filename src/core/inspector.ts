import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResolvedConfig } from './config.js';
import type { DevProcess, PortEntry, ScanOptions, Snapshot } from './types.js';

const execFileAsync = promisify(execFile);

const LSOF_ARGS = ['-w', '-nP', '-iTCP', '-sTCP:LISTEN'];
const PS_ARGS = ['-axo', 'pid=,user=,command='];
const MAX_BUFFER = 16 * 1024 * 1024;
/** Hard ceiling per subprocess; a hung lsof/ps must surface as ScanError, not block forever. */
const EXEC_TIMEOUT_MS = 5_000;

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}

/** Compile user-supplied only= patterns, mapping syntax errors to ScanError. */
export function compileOnlyPatterns(sources: string[]): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (err) {
      throw new ScanError(`invalid only pattern "${source}": ${(err as Error).message}`);
    }
  });
}

export interface ListenRow {
  pid: number;
  name: string;
  user: string;
  entry: PortEntry;
}

export interface ProcessInfo {
  name: string;
  command: string;
  user: string;
}

function exitCodeOf(err: unknown): string | number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: string | number }).code;
  }
  return undefined;
}

/** Parse raw `lsof -nP -iTCP -sTCP:LISTEN` text output, header row included. */
export function parseLsofOutput(stdout: string): ListenRow[] {
  const rows: ListenRow[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    // NAME looks like "*:3000 (LISTEN)" or "127.0.0.1:5432 (LISTEN)".
    const raw = cols.slice(8).join(' ');
    const match = /:(\d+)(?:\s+\([^)]*\))?$/.exec(raw);
    if (!match) continue;
    const port = Number(match[1]);
    const pid = Number(cols[1]);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      name: cols[0] as string,
      user: cols[2] as string,
      entry: { port, address: raw.replace(/\s+\([^)]*\)$/, '') },
    });
  }
  return rows;
}

async function readListeningSockets(): Promise<ListenRow[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('lsof', LSOF_ARGS, { maxBuffer: MAX_BUFFER, timeout: EXEC_TIMEOUT_MS }));
  } catch (err) {
    const code = exitCodeOf(err);
    if (code === 'ENOENT') {
      throw new ScanError('`lsof` was not found on PATH. macOS ships it; on Linux install the "lsof" package.');
    }
    // lsof exits with status 1 when nothing matches — that is an empty result, not an error.
    if (code === 1) return [];
    throw new ScanError(`lsof failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseLsofOutput(stdout);
}

async function readProcessInfos(): Promise<Map<number, ProcessInfo>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', PS_ARGS, { maxBuffer: MAX_BUFFER, timeout: EXEC_TIMEOUT_MS }));
  } catch (err) {
    const code = exitCodeOf(err);
    if (code === 'ENOENT') {
      throw new ScanError('`ps` was not found on PATH.');
    }
    throw new ScanError(`ps failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const map = new Map<number, ProcessInfo>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pidEnd = trimmed.indexOf(' ');
    if (pidEnd === -1) continue;
    const pid = Number(trimmed.slice(0, pidEnd));
    if (!Number.isInteger(pid)) continue;
    const rest = trimmed.slice(pidEnd + 1).trimStart();
    const userEnd = rest.indexOf(' ');
    if (userEnd === -1) continue;
    const user = rest.slice(0, userEnd);
    // trim() removed any trailing whitespace, so a line that still has a user
    // separator always carries a non-empty command here.
    const command = rest.slice(userEnd + 1).trimStart();
    map.set(pid, { name: displayBaseName(command), command, user });
  }
  return map;
}

function displayBaseName(command: string): string {
  // split(limit) always yields a first element and split('/') of a non-empty
  // string always has a last one — plain indexing, no fallback branches.
  const first = command.split(/\s+/, 1)[0] as string;
  const parts = first.split('/');
  return parts[parts.length - 1] as string;
}

function matches(
  proc: DevProcess,
  config: ResolvedConfig,
  includePatterns: RegExp[],
  ports?: number[],
): boolean {
  if (ports && ports.length > 0 && !proc.ports.some((entry) => ports.includes(entry.port))) {
    return false;
  }
  const haystack = `${proc.name} ${proc.command}`;
  if (includePatterns.length > 0 && !includePatterns.some((re) => re.test(haystack))) return false;
  return !config.excludePatterns.some((re) => re.test(haystack));
}

/**
 * Join raw listening rows with process information. When `ps` missed a pid
 * that lsof still saw (the process exited mid-scan, or the two calls raced),
 * fall back to lsof's own COMMAND/USER columns so the row still shows up
 * instead of being silently dropped.
 */
export function joinListenRows(rows: ListenRow[], infos: Map<number, ProcessInfo>): DevProcess[] {
  const byPid = new Map<number, DevProcess>();
  for (const row of rows) {
    const info = infos.get(row.pid);
    const name = info?.name ?? row.name;
    const command = info?.command ?? row.name;
    const user = info?.user ?? row.user;
    let proc = byPid.get(row.pid);
    if (!proc) {
      proc = { pid: row.pid, name, command, user, ports: [], matched: false };
      byPid.set(row.pid, proc);
    }
    if (!proc.ports.some((e) => e.port === row.entry.port && e.address === row.entry.address)) {
      proc.ports.push(row.entry);
    }
  }
  const all = [...byPid.values()];
  for (const proc of all) {
    proc.ports.sort((a, b) => a.port - b.port);
  }
  return all;
}

/**
 * Scan listening TCP ports and join them with full process information.
 * One `lsof` call and one `ps` call per scan.
 */
export async function scanProcesses(
  config: ResolvedConfig,
  options: ScanOptions = {},
): Promise<Snapshot> {
  const [rows, infos] = await Promise.all([readListeningSockets(), readProcessInfos()]);
  const all = joinListenRows(rows, infos);

  const ports = options.ports ?? config.ports;
  const extraInclude = compileOnlyPatterns(options.only ?? []);

  for (const proc of all) {
    proc.matched = matches(proc, config, [...config.includePatterns, ...extraInclude], ports);
  }

  // Selection semantics: ports= is a hard constraint in every mode (including
  // --all scans); only= is additive over the defaults for filtered scans and
  // narrows --all scans when explicitly provided.
  const selected = all.filter((proc) => {
    if (ports && ports.length > 0 && !proc.ports.some((entry) => ports.includes(entry.port))) {
      return false;
    }
    if (options.all) {
      return extraInclude.length === 0 || extraInclude.some((re) => re.test(`${proc.name} ${proc.command}`));
    }
    return proc.matched;
  });
  // Every joined process owns at least one port, so plain indexing is safe.
  selected.sort((a, b) => a.ports[0]!.port - b.ports[0]!.port || a.pid - b.pid);

  return { createdAt: Date.now(), platform: process.platform, processes: selected, scannedCount: all.length };
}
