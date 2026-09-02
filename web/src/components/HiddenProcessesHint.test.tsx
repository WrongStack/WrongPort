// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HiddenProcessesHint } from './HiddenProcessesHint';

afterEach(cleanup);

describe('HiddenProcessesHint', () => {
  it('renders nothing for zero or negative counts', () => {
    const zero = render(<HiddenProcessesHint hiddenCount={0} />);
    const negative = render(<HiddenProcessesHint hiddenCount={-1} />);
    expect(zero.container.textContent).toBe('');
    expect(negative.container.textContent).toBe('');
  });

  it('tells the user how many processes the dev filter is hiding', () => {
    render(<HiddenProcessesHint hiddenCount={3} />);
    expect(screen.getByText(/3 more listening process\(es\) hidden by the dev filter/)).toBeTruthy();
    expect(screen.getByText(/enable "all processes"/)).toBeTruthy();
  });
});
