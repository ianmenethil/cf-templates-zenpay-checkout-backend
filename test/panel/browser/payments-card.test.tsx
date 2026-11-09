import { useMemo, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { PaymentsCard } from '@/components/PaymentsCard';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useFeed } from '@/hooks/use-feed';
import { getPayments } from '@/lib/api';
import { STATE_LABELS } from '@/lib/labels';
import { PAYMENT_STATES, type PaymentState } from '../../../src/shared/types';
import { isoAgo, makePayment } from '../fixtures';
import { makeFeed, renderPanel, stubApi } from './helpers';

const jane = makePayment({
  id: 'pay-jane',
  customerName: 'Jane Citizen',
  customerEmail: 'jane@example.com',
  paymentAmount: 49.9,
  mode: 0,
  state: 'succeeded',
  reference: 'ZP-REF-1',
  callbackCount: 3,
  createdAt: isoAgo(3 * 60 * 60 * 1000),
});
const sam = makePayment({
  id: 'pay-sam',
  customerName: 'Sam Smith',
  customerEmail: 'sam@example.com',
  paymentAmount: 120,
  mode: 2,
  state: 'unverified',
  reference: null,
  callbackCount: 1,
  createdAt: isoAgo(2 * 24 * 60 * 60 * 1000),
});

/** The props a card test does not care about, with spies for the functions. */
const props = () => ({
  stateFilter: undefined,
  onStateFilterChange: vi.fn(),
  search: '',
  onSearchChange: vi.fn(),
  feed: makeFeed({ items: [jane, sam] }),
  onRefresh: vi.fn(),
  onView: vi.fn(),
  onLoadMore: vi.fn(),
});

