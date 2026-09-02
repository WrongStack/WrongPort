export interface PortEntry {
  port: number;
  address: string;
}

export interface DevProcess {
  pid: number;
  name: string;
  command: string;
  user: string;
  ports: PortEntry[];
  matched: boolean;
}

export interface Snapshot {
  createdAt: number;
  platform: string;
  processes: DevProcess[];
  scannedCount: number;
}
