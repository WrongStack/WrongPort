import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface WrongPortConfig {
  /**
   * Regex sources, matched case-insensitively against "<name> <command>".
   * When set, replaces the built-in dev-tool defaults.
   */
  include?: string[];
  /** Regex sources; a match removes the process from the filtered result. */
  exclude?: string[];
  /** Restrict scans to these ports. */
  ports?: number[];
}

export interface ResolvedConfig {
  includePatterns: RegExp[];
  excludePatterns: RegExp[];
  ports?: number[];
}

/**
 * Built-in dev-tool patterns. Word-anchored so e.g. "\bgo\b" does not match
 * "mongod" inside a longer command line.
 */
export const DEFAULT_INCLUDE: string[] = [
  '\\bnode\\b', '\\bnpm\\b', '\\bnpx\\b', '\\bpnpm\\b', '\\byarn\\b', '\\bbun\\b', '\\bbunx\\b',
  '\\bdeno\\b', '\\btsx\\b', '\\bts-node\\b', '\\bnodemon\\b', '\\bvite\\b', '\\bwebpack\\b',
  '\\besbuild\\b', '\\brspack\\b', '\\bturbopack\\b', '\\bturbo\\b', '\\bnext\\b', '\\bnuxt\\b',
  '\\bnest\\b', '\\bastro\\b', '\\bremix\\b', '\\bparcel\\b', '\\brollup\\b', '\\bserva\\b',
  '\\bhttp-server\\b', '\\bjson-server\\b', '\\bpython3?\\b', '\\buvicorn\\b', '\\bflask\\b',
  '\\bgunicorn\\b', '\\bdjango\\b', '\\bphp\\b', '\\bartisan\\b', '\\bruby\\b', '\\brails\\b',
  '\\bpuma\\b', '\\bjava\\b', '\\bgradle\\b', '\\bmaven\\b', '\\bspring\\b', '\\bdotnet\\b',
  '\\bcargo\\b', '\\bgo\\b', '\\bair\\b', '\\bmix\\b', '\\bpostgres\\b', '\\bmysql\\b',
  '\\bmongod\\b', '\\bredis-server\\b',
];

/** WrongPort never lists itself by default. */
export const DEFAULT_EXCLUDE: string[] = ['\\bwrongport\\b'];

/** First match wins; no merging across files. */
const CONFIG_FILES = ['wrongport.config.json', '.wrongportrc.json'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`"${field}" must be an array of strings`);
  }
  return value as string[];
}

export async function loadConfig(cwd: string = process.cwd()): Promise<WrongPortConfig> {
  const candidates = [
    ...CONFIG_FILES.map((file) => path.join(cwd, file)),
    path.join(os.homedir(), '.config', 'wrongport', 'config.json'),
  ];
  for (const file of candidates) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`${file} must contain a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.include !== undefined) assertStringArray(obj.include, 'include');
    if (obj.exclude !== undefined) assertStringArray(obj.exclude, 'exclude');
    if (obj.ports !== undefined) {
      const portsValid =
        Array.isArray(obj.ports) &&
        obj.ports.every((v) => Number.isInteger(v) && v >= 1 && v <= 65_535);
      if (!portsValid) {
        throw new ConfigError('"ports" must be an array of integers between 1 and 65535');
      }
    }
    return obj as WrongPortConfig;
  }
  return {};
}

function compile(source: string): RegExp {
  try {
    return new RegExp(source, 'i');
  } catch (err) {
    throw new ConfigError(`invalid pattern "${source}": ${(err as Error).message}`);
  }
}

export function resolveConfig(config: WrongPortConfig): ResolvedConfig {
  const include = config.include ?? DEFAULT_INCLUDE;
  const exclude = [...(config.exclude ?? []), ...DEFAULT_EXCLUDE];
  return {
    includePatterns: include.map(compile),
    excludePatterns: exclude.map(compile),
    ports: config.ports,
  };
}
