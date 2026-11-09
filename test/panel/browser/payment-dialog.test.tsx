import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { PaymentDialog } from '@/components/PaymentDialog';
import { MODE_NAMES, STATE_LABELS } from '@/lib/labels';
import type { PaymentDetail } from '../../../src/shared/types';
import { defer, makeCallbackDetail, makePaymentDetail } from '../fixtures';
import { apiError, renderPanel, stubApi } from './helpers';

const newest = makeCallbackDetail({
  id: 'cb-new',
  outcome: 'verified',
  deliveries: 2,
  receivedAt: '2026-11-09T09:20:00.000Z',
  lastReceivedAt: '2026-11-09T09:25:00.000Z',
  size: 1536,
  body: '{"validationCode":"abc","response":{"paymentStatus":2}}',
});
const rejected = makeCallbackDetail({
  id: 'cb-old',
  outcome: 'rejected',
  reason: 'The body is not JSON.',
  receivedAt: '2026-11-09T09:10:00.000Z',
  lastReceivedAt: '2026-11-09T09:10:00.000Z',
  size: 15,
  body: 'not json at all',
});
const empty = makeCallbackDetail({
  id: 'cb-empty',
  outcome: 'unsigned',
  receivedAt: '2026-11-09T09:05:00.000Z',
  lastReceivedAt: '2026-11-09T09:05:00.000Z',
  size: 0,
  body: '',
});

const full = makePaymentDetail({
  id: 'pay-1',
  mode: 2,
  paymentAmount: 1234.5,
  customerName: 'Jane Citizen',
  customerEmail: 'jane@example.com',
  customerReference: 'CUST-77',
  state: 'succeeded',
  reference: 'ZP-REF-9',
  gatewayStatus: 2,
  callbackCount: 3,
  // Newest first, as the API sends them.
  callbacks: [newest, rejected, empty],
});

/** The value shown beside a label in the summary grid, read once the dialog has loaded. */
const factValue = (label: string): string | undefined => {
  const term = [...document.querySelectorAll('dt')].find((dt) => dt.textContent === label);
  return term?.nextElementSibling?.textContent ?? undefined;
};

/** The props a dialog test does not care about, with spies for the functions. */
const props = (overrides: Partial<Parameters<typeof PaymentDialog>[0]> = {}) => ({
  id: 'pay-1',
  open: true,
  onOpenChange: vi.fn(),
  onCopy: vi.fn(),
  onDelete: vi.fn(),
  ...overrides,
});

/** Fakes the payment route with the given payment. */
const servePayment = (payment: PaymentDetail) =>
  stubApi((request) => (request.path === `/admin/api/payments/${payment.id}` ? { payment } : undefined));

