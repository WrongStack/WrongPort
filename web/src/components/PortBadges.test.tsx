// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PortEntry } from '../types';
import { PortBadges } from './PortBadges';

afterEach(cleanup);

const entry = (address: string, port: number): PortEntry => ({ address, port });

describe('PortBadges', () => {
  it('renders a wildcard bind as exposed: *:port text, warning tone, explaining title', () => {
    render(<PortBadges ports={[entry('*:3000', 3000)]} />);
    const badge = screen.getByText('*:3000');
    expect(badge.className).toContain('text-warning');
    expect(badge.getAttribute('title')).toContain('listening on all interfaces');
  });

  it('renders an IPv6 wildcard bind as exposed too', () => {
    render(<PortBadges ports={[entry('[::]:5173', 5173)]} />);
    expect(screen.getByText('*:5173').className).toContain('text-warning');
  });

  it('renders a loopback bind in primary tone with a loopback-only title', () => {
    render(<PortBadges ports={[entry('127.0.0.1:5432', 5432)]} />);
    const badge = screen.getByText('5432');
    expect(badge.className).toContain('text-primary');
    expect(badge.getAttribute('title')).toContain('loopback only');
  });

  it('renders a specific-interface bind as warning with a non-loopback title', () => {
    render(<PortBadges ports={[entry('192.168.1.20:8080', 8080)]} />);
    const badge = screen.getByText('8080');
    expect(badge.className).toContain('text-warning');
    expect(badge.getAttribute('title')).toContain('bound to a specific interface');
    expect(badge.getAttribute('title')).not.toContain('loopback only');
  });

  it('renders one badge per port entry', () => {
    render(<PortBadges ports={[entry('*:3000', 3000), entry('127.0.0.1:5432', 5432)]} />);
    expect(screen.getByText('*:3000')).toBeTruthy();
    expect(screen.getByText('5432')).toBeTruthy();
  });
});
