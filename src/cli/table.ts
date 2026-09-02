import type { Snapshot } from '../core/types.js';

const ansi =
  (open: number, close: number) =>
  (text: string): string =>
    `\x1b[${open}m${text}\x1b[${close}m`;

export const bold = ansi(1, 22);
export const dim = ansi(2, 22);
export const cyan = ansi(36, 39);
export const green = ansi(32, 39);
export const yellow = ansi(33, 39);
export const red = ansi(31, 39);

const padEnd = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

const truncate = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;

export function renderTable(snapshot: Snapshot): void {
  const rows = snapshot.processes.map((proc) => ({
    pid: String(proc.pid),
    ports: proc.ports.map((entry) => entry.port).join(','),
    name: proc.name,
    command: proc.command,
    user: proc.user,
  }));

  if (rows.length === 0) {
    if (snapshot.scannedCount > 0) {
      console.log(
        dim(`Nothing matched the dev filter — ${snapshot.scannedCount} listening process(es) hidden. Use \`wrongport ls --all\`.`),
      );
    } else {
      console.log(dim('No listening TCP ports found.'));
    }
    return;
  }

  const columns = process.stdout.columns ?? 100;
  const wPid = Math.max(3, ...rows.map((row) => row.pid.length));
  const wPorts = Math.max(5, ...rows.map((row) => row.ports.length));
  const wName = Math.min(22, Math.max(4, ...rows.map((row) => row.name.length)));
  const wUser = Math.min(14, Math.max(4, ...rows.map((row) => row.user.length)));
  const wCmd = Math.max(12, columns - (wPid + wPorts + wName + wUser + 8));

  console.log(
    dim(
      `${padEnd('PID', wPid)}  ${padEnd('PORTS', wPorts)}  ${padEnd('NAME', wName)}  ${padEnd('COMMAND', wCmd)}  ${padEnd('USER', wUser)}`,
    ),
  );
  for (const row of rows) {
    console.log(
      `${bold(padEnd(row.pid, wPid))}  ${cyan(padEnd(row.ports, wPorts))}  ${padEnd(truncate(row.name, wName), wName)}  ${dim(padEnd(truncate(row.command, wCmd), wCmd))}  ${dim(padEnd(row.user, wUser))}`,
    );
  }
  console.log(
    dim(
      `\n${rows.length} process(es) · scanned ${snapshot.scannedCount} listening · ${new Date(snapshot.createdAt).toLocaleTimeString()}`,
    ),
  );
}
