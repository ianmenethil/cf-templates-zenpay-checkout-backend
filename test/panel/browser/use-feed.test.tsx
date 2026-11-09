import { describe, expect, it } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useFeed } from '@/hooks/use-feed';
import type { Page } from '@/lib/api';
import { defer, type Deferred } from '../fixtures';

/** One call the hook made to its fetch function, with the way to settle it. */
type Call = { filter: string; before: string | undefined; answer: Deferred<Page<string>> };

/**
 * A fetch function whose every call waits for the test to settle it.
 * @returns The function, and the calls made so far in order.
 */
const controlledFetch = () => {
  const calls: Call[] = [];
  const fetchPage = (filter: string, before?: string): Promise<Page<string>> => {
    const answer = defer<Page<string>>();
    calls.push({ filter, before, answer });
    return answer.promise;
  };
  return { calls, fetchPage };
};

/** A page of items. */
const page = (items: string[], nextBefore: string | null = null): Page<string> => ({ items, nextBefore });

/** Renders `useFeed` for a filter that the test can change with `rerender`. */
const renderFeed = (fetchPage: (filter: string, before?: string) => Promise<Page<string>>, filter = 'a') =>
  renderHook((props?: { filter: string }) => useFeed(fetchPage, props?.filter ?? filter), { initialProps: { filter } });

