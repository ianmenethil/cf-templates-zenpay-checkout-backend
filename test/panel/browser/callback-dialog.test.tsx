import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { CallbackDialog } from '@/components/CallbackDialog';
import { NO_PAYMENT, OUTCOME_LABELS } from '@/lib/labels';
import type { CallbackDetail } from '../../../src/shared/types';
import { defer, makeCallbackDetail } from '../fixtures';
import { apiError, renderPanel, stubApi } from './helpers';

/** The value shown beside a label in the summary grid. */
const factValue = (label: string): string | undefined => {
  const term = [...document.querySelectorAll('dt')].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent ?? undefined;
};

/** The props a dialog test does not care about, with spies for the functions. */
const props = (overrides: Partial<Parameters<typeof CallbackDialog>[0]> = {}) => ({
  id: 'cb-1',
  open: true,
  onOpenChange: vi.fn(),
  onCopy: vi.fn(),
  onOpenPayment: vi.fn(),
  ...overrides,
});

/** Fakes the callback route with the given callback. */
const serveCallback = (callback: CallbackDetail) =>
  stubApi((request) => (request.path === `/admin/api/callbacks/${callback.id}` ? { callback } : undefined));

describe('CallbackDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the outcome, the payment, the times, the size and the body', async () => {
    const callback = makeCallbackDetail({
      id: 'cb-1',
      paymentId: 'pay-77',
      outcome: 'verified',
      deliveries: 3,
      size: 2048,
      body: '{"a":1}',
      receivedAt: '2026-11-09T09:10:00.000Z',
      lastReceivedAt: '2026-11-09T09:40:00.000Z',
    });
    const { seen } = serveCallback(callback);
    await renderPanel(<CallbackDialog {...props()} />);
    await expect.element(page.getByText(OUTCOME_LABELS.verified.hint, { exact: true }).first()).toBeVisible();
    expect(seen.map((request) => request.path)).toEqual(['/admin/api/callbacks/cb-1']);
    expect(factValue('Outcome')).toBe('Verified');
    expect(factValue('Payment ID')).toBe('pay-77');
    expect(factValue('Received')).toContain('2026');
    expect(factValue('Deliveries')).toContain('3 deliveries');
    expect(factValue('Deliveries')).toContain('latest');
    expect(factValue('Size')).toMatch(/^2/);
    expect(factValue('Reason')).toBeUndefined();
    const body = page.getByRole('region', { name: 'Body' }).element().querySelector('pre');
    expect(body?.textContent).toBe('{\n  "a": 1\n}');
  });

  it('shows the reason of a rejected callback', async () => {
    serveCallback(makeCallbackDetail({ outcome: 'rejected', reason: 'The body is not JSON.', body: 'oops', deliveries: 1 }));
    await renderPanel(<CallbackDialog {...props()} />);
    await expect.element(page.getByText(OUTCOME_LABELS.rejected.hint)).toBeVisible();
    expect(factValue('Reason')).toBe('The body is not JSON.');
    expect(factValue('Deliveries')).toBe('1 delivery');
  });

  it('opens its payment from the button', async () => {
    serveCallback(makeCallbackDetail({ paymentId: 'pay-77' }));
    const p = props();
    await renderPanel(<CallbackDialog {...p} />);
    await page.getByRole('button', { name: 'Open payment' }).click();
    expect(p.onOpenPayment).toHaveBeenCalledExactlyOnceWith('pay-77');
  });

  it('says "No payment" and offers no "Open payment" when the callback has none', async () => {
    serveCallback(makeCallbackDetail({ paymentId: null, outcome: 'rejected', reason: 'The callback address has no token.' }));
    await renderPanel(<CallbackDialog {...props()} />);
    const note = page.getByText(NO_PAYMENT.label, { exact: true });
    await expect.element(note).toBeVisible();
    await expect.element(note).toHaveAttribute('title', NO_PAYMENT.hint);
    expect(factValue('Payment ID')).toBe(NO_PAYMENT.label);
    await expect.element(page.getByRole('button', { name: 'Open payment' })).not.toBeInTheDocument();
  });

  it('shows an empty body as empty and offers nothing to copy', async () => {
    serveCallback(makeCallbackDetail({ body: '', size: 0, outcome: 'unsigned' }));
    await renderPanel(<CallbackDialog {...props()} />);
    await expect.element(page.getByText('The body was empty.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Copy body' })).not.toBeInTheDocument();
  });

  it('copies the body as it is shown', async () => {
    serveCallback(makeCallbackDetail({ body: 'plain text body' }));
    const p = props();
    await renderPanel(<CallbackDialog {...p} />);
    await page.getByRole('button', { name: 'Copy body' }).click();
    expect(p.onCopy).toHaveBeenCalledExactlyOnceWith('plain text body');
  });

  it('says it is loading until the answer arrives', async () => {
    const answer = defer<{ callback: CallbackDetail }>();
    stubApi(() => answer.promise);
    await renderPanel(<CallbackDialog {...props()} />);
    await expect.element(page.getByText('Loading…')).toBeVisible();
    answer.resolve({ callback: makeCallbackDetail({ outcome: 'unsigned' }) });
    await expect.element(page.getByText(OUTCOME_LABELS.unsigned.hint)).toBeVisible();
  });

  it('says the callback could not load when the API fails', async () => {
    stubApi(() => apiError('Callback not found', 404));
    await renderPanel(<CallbackDialog {...props()} />);
    await expect.element(page.getByText('Could not load this callback. It may have been deleted.')).toBeVisible();
  });

  it('fetches nothing while it is closed or has no callback', async () => {
    const { fetchSpy } = serveCallback(makeCallbackDetail());
    const screen = await renderPanel(<CallbackDialog {...props({ open: false })} />);
    await screen.rerender(<CallbackDialog {...props({ id: null })} />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows Loading, not the old callback, when the ID changes', async () => {
    const secondAnswer = defer<{ callback: CallbackDetail }>();
    stubApi((request) =>
      request.path.endsWith('/cb-1') ? { callback: makeCallbackDetail({ paymentId: 'pay-first' }) } : secondAnswer.promise,
    );
    const screen = await renderPanel(<CallbackDialog {...props()} />);
    await expect.element(page.getByText('pay-first')).toBeVisible();
    await screen.rerender(<CallbackDialog {...props({ id: 'cb-2' })} />);
    await expect.element(page.getByText('Loading…')).toBeVisible();
    await expect.element(page.getByText('pay-first')).not.toBeInTheDocument();
    secondAnswer.resolve({ callback: makeCallbackDetail({ id: 'cb-2', paymentId: 'pay-second' }) });
    await expect.element(page.getByText('pay-second')).toBeVisible();
  });
});
