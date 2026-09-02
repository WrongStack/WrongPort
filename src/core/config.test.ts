import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveConfig } from './config.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wrongport-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadConfig', () => {
  it('returns an empty config when no config file exists', async () => {
    const dir = await makeTempDir();
    await expect(loadConfig(dir)).resolves.toEqual({});
  });

  it('reads wrongport.config.json from the given cwd', async () => {
    const dir = await makeTempDir();
    await writeFile(
      path.join(dir, 'wrongport.config.json'),
      JSON.stringify({ include: ['\\bvite\\b'], ports: [3000] }),
    );
    await expect(loadConfig(dir)).resolves.toEqual({ include: ['\\bvite\\b'], ports: [3000] });
  });

  it('falls back to .wrongportrc.json', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, '.wrongportrc.json'), JSON.stringify({ exclude: ['\\bx\\b'] }));
    await expect(loadConfig(dir)).resolves.toEqual({ exclude: ['\\bx\\b'] });
  });

  it('rejects a config file whose root is not a JSON object', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'wrongport.config.json'), JSON.stringify([1, 2, 3]));
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
    await expect(loadConfig(dir)).rejects.toThrow(/must contain a JSON object/);
  });

  it('prefers wrongport.config.json over .wrongportrc.json', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'wrongport.config.json'), JSON.stringify({ include: ['\\ba\\b'] }));
    await writeFile(path.join(dir, '.wrongportrc.json'), JSON.stringify({ include: ['\\bb\\b'] }));
    await expect(loadConfig(dir)).resolves.toEqual({ include: ['\\ba\\b'] });
  });

  it('rejects invalid JSON with a ConfigError', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'wrongport.config.json'), '{ not json');
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects non-string include entries', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'wrongport.config.json'), JSON.stringify({ include: [1] }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects non-integer ports', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'wrongport.config.json'), JSON.stringify({ ports: [3000.5] }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects out-of-range ports (a typo must not silently disable the port filter)', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'wrongport.config.json'), JSON.stringify({ ports: [0, 70_000, -5] }));
    await expect(loadConfig(dir)).rejects.toThrow(/between 1 and 65535/);
  });
});

describe('resolveConfig', () => {
  it('defaults match known dev tools and not arbitrary processes', () => {
    const config = resolveConfig({});
    expect(config.includePatterns.some((re) => re.test('node vite.js'))).toBe(true);
    expect(config.includePatterns.some((re) => re.test('python3 -m http.server'))).toBe(true);
    // mongo is deliberately included as a common local dev server.
    expect(config.includePatterns.some((re) => re.test('mongod --dbpath x'))).toBe(true);
    expect(config.includePatterns.some((re) => re.test('docker compose up'))).toBe(false);
    // "\bgo\b" must not match inside "mongod".
    expect(config.includePatterns.some((re) => re.test('mongorestore --dump'))).toBe(false);
  });

  it('always excludes WrongPort itself, even with a custom include', () => {
    const config = resolveConfig({ include: ['\\bnode\\b'] });
    expect(config.excludePatterns.some((re) => re.test('node /opt/wrongport/dist/cli/index.js serve'))).toBe(true);
  });

  it('merges custom exclude entries with the default one', () => {
    const config = resolveConfig({ exclude: ['\\bDevin\\b'] });
    expect(config.excludePatterns.some((re) => re.test('Devin Helper'))).toBe(true);
    expect(config.excludePatterns.some((re) => re.test('node /opt/wrongport serve'))).toBe(true);
  });

  it('a custom include replaces the defaults', () => {
    const config = resolveConfig({ include: ['\\bvite\\b'] });
    expect(config.includePatterns).toHaveLength(1);
    expect(config.includePatterns[0]?.test('vite dev')).toBe(true);
    expect(config.includePatterns[0]?.test('postgres -p 5432')).toBe(false);
  });

  it('keeps the port restriction', () => {
    expect(resolveConfig({ ports: [3000] }).ports).toEqual([3000]);
  });

  it('rejects invalid regex sources with a ConfigError', () => {
    expect(() => resolveConfig({ include: ['[unclosed'] })).toThrow(ConfigError);
  });
});
