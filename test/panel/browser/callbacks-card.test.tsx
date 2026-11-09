import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { CallbacksCard } from '@/components/CallbacksCard';
import { NO_PAYMENT, OUTCOME_LABELS } from '@/lib/labels';
import { CALLBACK_OUTCOMES } from '../../../src/shared/types';
import { isoAgo, makeCallback } from '../fixtures';
import { makeFeed, renderPanel } from './helpers';

const verified = makeCallback({
  id: 'cb-verified',
  paymentId: 'pay-aaa',
  outcome: 'verified',
  deliveries: 1,
  size: 512,
  receivedAt: isoAgo(5 * 60 * 1000),
});
const orphan = makeCallback({
  id: 'cb-orphan',
  paymentId: null,
  outcome: 'rejected',
  reason: 'The callback address has no token.',
  deliveries: 2,
  size: 2048,
  receivedAt: isoAgo(2 * 60 * 60 * 1000),
});

/** The props a card test does not care about, with spies for the functions. */
const props = () => ({
  outcomeFilter: undefined,
  onOutcomeFilterChange: vi.fn(),
  feed: makeFeed({ items: [verified, orphan] }),
  onRefresh: vi.fn(),
  onView: vi.fn(),
  onLoadMore: vi.fn(),
});

describe('CallbacksCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a row for each callback with its details', async () => {
    await renderPanel(<CallbacksCard {...props()} />);
    await expect.element(page.getByRole('heading', { name: 'Callbacks' })).toBeVisible();
    const verifiedRow = page.getByRole('row', { name: /pay-aaa/ });
    await expect.element(verifiedRow.getByText('Verified')).toBeVisible();
    await expect.element(verifiedRow.getByText('1 delivery', { exact: false })).toBeVisible();
    const orphanRow = page.getByRole('row', { name: /The callback address has no token/ });
    await expect.element(orphanRow.getByText('Rejected')).toBeVisible();
    await expect.element(orphanRow.getByText('2 deliveries', { exact: false })).toBeVisible();
    await expect.element(orphanRow.getByText('The callback address has no token.')).toBeVisible();
  });

  it('says "No payment" for a callback with no payment, and explains both causes', async () => {
    await renderPanel(<CallbacksCard {...props()} />);
    const note = page.getByRole('row', { name: /The callback address has no token/ }).getByText(NO_PAYMENT.label);
    await expect.element(note).toBeVisible();
    await expect.element(note).toHaveAttribute('title', NO_PAYMENT.hint);
    expect(NO_PAYMENT.hint).toMatch(/could not be read/);
    expect(NO_PAYMENT.hint).toMatch(/no longer exists/);
    await expect.element(page.getByText('No readable token', { exact: false })).not.toBeInTheDocument();
  });

  it('shows the payment ID when there is one and no "No payment" note', async () => {
    await renderPanel(<CallbacksCard {...props()} feed={makeFeed({ items: [verified] })} />);
    await expect.element(page.getByText('pay-aaa')).toBeVisible();
    await expect.element(page.getByText(NO_PAYMENT.label)).not.toBeInTheDocument();
  });

  it('says it is loading', async () => {
    await renderPanel(<CallbacksCard {...props()} feed={makeFeed({ status: 'loading' })} />);
    await expect.element(page.getByText('Loading…')).toBeVisible();
  });

  it('says the list could not load', async () => {
    await renderPanel(<CallbacksCard {...props()} feed={makeFeed({ status: 'error' })} />);
    await expect.element(page.getByText('Could not load callbacks. Try the refresh button.')).toBeVisible();
  });

  it('explains an empty list, with and without a filter', async () => {
    const screen = await renderPanel(<CallbacksCard {...props()} feed={makeFeed()} />);
    await expect.element(page.getByText('No callbacks yet. They appear here as soon as ZenPay posts one.')).toBeVisible();
    await screen.rerender(<CallbacksCard {...props()} outcomeFilter="rejected" feed={makeFeed()} />);
    await expect.element(page.getByText('No callbacks match this filter.')).toBeVisible();
  });

  it('marks the table busy while the list is being replaced', async () => {
    await renderPanel(<CallbacksCard {...props()} feed={makeFeed({ items: [verified], busy: true })} />);
    await expect.element(page.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('offers every outcome in the filter and reports the one picked', async () => {
    const p = props();
    await renderPanel(<CallbacksCard {...p} />);
    await page.getByRole('combobox', { name: 'Filter by outcome' }).click();
    await expect.element(page.getByRole('option', { name: 'All outcomes' })).toBeVisible();
    for (const outcome of CALLBACK_OUTCOMES) {
      await expect.element(page.getByRole('option', { name: OUTCOME_LABELS[outcome].label })).toBeVisible();
    }
    await page.getByRole('option', { name: 'Unsigned' }).click();
    expect(p.onOutcomeFilterChange).toHaveBeenCalledExactlyOnceWith('unsigned');
  });

  it('reports "all outcomes" as no filter', async () => {
    const p = props();
    await renderPanel(<CallbacksCard {...p} outcomeFilter="rejected" />);
    await expect.element(page.getByRole('combobox', { name: 'Filter by outcome' })).toHaveTextContent('Rejected');
    await page.getByRole('combobox', { name: 'Filter by outcome' }).click();
    await page.getByRole('option', { name: 'All outcomes' }).click();
    expect(p.onOutcomeFilterChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('asks to refresh', async () => {
    const p = props();
    await renderPanel(<CallbacksCard {...p} />);
    await page.getByRole('button', { name: 'Refresh callbacks' }).click();
    expect(p.onRefresh).toHaveBeenCalledOnce();
  });

  it('opens the callback when its row is clicked', async () => {
    const p = props();
    await renderPanel(<CallbacksCard {...p} />);
    await page.getByText('pay-aaa').click();
    expect(p.onView).toHaveBeenCalledExactlyOnceWith(verified);
  });

  it('opens the callback once when the row button is clicked, and from the keyboard', async () => {
    const p = props();
    await renderPanel(<CallbacksCard {...p} />);
    const buttons = page.getByRole('button', { name: /open callback/i });
    await buttons.nth(1).click();
    expect(p.onView).toHaveBeenCalledExactlyOnceWith(orphan);
    buttons.nth(0).element().focus();
    await userEvent.keyboard('{Enter}');
    expect(p.onView).toHaveBeenCalledTimes(2);
    expect(p.onView).toHaveBeenLastCalledWith(verified);
  });

  it('names the row button with the text it shows', async () => {
    await renderPanel(<CallbacksCard {...props()} />);
    const row = page.getByRole('row', { name: /pay-aaa/ });
    const shown = row.element().querySelector('time')?.textContent ?? '';
    expect(shown).not.toBe('');
    const button = row.getByRole('button', { name: shown, exact: false });
    await expect.element(button).toBeVisible();
    await expect.element(button).not.toHaveAttribute('aria-label');
    await expect.element(row.getByRole('button', { name: /open callback/i })).toBeVisible();
  });

  it('offers "Load more" only when there is more, and asks for it', async () => {
    const p = props();
    const screen = await renderPanel(<CallbacksCard {...p} />);
    await expect.element(page.getByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await screen.rerender(<CallbacksCard {...p} feed={makeFeed({ items: [verified], hasMore: true })} />);
    await page.getByRole('button', { name: 'Load more' }).click();
    expect(p.onLoadMore).toHaveBeenCalledOnce();
  });

  it('disables "Load more" while a page is being fetched', async () => {
    await renderPanel(<CallbacksCard {...props()} feed={makeFeed({ items: [verified], hasMore: true, loadingMore: true })} />);
    await expect.element(page.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  });
});
