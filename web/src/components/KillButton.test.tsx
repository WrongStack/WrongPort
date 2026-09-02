// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KillButton } from './KillButton';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderKillButton = (onConfirm: () => void): HTMLButtonElement => {
  render(<KillButton label="kill" armedLabel="confirm?" onConfirm={onConfirm} />);
  return screen.getByRole('button');
};

describe('KillButton', () => {
  it('does not fire on the first click; it arms and shows the armed label', () => {
    const onConfirm = vi.fn();
    const btn = renderKillButton(onConfirm);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('confirm?');
    expect(btn.className).toContain('bg-danger/20');
  });

  it('fires onConfirm exactly once on the second click and disarms', () => {
    const onConfirm = vi.fn();
    const btn = renderKillButton(onConfirm);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe('kill');
    expect(btn.className).not.toContain('bg-danger/20');
  });

  it('blur disarms without firing', () => {
    const onConfirm = vi.fn();
    const btn = renderKillButton(onConfirm);
    fireEvent.click(btn);
    fireEvent.blur(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('kill');
    expect(btn.className).not.toContain('bg-danger/20');
  });

  it('the 2.5s timeout disarms: a later click re-arms instead of firing', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const btn = renderKillButton(onConfirm);
    fireEvent.click(btn);
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('kill');
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('confirm?');
  });

  it('still fires when confirmed right before the deadline', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const btn = renderKillButton(onConfirm);
    fireEvent.click(btn);
    vi.advanceTimersByTime(2499);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
