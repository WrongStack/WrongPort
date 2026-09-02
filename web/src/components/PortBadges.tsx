import { isLoopbackBinding, isWildcardBinding } from '../portAddress';
import type { PortEntry } from '../types';

/**
 * Port badges with a three-way binding classification: wildcard binds are
 * network-reachable, loopback is the only provably unreachable case, and a
 * specific-interface bind (LAN IP, IPv4-mapped) must not be labelled
 * "loopback only". Exposed/bound tones are warning-styled; loopback primary.
 */
export function PortBadges({ ports }: { ports: PortEntry[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ports.map((entry) => {
        const tone = isWildcardBinding(entry.address)
          ? 'exposed'
          : isLoopbackBinding(entry.address)
            ? 'loopback'
            : 'bound';
        const title =
          tone === 'exposed'
            ? `${entry.address} — listening on all interfaces (reachable from the network)`
            : tone === 'loopback'
              ? `${entry.address} — loopback only`
              : `${entry.address} — bound to a specific interface (may be reachable from the network)`;
        return (
          <span
            key={`${entry.address}:${entry.port}`}
            title={title}
            className={`rounded-sm border px-1.5 py-0.5 font-mono text-xs ${
              tone === 'loopback'
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
          >
            {tone === 'exposed' ? `*:${entry.port}` : entry.port}
          </span>
        );
      })}
    </div>
  );
}
