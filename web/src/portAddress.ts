/**
 * True when an lsof NAME (e.g. "*:3000", "127.0.0.1:5432", "[::]:5173") is
 * bound to all interfaces instead of loopback only — the difference between
 * a dev server that answers on the LAN and one that does not.
 */
export function isWildcardBinding(address: string): boolean {
  const colon = address.lastIndexOf(':');
  const host = (colon === -1 ? address : address.slice(0, colon)).toLowerCase();
  return host === '*' || host === '0.0.0.0' || host === '::' || host === '[::]';
}

/**
 * True when an lsof NAME host is a loopback address (127.0.0.0/8 or ::1) —
 * the only addresses guaranteed unreachable from the network. Anything else
 * (specific LAN IPs, IPv4-mapped addresses) must not be labelled loopback.
 */
export function isLoopbackBinding(address: string): boolean {
  const colon = address.lastIndexOf(':');
  const host = (colon === -1 ? address : address.slice(0, colon)).toLowerCase();
  return host === '::1' || host === '[::1]' || host.startsWith('127.');
}