describe('useFeed', () => {
  it('is loading, with nothing to show, until the first answer', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result } = await renderFeed(fetchPage);
    expect(result.current).toMatchObject({ status: 'loading', items: [], busy: false, hasMore: false, loadingMore: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ filter: 'a', before: undefined });
  });

  it('becomes ready with the first page and knows whether there is more', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1', 'a2'], 'cursor-1'));
    await expect.poll(() => result.current.status).toBe('ready');
    expect(result.current).toMatchObject({ items: ['a1', 'a2'], hasMore: true, busy: false });
  });

  it('has no more when the first page has no cursor', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1']));
    await expect.poll(() => result.current.status).toBe('ready');
    expect(result.current.hasMore).toBe(false);
  });

  it('turns to error, with an empty list, when the fetch fails', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result } = await renderFeed(fetchPage);
    calls[0]?.answer.reject(new Error('boom'));
    await expect.poll(() => result.current.status).toBe('error');
    expect(result.current).toMatchObject({ items: [], hasMore: false, busy: false });
  });

  it('fetches again for a new filter, keeping the old list on screen and marked busy', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, rerender } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1'], 'cursor-1'));
    await expect.poll(() => result.current.status).toBe('ready');

    await rerender({ filter: 'b' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ filter: 'b', before: undefined });
    expect(result.current).toMatchObject({ status: 'ready', items: ['a1'], busy: true, hasMore: false });

    calls[1]?.answer.resolve(page(['b1', 'b2']));
    await expect.poll(() => result.current.busy).toBe(false);
    expect(result.current.items).toEqual(['b1', 'b2']);
  });

  it('ignores an answer for an old filter that arrives after the new one', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, rerender, act } = await renderFeed(fetchPage);
    await rerender({ filter: 'b' });
    calls[1]?.answer.resolve(page(['b1']));
    await expect.poll(() => result.current.status).toBe('ready');
    calls[0]?.answer.resolve(page(['a-late']));
    // Let the late answer land and React apply whatever it would change.
    await act(() => Promise.resolve());
    expect(result.current.items).toEqual(['b1']);
  });

  it('ignores an answer for an old filter that arrives while the new one is still loading', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, rerender, act } = await renderFeed(fetchPage);
    await rerender({ filter: 'b' });
    calls[0]?.answer.resolve(page(['a-late']));
    await act(() => Promise.resolve());
    expect(result.current).toMatchObject({ status: 'loading', items: [] });
    calls[1]?.answer.resolve(page(['b1']));
    await expect.poll(() => result.current.items).toEqual(['b1']);
  });

  it('ignores a failure for an old filter', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, rerender } = await renderFeed(fetchPage);
    await rerender({ filter: 'b' });
    calls[0]?.answer.reject(new Error('old'));
    calls[1]?.answer.resolve(page(['b1']));
    await expect.poll(() => result.current.status).toBe('ready');
    expect(result.current.items).toEqual(['b1']);
  });

  it('reload fetches the same filter again from the first page and marks the list busy meanwhile', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, act } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1'], 'cursor-1'));
    await expect.poll(() => result.current.status).toBe('ready');

    await act(() => {
      result.current.reload();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ filter: 'a', before: undefined });
    expect(result.current).toMatchObject({ items: ['a1'], busy: true });

    calls[1]?.answer.resolve(page(['a1', 'a0']));
    await expect.poll(() => result.current.busy).toBe(false);
    expect(result.current.items).toEqual(['a1', 'a0']);
  });

  it('loadMore appends the next page and says it is loading meanwhile', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, act } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1', 'a2'], 'cursor-1'));
    await expect.poll(() => result.current.hasMore).toBe(true);

    let done: Promise<void> | undefined;
    await act(() => {
      done = result.current.loadMore();
    });
    expect(calls[1]).toMatchObject({ filter: 'a', before: 'cursor-1' });
    expect(result.current.loadingMore).toBe(true);

    calls[1]?.answer.resolve(page(['a3'], 'cursor-2'));
    await done;
    await expect.poll(() => result.current.loadingMore).toBe(false);
    expect(result.current).toMatchObject({ items: ['a1', 'a2', 'a3'], hasMore: true });

    await act(() => {
      done = result.current.loadMore();
    });
    expect(calls[2]).toMatchObject({ before: 'cursor-2' });
    calls[2]?.answer.resolve(page(['a4']));
    await done;
    await expect.poll(() => result.current.hasMore).toBe(false);
    expect(result.current.items).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('loadMore does nothing when there is no next page or the list has not loaded', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result } = await renderFeed(fetchPage);
    await result.current.loadMore();
    expect(calls).toHaveLength(1);
    calls[0]?.answer.resolve(page(['a1']));
    await expect.poll(() => result.current.status).toBe('ready');
    await result.current.loadMore();
    expect(calls).toHaveLength(1);
  });

  it('loadMore does nothing while the list is being replaced', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, rerender } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1'], 'cursor-1'));
    await expect.poll(() => result.current.hasMore).toBe(true);
    await rerender({ filter: 'b' });
    await result.current.loadMore();
    expect(calls).toHaveLength(2);
  });

  it('loadMore rejects when the fetch fails, and the list and the flag recover', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, act } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1'], 'cursor-1'));
    await expect.poll(() => result.current.hasMore).toBe(true);

    let done: Promise<void> | undefined;
    await act(() => {
      done = result.current.loadMore();
    });
    const rejected = expect(done).rejects.toThrow('boom');
    calls[1]?.answer.reject(new Error('boom'));
    await rejected;
    await expect.poll(() => result.current.loadingMore).toBe(false);
    expect(result.current).toMatchObject({ status: 'ready', items: ['a1'], hasMore: true });
  });

  it('drops a page that arrives after the filter changed', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, rerender, act } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1'], 'cursor-1'));
    await expect.poll(() => result.current.hasMore).toBe(true);

    let done: Promise<void> | undefined;
    await act(() => {
      done = result.current.loadMore();
    });
    await rerender({ filter: 'b' });
    calls[2]?.answer.resolve(page(['b1']));
    await expect.poll(() => result.current.items).toEqual(['b1']);

    calls[1]?.answer.resolve(page(['a-late'], 'cursor-late'));
    await done;
    await expect.poll(() => result.current.loadingMore).toBe(false);
    expect(result.current).toMatchObject({ items: ['b1'], hasMore: false });
  });

  it('drops a page that arrives after a reload', async () => {
    const { calls, fetchPage } = controlledFetch();
    const { result, act } = await renderFeed(fetchPage);
    calls[0]?.answer.resolve(page(['a1'], 'cursor-1'));
    await expect.poll(() => result.current.hasMore).toBe(true);

    let done: Promise<void> | undefined;
    await act(() => {
      done = result.current.loadMore();
    });
    await act(() => {
      result.current.reload();
    });
    calls[2]?.answer.resolve(page(['fresh']));
    await expect.poll(() => result.current.items).toEqual(['fresh']);

    calls[1]?.answer.resolve(page(['stale'], 'cursor-stale'));
    await done;
    await expect.poll(() => result.current.loadingMore).toBe(false);
    expect(result.current).toMatchObject({ items: ['fresh'], hasMore: false });
  });
});
