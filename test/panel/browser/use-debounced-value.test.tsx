import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

type Props = { value: string; delay: number };

/** Renders the hook with a value and a delay the test can change. */
const renderDebounced = (initial: Props) =>
  renderHook((props?: Props) => useDebouncedValue(props?.value ?? '', props?.delay ?? 0), { initialProps: initial });

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with the value it is given, with no wait', async () => {
    const { result } = await renderDebounced({ value: 'a', delay: 300 });
    expect(result.current).toBe('a');
  });

  it('passes a changed value on only after the delay', async () => {
    const { result, rerender, act } = await renderDebounced({ value: 'a', delay: 300 });
    await rerender({ value: 'b', delay: 300 });
    expect(result.current).toBe('a');
    await act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');
    await act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('b');
  });

  it('starts the wait again for each change, so a burst gives one update with the last value', async () => {
    const { result, rerender, act } = await renderDebounced({ value: 'a', delay: 300 });
    await rerender({ value: 'b', delay: 300 });
    await act(() => vi.advanceTimersByTime(200));
    await rerender({ value: 'c', delay: 300 });
    await act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    await act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('c');
  });

  it('never shows a value that was replaced inside the delay', async () => {
    const { result, rerender, act } = await renderDebounced({ value: 'a', delay: 300 });
    const seen = new Set<string>();
    for (const value of ['b', 'c', 'd']) {
      await rerender({ value, delay: 300 });
      await act(() => vi.advanceTimersByTime(100));
      seen.add(result.current);
    }
    await act(() => vi.advanceTimersByTime(300));
    seen.add(result.current);
    expect([...seen]).toEqual(['a', 'd']);
  });

  it('follows a change of the delay', async () => {
    const { result, rerender, act } = await renderDebounced({ value: 'a', delay: 300 });
    await rerender({ value: 'b', delay: 50 });
    await act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe('b');
  });

  it('works for values that are not text', async () => {
    const { result, rerender, act } = await renderHook((props?: { value: number }) => useDebouncedValue(props?.value ?? 0, 10), {
      initialProps: { value: 1 },
    });
    await rerender({ value: 2 });
    await act(() => vi.advanceTimersByTime(10));
    expect(result.current).toBe(2);
  });

  it('cancels a pending update when it unmounts', async () => {
    const { rerender, unmount } = await renderDebounced({ value: 'a', delay: 300 });
    await rerender({ value: 'b', delay: 300 });
    expect(vi.getTimerCount()).toBe(1);
    await unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
