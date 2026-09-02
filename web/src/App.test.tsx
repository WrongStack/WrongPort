// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { SUGGESTED_ONLY_PATTERNS } from './filterQuery';
import type { DevProcess, Snapshot } from './types';

const useProcessesMock = vi.hoisted(() => vi.fn());
const killWithStaleRecoveryMock = vi.hoisted(() => vi.fn());
vi.mock('./useProcesses', () => ({ useProcesses: useProcessesMock }));
vi.mock('./api', () => ({ killWithStaleRecovery: killWithStaleRecoveryMock }));

const proc = (over: Partial<DevProcess> = {}): DevProcess => ({
  pid: 111,
  name: 'node',
  command: 'node server.js',
  user: 'ersin',
  ports: [{ port: 3000, address: '127.0.0.1:3000' }],
  matched: true,
  ...over,
});

const snap = (processes: DevProcess[] = [proc()], scannedCount = processes.length): Snapshot => ({
  createdAt: new Date('2026-01-01T10:20:30Z').getTime(),
  platform: 'linux',
  processes,
  scannedCount,
});

const refreshMock = vi.fn(() => Promise.resolve());

const hookDefaults = (over: object = {}) => ({
  snapshot: snap(),
  error: null,
  refreshing: false,
  refresh: refreshMock,
  ...over,
});

const lastHookArgs = (): Record<string, unknown> =>
  (useProcessesMock.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  refreshMock.mockClear();
  killWithStaleRecoveryMock.mockReset();
  killWithStaleRecoveryMock.mockResolvedValue(undefined);
  useProcessesMock.mockReset();
  useProcessesMock.mockReturnValue(hookDefaults());
});

