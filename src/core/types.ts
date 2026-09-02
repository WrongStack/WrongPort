/** A single listening TCP socket owned by a process. */
export interface PortEntry {
  port: number;
  /** Raw lsof NAME, e.g. "*:3000" or "127.0.0.1:5432". */
  address: string;
}

/** A process with at least one listening TCP port. */
export interface DevProcess {
  pid: number;
  /** Short display name derived from the command, e.g. "node". */
  name: string;
  /** Full command line from ps. */
  command: string;
  user: string;
  ports: PortEntry[];
  /** True when the process matches the dev filter (config include/exclude). */
  matched: boolean;
}

export interface ScanOptions {
  /** Bypass the dev filter and include every listening process. */
  all?: boolean;
  /** Extra include regex sources, matched against "<name> <command>". */
  only?: string[];
  /** Restrict results to these ports. */
  ports?: number[];
}

export interface Snapshot {
  createdAt: number;
  platform: string;
  /** Processes selected by the current filter, sorted by first port. */
  processes: DevProcess[];
  /** How many listening processes existed before filtering. */
  scannedCount: number;
}
