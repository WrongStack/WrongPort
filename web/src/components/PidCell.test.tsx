// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