afterEach(() => {
  // Vitest globals are off, so RTL's automatic cleanup is not registered.
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('App', () => {
  it('renders the process table with counts, platform and the hidden hint', () => {
    useProcessesMock.mockReturnValue(hookDefaults({ snapshot: snap([proc()], 5) }));
    render(<App />);
    expect(screen.getByText('wrongport')).toBeTruthy();
    expect(screen.getByText(/dev ports on linux/)).toBeTruthy();
    expect(screen.getByText('1 procs')).toBeTruthy();
    expect(screen.getByText('1 ports')).toBeTruthy();
    // The desktop table and the mobile card layout both render the row; the
    // user column exists only in the table.
    expect(screen.getAllByText('node')).toHaveLength(2);
    expect(screen.getAllByText('node server.js')).toHaveLength(2);
    expect(screen.getAllByText('ersin')).toHaveLength(1);
    expect(screen.queryByText('unfiltered')).toBeNull();
    // scannedCount 5 - 1 row = 4 hidden by the dev filter.
    expect(screen.getByText(/4 more listening process\(es\) hidden/)).toBeTruthy();
  });

  it('marks processes that the dev filter did not match', () => {
    useProcessesMock.mockReturnValue(hookDefaults({ snapshot: snap([proc({ matched: false })]) }));
    render(<App />);
    // Rendered in both the desktop table and the mobile card layout.
    expect(screen.getAllByText('unfiltered')).toHaveLength(2);
  });

  it('shows a loading state before the first snapshot', () => {
    useProcessesMock.mockReturnValue(hookDefaults({ snapshot: null }));
    render(<App />);
    expect(screen.getByText('scanning…')).toBeTruthy();
    expect(screen.getByText('last update —')).toBeTruthy();
  });

  it('explains empty results when the dev filter hides processes', () => {
    useProcessesMock.mockReturnValue(hookDefaults({ snapshot: snap([], 4) }));
    render(<App />);
    expect(screen.getByText('No listening dev processes found.')).toBeTruthy();
    expect(
      screen.getByText('4 listening process(es) hidden by the dev filter — enable "all processes".'),
    ).toBeTruthy();
  });

  it('explains a genuinely idle machine', () => {
    useProcessesMock.mockReturnValue(hookDefaults({ snapshot: snap([], 0) }));
    render(<App />);
    expect(screen.getByText('Nothing is listening on TCP ports right now.')).toBeTruthy();
  });

  it('explains a filtered empty result', async () => {
    useProcessesMock.mockReturnValue(hookDefaults({ snapshot: snap([], 0) }));
    render(<App />);
    fireEvent.change(screen.getByLabelText('Filter processes'), { target: { value: 'zz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByText('Nothing matches "zz"')).toBeTruthy();
    expect(screen.getByText('Clear the filter to see everything.')).toBeTruthy();
  });

  it('debounces the filter box into only=/ports= hook options', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Filter processes'), { target: { value: '3000' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(lastHookArgs()).toMatchObject({ ports: '3000', only: undefined });
    fireEvent.change(screen.getByLabelText('Filter processes'), { target: { value: 'node' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(lastHookArgs()).toMatchObject({ only: 'node', ports: undefined });
  });

  it('toggles all-processes mode', () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText('all processes'));
    expect(lastHookArgs()).toMatchObject({ all: true });
  });

  it('changes the poll cadence from the select', () => {
    render(<App />);
    const select = screen.getByLabelText('refresh');
    fireEvent.change(select, { target: { value: '1000' } });
    expect(screen.getByText('polling 1s')).toBeTruthy();
    expect(lastHookArgs()).toMatchObject({ intervalMs: 1000 });
    fireEvent.change(select, { target: { value: '0' } });
    expect(screen.getByText('polling off')).toBeTruthy();
    expect(lastHookArgs()).toMatchObject({ intervalMs: 0 });
  });

  it('refreshes on demand and reflects the refreshing state', async () => {
    const view = render(<App />);
    const button = screen.getByRole('button', { name: '↻ refresh' });
    fireEvent.click(button);
    await act(async () => {});
    expect(refreshMock).toHaveBeenCalledTimes(1);

    useProcessesMock.mockReturnValue(hookDefaults({ refreshing: true }));
    view.rerender(<App />);
    expect((screen.getByRole('button', { name: '… refresh' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('applies and clears suggested only patterns', () => {
    render(<App />);
    const pattern = SUGGESTED_ONLY_PATTERNS[0];
    const chip = screen.getByRole('button', { name: pattern });
    fireEvent.click(chip);
    const input = screen.getByLabelText('Filter processes') as HTMLInputElement;
    expect(input.value).toBe(pattern);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(input.value).toBe('');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows server errors in an alert banner', () => {
    useProcessesMock.mockReturnValue(hookDefaults({ error: 'invalid only pattern "["' }));
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('invalid only pattern "["');
  });

  it('runs the two-step kill and refreshes afterwards', async () => {
    render(<App />);
    const killButtons = screen.getAllByRole('button', { name: 'kill' });
    for (const button of killButtons) {
      fireEvent.click(button);
      fireEvent.click(button);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(killWithStaleRecoveryMock).toHaveBeenCalledWith(111, false, refreshMock);
    expect(killWithStaleRecoveryMock).toHaveBeenCalledTimes(2);
    // The post-kill refresh happens after the action resolves.
    expect(refreshMock).toHaveBeenCalled();
  });

  it('sends SIGKILL via the -9 button in both layouts', async () => {
    render(<App />);
    const killButtons = screen.getAllByRole('button', { name: '-9' });
    for (const button of killButtons) {
      fireEvent.click(button);
      fireEvent.click(button);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(killWithStaleRecoveryMock).toHaveBeenCalledWith(111, true, refreshMock);
    expect(killWithStaleRecoveryMock).toHaveBeenCalledTimes(2);
  });

  it('shows and dismisses action errors', async () => {
    killWithStaleRecoveryMock.mockRejectedValue(new Error('pid was not in the latest scan'));
    render(<App />);
    const killButton = screen.getAllByRole('button', { name: 'kill' })[0]!;
    fireEvent.click(killButton);
    fireEvent.click(killButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toContain('pid was not in the latest scan');
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
