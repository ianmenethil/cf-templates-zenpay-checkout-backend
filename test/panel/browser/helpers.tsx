import '@/index.css';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Feed } from '@/hooks/use-feed';
import { addressOf } from '../fixtures';

/** The providers `main.tsx` puts around the app. */
const Providers = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>
    <TooltipProvider>{children}</TooltipProvider>
  </ThemeProvider>
);

/**
 * Renders a component the way the app does, on a desktop-wide page so the table layout shows.
 * @param ui - What to render.
 * @returns The `vitest-browser-react` render result.
 */
export const renderPanel = async (ui: ReactNode) => {
  await page.viewport(1280, 900);
  return render(ui, { wrapper: Providers });
};

/**
 * Builds a {@link Feed} for a card test; the functions are spies.
 * @param overrides - The fields the test cares about.
 * @returns A ready, empty feed with those fields replaced.
 */
export const makeFeed = <T,>(overrides: Partial<Feed<T>> = {}): Feed<T> => ({
  items: [],
  status: 'ready',
  busy: false,
  hasMore: false,
  loadingMore: false,
  reload: vi.fn(),
  loadMore: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/** One request the fake API saw. */
export type Seen = { method: string; path: string; query: URLSearchParams };

/**
 * A function that answers one request. It returns a `Response`, or any other value to be sent as a `200` JSON body, or
 * a promise of either when the test decides when the answer arrives; `undefined` means it does not know the route.
 */
export type Route = (request: Seen) => unknown;

/**
 * Replaces `fetch` with a fake admin API.
 * @param route - Answers each request; return `undefined` for a route the test did not expect, which fails the request with a 404.
 * @returns The `fetch` spy, so a test can count and read the requests, and the list of requests seen.
 */
export const stubApi = (route: Route) => {
  const seen: Seen[] = [];
  const fetchSpy = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(addressOf(input), 'https://admin.test');
    const request: Seen = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams };
    seen.push(request);
    const answer = route(request);
    if (answer === undefined) {
      return Promise.resolve(Response.json({ error: `No fake route for ${request.method} ${request.path}` }, { status: 404 }));
    }
    return Promise.resolve(answer).then((value) => (value instanceof Response ? value : Response.json(value)));
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { fetchSpy, seen };
};

/** A `204 No Content` answer. */
export const noContent = (): Response => new Response(null, { status: 204 });

/** An error answer in the API's shape. */
export const apiError = (message: string, status = 500): Response => Response.json({ error: message }, { status });
