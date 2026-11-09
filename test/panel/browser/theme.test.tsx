import { Component, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { Topbar } from '@/components/Topbar';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TooltipProvider } from '@/components/ui/tooltip';
import { THEMES, useTheme } from '@/hooks/use-theme';
import { renderPanel } from './helpers';

const STORAGE_KEY = 'zenpay-checkout-backend-theme';

/** The theme class on `<html>`. */
const rootClasses = (): string[] => [...document.documentElement.classList].filter((name) => name === 'light' || name === 'dark');

/** Replaces `matchMedia` with a fake operating system setting the test can flip. */
const fakeSystemTheme = (dark: boolean) => {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    listeners,
    change: (next: boolean) => {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
};

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('starts on system when nothing is stored, and applies the system setting', async () => {
    fakeSystemTheme(true);
    await renderPanel(<ThemeToggle />);
    await expect.element(page.getByRole('button', { name: 'Theme: system' })).toBeVisible();
    expect(rootClasses()).toEqual(['dark']);
  });

  it('applies a light system setting', async () => {
    fakeSystemTheme(false);
    await renderPanel(<ThemeToggle />);
    expect(rootClasses()).toEqual(['light']);
  });

  it('starts on the stored theme', async () => {
    fakeSystemTheme(false);
    localStorage.setItem(STORAGE_KEY, 'dark');
    await renderPanel(<ThemeToggle />);
    await expect.element(page.getByRole('button', { name: 'Theme: dark' })).toBeVisible();
    expect(rootClasses()).toEqual(['dark']);
  });

  it('ignores a stored value that is not a theme', async () => {
    fakeSystemTheme(false);
    localStorage.setItem(STORAGE_KEY, 'purple');
    await renderPanel(<ThemeToggle />);
    await expect.element(page.getByRole('button', { name: 'Theme: system' })).toBeVisible();
  });

  it('follows the system setting while on system, and stops listening after a choice', async () => {
    const system = fakeSystemTheme(false);
    await renderPanel(<ThemeToggle />);
    expect(rootClasses()).toEqual(['light']);
    expect(system.listeners.size).toBe(1);

    system.change(true);
    expect(rootClasses()).toEqual(['dark']);

    await page.getByRole('button', { name: 'Theme: system' }).click();
    await expect.element(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
    expect(system.listeners.size).toBe(0);
    system.change(true);
    expect(rootClasses()).toEqual(['light']);
  });

  it('stops listening when it unmounts', async () => {
    const system = fakeSystemTheme(false);
    const screen = await renderPanel(<ThemeToggle />);
    expect(system.listeners.size).toBe(1);
    await screen.unmount();
    expect(system.listeners.size).toBe(0);
  });

  it('cycles system, light, dark and remembers each choice', async () => {
    fakeSystemTheme(true);
    await renderPanel(<ThemeToggle />);
    expect(THEMES).toEqual(['system', 'light', 'dark']);

    await page.getByRole('button', { name: 'Theme: system' }).click();
    await expect.element(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(rootClasses()).toEqual(['light']);

    await page.getByRole('button', { name: 'Theme: light' }).click();
    await expect.element(page.getByRole('button', { name: 'Theme: dark' })).toBeVisible();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(rootClasses()).toEqual(['dark']);

    await page.getByRole('button', { name: 'Theme: dark' }).click();
    await expect.element(page.getByRole('button', { name: 'Theme: system' })).toBeVisible();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
    expect(rootClasses()).toEqual(['dark']);
  });

  it('keeps a choice across a fresh start', async () => {
    fakeSystemTheme(false);
    const first = await renderPanel(<ThemeToggle />);
    await page.getByRole('button', { name: 'Theme: system' }).click();
    await expect.element(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
    await first.unmount();
    await renderPanel(<ThemeToggle />);
    await expect.element(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
  });

  it('starts on system when storage cannot be read', async () => {
    fakeSystemTheme(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    await renderPanel(<ThemeToggle />);
    await expect.element(page.getByRole('button', { name: 'Theme: system' })).toBeVisible();
  });

  it('still switches when storage cannot be written', async () => {
    fakeSystemTheme(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await renderPanel(<ThemeToggle />);
    await page.getByRole('button', { name: 'Theme: system' }).click();
    await expect.element(page.getByRole('button', { name: 'Theme: light' })).toBeVisible();
    expect(rootClasses()).toEqual(['light']);
  });
});

/** Catches the error `useTheme` throws, so the test can read it. */
class Catch extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? <p>{this.state.error.message}</p> : this.props.children;
  }
}

/** Shows the theme from `useTheme`. */
const Show = () => <p>{useTheme().theme}</p>;

describe('useTheme', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws outside a ThemeProvider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await render(
      <Catch>
        <Show />
      </Catch>,
    );
    await expect.element(page.getByText('useTheme must be used within a ThemeProvider')).toBeVisible();
  });

  it('reads the theme inside a ThemeProvider', async () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    await render(
      <ThemeProvider>
        <Show />
      </ThemeProvider>,
    );
    await expect.element(page.getByText('light', { exact: true })).toBeVisible();
    localStorage.clear();
  });
});

describe('Topbar', () => {
  it('shows the brand and the signed-in email next to the theme toggle', async () => {
    await renderPanel(<Topbar profile={{ brand: 'Acme', email: 'ian@example.com' }} />);
    await expect.element(page.getByText('Acme', { exact: false })).toBeVisible();
    await expect.element(page.getByText('Checkout')).toBeVisible();
    await expect.element(page.getByText('ian@example.com')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /^Theme:/ })).toBeVisible();
  });

  it('shows no email before the profile has loaded', async () => {
    await render(
      <ThemeProvider>
        <TooltipProvider>
          <Topbar profile={null} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await expect.element(page.getByText('Checkout')).toBeVisible();
    await expect.element(page.getByText('@')).not.toBeInTheDocument();
  });
});
