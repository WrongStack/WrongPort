// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./App', () => ({ default: () => 'app-ok' }));
vi.mock('./index.css', () => ({}));

const importMain = async (): Promise<void> => {
  vi.resetModules();
  await import('./main');
};

describe('main bootstrap', () => {
  it('mounts the app into the #root element', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const mounting = importMain();
    await act(async () => {
      await mounting;
    });
    expect(document.getElementById('root')?.textContent).toBe('app-ok');
  });

  it('throws when the #root element is missing', async () => {
    document.body.innerHTML = '';
    await expect(importMain()).rejects.toThrow('#root element not found');
  });
});
