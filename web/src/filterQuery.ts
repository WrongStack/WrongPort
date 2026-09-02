export interface FilterQuery {
  only?: string;
  ports?: string;
}

/**
 * Curated `only=` patterns offered as one-click chips in the UI. Deliberately
 * plain words that the DEFAULT dev filter does not cover — the chips exist to
 * reveal hidden listeners (docker, local proxies, sshd…), not to repeat what
 * is already listed.
 */
export const SUGGESTED_ONLY_PATTERNS = [
  'docker',
  'nginx',
  'caddy',
  'traefik',
  'ollama',
  'elasticsearch',
  'rabbitmq',
  'sshd',
] as const;

/**
 * Maps the filter box input to server query parameters. Digit/commas narrow
 * by port server-side (ports=); any other text is sent as an extra include
 * pattern (only=), which can reveal processes the default dev filter hides.
 * The old client-side substring filter could only narrow what the server had
 * already returned — that asymmetry is what this wiring exposes.
 */
export function filterBoxToQuery(raw: string): FilterQuery {
  const text = raw.trim();
  if (!text) return {};
  if (/^\d+(,\d+)*$/.test(text)) return { ports: text };
  return { only: text };
}