describe('PaymentDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the payment and shows every field', async () => {
    const { seen } = servePayment(full);
    await renderPanel(<PaymentDialog {...props()} />);
    await expect.element(page.getByRole('dialog')).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Payment', exact: true })).toBeVisible();
    await expect.element(page.getByText('Custom Payment for Jane Citizen.')).toBeVisible();
    expect(seen.map((request) => request.path)).toEqual(['/admin/api/payments/pay-1']);

    expect(factValue('State')).toContain(STATE_LABELS.succeeded.label);
    expect(factValue('State')).toContain(STATE_LABELS.succeeded.hint);
    expect(factValue('Payment ID')).toBe('pay-1');
    expect(factValue('Mode')).toBe(MODE_NAMES[2]);
    expect(factValue('Amount')).toBe('$1,234.50');
    expect(factValue('Customer')).toBe('Jane Citizen');
    expect(factValue('Email')).toBe('jane@example.com');
    expect(factValue('Customer reference')).toBe('CUST-77');
    expect(factValue('ZenPay reference')).toBe('ZP-REF-9');
    expect(factValue('Gateway status')).toBe('2');
    expect(factValue('Callbacks')).toBe('3');
    expect(factValue('Started')).toContain('2026');
    expect(factValue('State changed')).toContain('2026');
  });

  it('lists the callbacks in the order given, newest first, each with its outcome and size', async () => {
    servePayment(full);
    await renderPanel(<PaymentDialog {...props()} />);
    await expect.element(page.getByRole('heading', { name: 'Callbacks' })).toBeVisible();
    const items = page.getByRole('listitem');
    await expect.element(items).toHaveLength(3);
    const [first, second, third] = items.elements();
    expect(first?.textContent).toContain('Verified');
    expect(first?.textContent).toContain('2 deliveries, latest');
    expect(second?.textContent).toContain('Rejected');
    expect(second?.textContent).toContain('Rejected: The body is not JSON.');
    expect(second?.textContent).toContain('1 delivery');
    expect(third?.textContent).toContain('Unsigned');
  });

  it('pretty-prints a JSON body and shows other text as it arrived', async () => {
    servePayment(full);
    await renderPanel(<PaymentDialog {...props()} />);
    const bodies = page.getByRole('region', { name: 'Body' });
    await expect.element(bodies).toHaveLength(3);
    const [json, raw, none] = bodies.elements();
    expect(json?.querySelector('pre')?.textContent).toBe(JSON.stringify(JSON.parse(newest.body), null, 2));
    expect(json?.querySelector('pre')?.textContent).toContain('\n  "validationCode": "abc"');
    expect(raw?.querySelector('pre')?.textContent).toBe('not json at all');
    expect(none?.querySelector('pre')).toBeNull();
    expect(none?.textContent).toContain('The body was empty.');
  });

  it('copies the payment ID, the ZenPay reference and a body', async () => {
    servePayment(full);
    const p = props();
    await renderPanel(<PaymentDialog {...p} />);
    await page.getByRole('button', { name: 'Copy payment ID' }).click();
    expect(p.onCopy).toHaveBeenLastCalledWith('pay-1');
    await page.getByRole('button', { name: 'Copy ZenPay reference' }).click();
    expect(p.onCopy).toHaveBeenLastCalledWith('ZP-REF-9');
    await page.getByRole('button', { name: 'Copy body' }).nth(0).click();
    expect(p.onCopy).toHaveBeenLastCalledWith(JSON.stringify(JSON.parse(newest.body), null, 2));
    await page.getByRole('button', { name: 'Copy body' }).nth(1).click();
    expect(p.onCopy).toHaveBeenLastCalledWith('not json at all');
    expect(p.onCopy).toHaveBeenCalledTimes(4);
    // An empty body has nothing to copy.
    await expect.element(page.getByRole('button', { name: 'Copy body' })).toHaveLength(2);
  });

  it('asks to delete with the payment it loaded, and deletes nothing itself', async () => {
    const { seen } = servePayment(full);
    const p = props();
    await renderPanel(<PaymentDialog {...p} />);
    await page.getByRole('button', { name: 'Delete' }).click();
    expect(p.onDelete).toHaveBeenCalledExactlyOnceWith(full);
    expect(seen.every((request) => request.method === 'GET')).toBe(true);
  });

  it('shows "none yet" for a payment with no reference and offers nothing to copy for it', async () => {
    servePayment(makePaymentDetail({ id: 'pay-1', state: 'pending' }));
    await renderPanel(<PaymentDialog {...props()} />);
    await expect.element(page.getByText('Make Payment for Jane Citizen.')).toBeVisible();
    expect(factValue('ZenPay reference')).toBe('none yet');
    expect(factValue('Gateway status')).toBe('none yet');
    await expect.element(page.getByRole('button', { name: 'Copy ZenPay reference' })).not.toBeInTheDocument();
    await expect.element(page.getByText('No callbacks yet.')).toBeVisible();
  });

  it('says it is loading until the answer arrives', async () => {
    const answer = defer<{ payment: PaymentDetail }>();
    stubApi(() => answer.promise);
    await renderPanel(<PaymentDialog {...props()} />);
    await expect.element(page.getByText('Loading…')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    answer.resolve({ payment: full });
    await expect.element(page.getByText('Custom Payment for Jane Citizen.')).toBeVisible();
  });

  it('says the payment could not load when the API fails', async () => {
    stubApi(() => apiError('Payment not found', 404));
    await renderPanel(<PaymentDialog {...props()} />);
    await expect.element(page.getByText('Could not load this payment. It may have been deleted.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('fetches nothing while it is closed or has no payment', async () => {
    const { fetchSpy } = servePayment(full);
    const screen = await renderPanel(<PaymentDialog {...props({ open: false })} />);
    await screen.rerender(<PaymentDialog {...props({ open: true, id: null })} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    await expect.element(page.getByText('Loading…')).toBeVisible();
  });

  it('shows Loading, not the old payment, when the ID changes, and ignores an answer that arrives late', async () => {
    const second = makePaymentDetail({ id: 'pay-2', customerName: 'Sam Smith', mode: 0 });
    const firstAnswer = defer<{ payment: PaymentDetail }>();
    const secondAnswer = defer<{ payment: PaymentDetail }>();
    stubApi((request) =>
      request.path.endsWith('/pay-1') ? firstAnswer.promise : request.path.endsWith('/pay-2') ? secondAnswer.promise : undefined,
    );
    const screen = await renderPanel(<PaymentDialog {...props()} />);
    await screen.rerender(<PaymentDialog {...props({ id: 'pay-2' })} />);
    secondAnswer.resolve({ payment: second });
    await expect.element(page.getByText('Make Payment for Sam Smith.')).toBeVisible();
    firstAnswer.resolve({ payment: full });
    await expect.poll(() => factValue('Payment ID')).toBe('pay-2');
    await expect.element(page.getByText('Custom Payment for Jane Citizen.')).not.toBeInTheDocument();
  });

  it('shows Loading while the next payment loads, rather than the previous one', async () => {
    const second = makePaymentDetail({ id: 'pay-2', customerName: 'Sam Smith' });
    const secondAnswer = defer<{ payment: PaymentDetail }>();
    stubApi((request) => (request.path.endsWith('/pay-1') ? { payment: full } : secondAnswer.promise));
    const screen = await renderPanel(<PaymentDialog {...props()} />);
    await expect.element(page.getByText('Custom Payment for Jane Citizen.')).toBeVisible();
    await screen.rerender(<PaymentDialog {...props({ id: 'pay-2' })} />);
    await expect.element(page.getByText('Loading…')).toBeVisible();
    await expect.element(page.getByText('Custom Payment for Jane Citizen.')).not.toBeInTheDocument();
    secondAnswer.resolve({ payment: second });
    await expect.element(page.getByText('Make Payment for Sam Smith.')).toBeVisible();
  });

  it('reports a close from the close button and from Escape', async () => {
    servePayment(full);
    const p = props();
    await renderPanel(<PaymentDialog {...p} />);
    await expect.element(page.getByText('Custom Payment for Jane Citizen.')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    expect(p.onOpenChange).toHaveBeenCalledTimes(1);
    expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
    await userEvent.keyboard('{Escape}');
    expect(p.onOpenChange).toHaveBeenCalledTimes(2);
    expect(p.onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