describe('PaymentsCard', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a row for each payment with its details', async () => {
    await renderPanel(<PaymentsCard {...props()} />);
    await expect.element(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
    const janeRow = page.getByRole('row', { name: /Jane Citizen/ });
    await expect.element(janeRow).toBeVisible();
    await expect.element(janeRow.getByText('jane@example.com')).toBeVisible();
    await expect.element(janeRow.getByText('$49.90', { exact: false })).toBeVisible();
    await expect.element(janeRow.getByText('Make Payment', { exact: true })).toBeVisible();
    await expect.element(janeRow.getByText('Succeeded')).toBeVisible();
    await expect.element(janeRow.getByText('ZP-REF-1')).toBeVisible();
    await expect.element(janeRow.getByText('3', { exact: true })).toBeVisible();
    const samRow = page.getByRole('row', { name: /Sam Smith/ });
    await expect.element(samRow.getByText('$120.00', { exact: false })).toBeVisible();
    await expect.element(samRow.getByText('Custom Payment', { exact: true })).toBeVisible();
    await expect.element(samRow.getByText('Unverified')).toBeVisible();
    await expect.element(samRow.getByText('none yet')).toBeVisible();
  });

  it('says it is loading', async () => {
    await renderPanel(<PaymentsCard {...props()} feed={makeFeed({ status: 'loading' })} />);
    await expect.element(page.getByText('Loading…')).toBeVisible();
    await expect.element(page.getByRole('table')).not.toBeInTheDocument();
  });

  it('says the list could not load', async () => {
    await renderPanel(<PaymentsCard {...props()} feed={makeFeed({ status: 'error' })} />);
    await expect.element(page.getByText('Could not load payments. Try the refresh button.')).toBeVisible();
  });

  it('explains an empty list when nothing is filtered', async () => {
    await renderPanel(<PaymentsCard {...props()} feed={makeFeed()} />);
    await expect.element(page.getByText('No payments yet. They appear here as soon as a shopper presses Pay.')).toBeVisible();
  });

  it('explains an empty list when a state filter is set', async () => {
    await renderPanel(<PaymentsCard {...props()} stateFilter="failed" feed={makeFeed()} />);
    await expect.element(page.getByText('No payments match your filters.')).toBeVisible();
  });

  it('explains an empty list when the search has text, and ignores a search of only spaces', async () => {
    const screen = await renderPanel(<PaymentsCard {...props()} search="zzz" feed={makeFeed()} />);
    await expect.element(page.getByText('No payments match your filters.')).toBeVisible();
    await screen.rerender(<PaymentsCard {...props()} search="   " feed={makeFeed()} />);
    await expect.element(page.getByText('No payments yet. They appear here as soon as a shopper presses Pay.')).toBeVisible();
  });

  it('marks the table busy while the list is being replaced', async () => {
    await renderPanel(<PaymentsCard {...props()} feed={makeFeed({ items: [jane], busy: true })} />);
    await expect.element(page.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers every state in the filter and reports the one picked', async () => {
    const p = props();
    await renderPanel(<PaymentsCard {...p} />);
    await page.getByRole('combobox', { name: 'Filter by state' }).click();
    await expect.element(page.getByRole('option', { name: 'All states' })).toBeVisible();
    for (const state of PAYMENT_STATES) {
      await expect.element(page.getByRole('option', { name: STATE_LABELS[state].label })).toBeVisible();
    }
    await page.getByRole('option', { name: 'Failed' }).click();
    expect(p.onStateFilterChange).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('reports "all states" as no filter', async () => {
    const p = props();
    await renderPanel(<PaymentsCard {...p} stateFilter="failed" />);
    await expect.element(page.getByRole('combobox', { name: 'Filter by state' })).toHaveTextContent('Failed');
    await page.getByRole('combobox', { name: 'Filter by state' }).click();
    await page.getByRole('option', { name: 'All states' }).click();
    expect(p.onStateFilterChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('reports what is typed in the search box and shows the text it is given', async () => {
    const p = props();
    const screen = await renderPanel(<PaymentsCard {...p} />);
    await page.getByRole('searchbox', { name: 'Search payments' }).fill('jane');
    expect(p.onSearchChange).toHaveBeenLastCalledWith('jane');
    await screen.rerender(<PaymentsCard {...p} search="sam" />);
    await expect.element(page.getByRole('searchbox', { name: 'Search payments' })).toHaveValue('sam');
  });

  it('asks to refresh', async () => {
    const p = props();
    await renderPanel(<PaymentsCard {...p} />);
    await page.getByRole('button', { name: 'Refresh payments' }).click();
    expect(p.onRefresh).toHaveBeenCalledOnce();
  });

  it('opens the payment when its row is clicked', async () => {
    const p = props();
    await renderPanel(<PaymentsCard {...p} />);
    await page
      .getByRole('row', { name: /Sam Smith/ })
      .getByText('sam@example.com')
      .click();
    expect(p.onView).toHaveBeenCalledExactlyOnceWith(sam);
  });

  it('opens the payment once when the row button is clicked', async () => {
    const p = props();
    await renderPanel(<PaymentsCard {...p} />);
    await page.getByRole('button', { name: /open payment for Jane Citizen/i }).click();
    expect(p.onView).toHaveBeenCalledExactlyOnceWith(jane);
  });

  it('opens the payment from the keyboard through the row button', async () => {
    const p = props();
    await renderPanel(<PaymentsCard {...p} />);
    const button = page.getByRole('button', { name: /open payment for Sam Smith/i });
    button.element().focus();
    await expect.element(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(p.onView).toHaveBeenCalledExactlyOnceWith(sam);
  });

  it('names the row button with the text it shows, so a spoken "3 hours ago" finds it', async () => {
    await renderPanel(<PaymentsCard {...props()} />);
    const row = page.getByRole('row', { name: /Jane Citizen/ });
    const shown = row.element().querySelector('time')?.textContent ?? '';
    expect(shown).not.toBe('');
    const button = row.getByRole('button', { name: shown, exact: false });
    await expect.element(button).toBeVisible();
    await expect.element(button).not.toHaveAttribute('aria-label');
    // The name still says what the button does.
    await expect.element(row.getByRole('button', { name: /open payment for Jane Citizen/i })).toBeVisible();
  });

  it('writes the exact time in the tooltip of the shown age', async () => {
    await renderPanel(<PaymentsCard {...props()} />);
    const time = page.getByRole('row', { name: /Jane Citizen/ }).getByRole('time');
    await expect.element(time).toHaveAttribute('datetime', jane.createdAt);
    await expect.element(time).toHaveAttribute('title', expect.stringContaining('2026'));
  });

  it('offers "Load more" only when there is more, and asks for it', async () => {
    const p = props();
    const screen = await renderPanel(<PaymentsCard {...p} />);
    await expect.element(page.getByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await screen.rerender(<PaymentsCard {...p} feed={makeFeed({ items: [jane], hasMore: true })} />);
    await page.getByRole('button', { name: 'Load more' }).click();
    expect(p.onLoadMore).toHaveBeenCalledOnce();
  });

  it('disables "Load more" while a page is being fetched', async () => {
    await renderPanel(<PaymentsCard {...props()} feed={makeFeed({ items: [jane], hasMore: true, loadingMore: true })} />);
    const button = page.getByRole('button', { name: 'Loading…' });
    await expect.element(button).toBeDisabled();
  });

  it('hides "Load more" behind an empty or error message', async () => {
    await renderPanel(<PaymentsCard {...props()} feed={makeFeed({ status: 'error', hasMore: true })} />);
    await expect.element(page.getByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

/** The card wired the way `App` wires it: the search is followed after a pause and each change fetches again. */
const Wired = () => {
  const [state, setState] = useState<PaymentState | undefined>();
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim(), 300);
  const filter = useMemo(() => ({ state, q: query }), [state, query]);
  const feed = useFeed(getPayments, filter);
  return (
    <PaymentsCard
      stateFilter={state}
      onStateFilterChange={setState}
      search={search}
      onSearchChange={setSearch}
      feed={feed}
      onRefresh={feed.reload}
      onView={vi.fn()}
      onLoadMore={vi.fn()}
    />
  );
};

describe('PaymentsCard with a debounced search', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches once for a burst of typing, after the pause', async () => {
    const { seen } = stubApi(() => ({ payments: [jane], nextBefore: null }));
    await renderPanel(<Wired />);
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
    expect(seen).toHaveLength(1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const box = page.getByRole('searchbox', { name: 'Search payments' });
    await box.fill('j');
    await box.fill('ja');
    await box.fill('  jane  ');
    vi.advanceTimersByTime(299);
    expect(seen).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]?.query.get('q')).toBe('jane');
  });

  it('fetches again at once when the state filter changes, keeping the search', async () => {
    const { seen } = stubApi(() => ({ payments: [jane], nextBefore: null }));
    await renderPanel(<Wired />);
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter by state' }).click();
    await page.getByRole('option', { name: 'Succeeded' }).click();
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]?.query.get('state')).toBe('succeeded');
    expect(seen[1]?.query.has('q')).toBe(false);
  });

  it('fetches again when refresh is pressed', async () => {
    const { seen } = stubApi(() => ({ payments: [jane], nextBefore: null }));
    await renderPanel(<Wired />);
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh payments' }).click();
    await expect.poll(() => seen.length).toBe(2);
  });
});
