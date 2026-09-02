// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PidCell } from './PidCell';

afterEach(cleanup);

const stubClipboard = (writeText: (text: string) => Promise<void>): void => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
};

afterEach(() => {
  // Drop any clipboard stub so tests stay isolated.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('PidCell', () => {
  it('renders the pid', () => {
    render(<PidCell pid={4242} />);
    expect(screen.getByText('4242')).toBeTruthy();
  });

  it('copies the pid and shows a confirmation on click', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    render(<PidCell pid={4242} />);
    fireEvent.click(screen.getByText('4242'));
    expect(writeText).toHaveBeenCalledWith('4242');
    expect(await screen.findByText('copied ✓')).toBeTruthy();
  });

  it('degrades silently when the clipboard is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<PidCell pid={7} />);
    fireEvent.click(screen.getByText('7'));
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.queryByText('copied ✓')).toBeNull();
  });

  it('clears the confirmation flash after a moment', async () => {
    vi.useFakeTimers();
    try {
      stubClipboard(vi.fn(() => Promise.resolve()));
      render(<PidCell pid={4242} />);
      fireEvent.click(screen.getByText('4242'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('copied ✓')).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_200);
      });
      expect(screen.queryByText('copied ✓')).toBeNull();
      expect(screen.getByText('4242')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet when the clipboard write rejects', async () => {
    stubClipboard(vi.fn(() => Promise.reject(new Error('denied'))));
    render(<PidCell pid={99} />);
    fireEvent.click(screen.getByText('99'));
    await act(async () => {});
    expect(screen.getByText('99')).toBeTruthy();
    expect(screen.queryByText('copied ✓')).toBeNull();
  });
});
