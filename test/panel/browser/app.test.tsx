import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { App } from '@/App';
import type { CallbackDetail, CallbackRecord, PaymentDetail, PaymentSummary } from '../../../src/shared/types';
import { defer, isoAgo, makeCallbackDetail, makePaymentDetail } from '../fixtures';
import { apiError, noContent, renderPanel, stubApi, type Seen } from './helpers';

const callbackOne = makeCallbackDetail({ id: 'cb-1', paymentId: 'pay-jane', outcome: 'verified', receivedAt: isoAgo(60_000) });
const callbackTwo = makeCallbackDetail({
  id: 'cb-2',
  paymentId: null,
  outcome: 'rejected',
  reason: 'The callback address has no token.',
  body: 'not json',
  receivedAt: isoAgo(120_000),
});

const jane = makePaymentDetail({
  id: 'pay-jane',
  customerName: 'Jane Citizen',
  customerEmail: 'jane@example.com',
  state: 'succeeded',
  reference: 'ZP-REF-1',
  callbackCount: 2,
  createdAt: isoAgo(3_600_000),
  callbacks: [callbackOne],
});
const sam = makePaymentDetail({
  id: 'pay-sam',
  customerName: 'Sam Smith',
  customerEmail: 'sam@example.com',
  state: 'pending',
  callbackCount: 0,
  createdAt: isoAgo(7_200_000),
});

/** A copy of an object without one of its fields. */
const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
};

/** A payment as the list shows it, without its callbacks. */
const summary = (payment: PaymentDetail): PaymentSummary => without(payment, 'callbacks');

/** A callback as the list shows it, without its body. */
const record = (callback: CallbackDetail): CallbackRecord => without(callback, 'body');

/**
 * Fakes the whole admin API with data a test can change while it runs.
 * @param options - `fail` makes the named route answer with an error.
 * @returns The request log and the data.
 */
const fakeApi = (
  options: { fail?: 'me' | 'delete' | 'morePayments' | 'moreCallbacks'; paged?: boolean; profile?: Promise<unknown> } = {},
) => {
  const data = { payments: [jane, sam], callbacks: [callbackOne, callbackTwo] };
  const api = stubApi((request) => {
    const { method, path, query } = request;
    if (path === '/admin/api/me') {
      return options.profile ?? (options.fail === 'me' ? apiError('No profile') : { email: 'ian@example.com', brand: 'Acme' });
    }
    if (path === '/admin/api/payments' && method === 'GET') {
      if (query.get('before') === 'cursor-p') {
        return options.fail === 'morePayments' ? apiError('Boom') : { payments: [summary(sam)], nextBefore: null };
      }
      const wanted = data.payments.filter((payment) => !query.get('state') || payment.state === query.get('state'));
      const found = wanted.filter(
        (payment) => !query.get('q') || payment.customerName.toLowerCase().includes(query.get('q')?.toLowerCase() ?? ''),
      );
      return options.paged ? { payments: [summary(jane)], nextBefore: 'cursor-p' } : { payments: found.map(summary), nextBefore: null };
    }
    if (path === '/admin/api/callbacks' && method === 'GET') {
      if (query.get('before') === 'cursor-c') {
        return options.fail === 'moreCallbacks' ? apiError('Boom') : { callbacks: [record(callbackTwo)], nextBefore: null };
      }
      const wanted = data.callbacks.filter((callback) => !query.get('outcome') || callback.outcome === query.get('outcome'));
      return options.paged
        ? { callbacks: [record(callbackOne)], nextBefore: 'cursor-c' }
        : { callbacks: wanted.map(record), nextBefore: null };
    }
    const payment = data.payments.find((candidate) => path === `/admin/api/payments/${candidate.id}`);
    if (payment && method === 'GET') {
      return { payment };
    }
    if (payment && method === 'DELETE') {
      if (options.fail === 'delete') {
        return apiError('Could not delete');
      }
      data.payments = data.payments.filter((candidate) => candidate.id !== payment.id);
      data.callbacks = data.callbacks.filter((callback) => callback.paymentId !== payment.id);
      return noContent();
    }
    const callback = data.callbacks.find((candidate) => path === `/admin/api/callbacks/${candidate.id}`);
    if (callback && method === 'GET') {
      return { callback };
    }
    return undefined;
  });
  return { ...api, data };
};

/** The `<title>` elements Vitest's own page already has; the app is not responsible for them. */
const testerTitles = new Set(document.querySelectorAll('title'));

/** The text of every `<title>` the app put on the page. */
const titles = (): (string | null)[] =>
  [...document.querySelectorAll('title')].filter((title) => !testerTitles.has(title)).map((title) => title.textContent);

/** How many requests for the given method and path the fake API has seen. */
const count = (seen: Seen[], method: string, path: string): number =>
  seen.filter((request) => request.method === method && request.path === path).length;

/** Lets a test choose whether the clipboard accepts text. */
const fakeClipboard = (accepts: boolean) => {
  const writeText = vi.fn(() => (accepts ? Promise.resolve() : Promise.reject(new Error('denied'))));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
};

describe('App', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('loads the profile, sets the page title and fills both lists', async () => {
    fakeApi();
    await renderPanel(<App />);
    await expect.element(page.getByText('ian@example.com')).toBeVisible();
    await expect.poll(() => document.title).toBe('Acme checkout');
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();
    await expect.element(page.getByRole('row', { name: /The callback address has no token/ })).toBeVisible();
    await expect.element(page.getByRole('region', { name: 'Payments' })).toBeVisible();
    await expect.element(page.getByRole('region', { name: 'Callbacks' })).toBeVisible();
  });

  it('keeps one title on the page: neutral until the profile loads, then named for the brand', async () => {
    const profile = defer<{ email: string; brand: string }>();
    fakeApi({ profile: profile.promise });
    await renderPanel(<App />);
    await expect.poll(titles).toEqual(['ZenPay checkout']);
    expect(document.title).toBe('ZenPay checkout');
    profile.resolve({ email: 'ian@example.com', brand: 'Acme' });
    await expect.poll(titles).toEqual(['Acme checkout']);
    expect(document.title).toBe('Acme checkout');
  });

  it('keeps the neutral title when the profile cannot load', async () => {
    fakeApi({ fail: 'me' });
    await renderPanel(<App />);
    await expect.element(page.getByText('Could not load your profile. Refresh the page to try again.')).toBeVisible();
    expect(titles()).toEqual(['ZenPay checkout']);
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
  });

  it('filters the payments by state and the callbacks by outcome', async () => {
    const { seen } = fakeApi();
    await renderPanel(<App />);
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();

    await page.getByRole('combobox', { name: 'Filter by state' }).click();
    await page.getByRole('option', { name: 'Succeeded' }).click();
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
    expect(
      seen
        .filter((request) => request.path === '/admin/api/payments')
        .at(-1)
        ?.query.get('state'),
    ).toBe('succeeded');

    await page.getByRole('combobox', { name: 'Filter by outcome' }).click();
    await page.getByRole('option', { name: 'Rejected' }).click();
    await expect.element(page.getByRole('row', { name: /pay-jane/ })).not.toBeInTheDocument();
    expect(
      seen
        .filter((request) => request.path === '/admin/api/callbacks')
        .at(-1)
        ?.query.get('outcome'),
    ).toBe('rejected');
  });

  it('searches after a pause in typing', async () => {
    const { seen } = fakeApi();
    await renderPanel(<App />);
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();
    const before = count(seen, 'GET', '/admin/api/payments');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await page.getByRole('searchbox', { name: 'Search payments' }).fill('  sam ');
    vi.advanceTimersByTime(299);
    expect(count(seen, 'GET', '/admin/api/payments')).toBe(before);
    vi.advanceTimersByTime(1);
    await expect.poll(() => count(seen, 'GET', '/admin/api/payments')).toBe(before + 1);
    expect(
      seen
        .filter((request) => request.path === '/admin/api/payments')
        .at(-1)
        ?.query.get('q'),
    ).toBe('sam');
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).not.toBeInTheDocument();
  });

  it('refreshes each list on its own', async () => {
    const { seen } = fakeApi();
    await renderPanel(<App />);
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh callbacks' }).click();
    await expect.poll(() => count(seen, 'GET', '/admin/api/callbacks')).toBe(2);
    expect(count(seen, 'GET', '/admin/api/payments')).toBe(1);
    await page.getByRole('button', { name: 'Refresh payments' }).click();
    await expect.poll(() => count(seen, 'GET', '/admin/api/payments')).toBe(2);
  });

  it('opens a payment from its row and shows its callbacks', async () => {
    const { seen } = fakeApi();
    await renderPanel(<App />);
    await page
      .getByRole('row', { name: /Jane Citizen/ })
      .getByText('jane@example.com')
      .click();
    const dialog = page.getByRole('dialog');
    await expect.element(dialog.getByText('Make Payment for Jane Citizen.')).toBeVisible();
    expect(count(seen, 'GET', '/admin/api/payments/pay-jane')).toBe(1);
    await expect.element(dialog.getByRole('listitem')).toHaveLength(1);
  });

  it('opens a callback, then the payment it belongs to, closing the callback', async () => {
    fakeApi();
    await renderPanel(<App />);
    await page
      .getByRole('row', { name: /pay-jane/ })
      .getByText('pay-jane')
      .click();
    await expect.element(page.getByRole('heading', { name: 'Callback', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open payment' }).click();
    await expect.element(page.getByText('Make Payment for Jane Citizen.')).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Callback', exact: true })).not.toBeInTheDocument();
  });

  it('asks before deleting, deletes only after the yes, refreshes both lists and says so', async () => {
    const { seen } = fakeApi();
    await renderPanel(<App />);
    await page
      .getByRole('row', { name: /Jane Citizen/ })
      .getByText('jane@example.com')
      .click();
    await expect.element(page.getByText('Make Payment for Jane Citizen.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete' }).click();

    const confirm = page.getByRole('alertdialog');
    await expect.element(confirm.getByRole('heading', { name: 'Delete this payment?' })).toBeVisible();
    await expect
      .element(confirm.getByText('The payment for Jane Citizen and its 2 callbacks will be deleted. This cannot be undone.'))
      .toBeVisible();
    await expect.element(page.getByText('Make Payment for Jane Citizen.')).not.toBeInTheDocument();
    expect(count(seen, 'DELETE', '/admin/api/payments/pay-jane')).toBe(0);

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(count(seen, 'DELETE', '/admin/api/payments/pay-jane')).toBe(0);
    expect(count(seen, 'GET', '/admin/api/payments')).toBe(1);

    await page
      .getByRole('row', { name: /Jane Citizen/ })
      .getByText('jane@example.com')
      .click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();

    await expect.element(page.getByText('Deleted the payment and its callbacks')).toBeVisible();
    expect(count(seen, 'DELETE', '/admin/api/payments/pay-jane')).toBe(1);
    await expect.poll(() => count(seen, 'GET', '/admin/api/payments')).toBe(2);
    await expect.poll(() => count(seen, 'GET', '/admin/api/callbacks')).toBe(2);
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).not.toBeInTheDocument();
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();
    await expect.element(page.getByRole('row', { name: /The callback address has no token/ })).toBeVisible();
  });

  it('tells the person a delete failed and leaves the lists alone', async () => {
    const { seen } = fakeApi({ fail: 'delete' });
    await renderPanel(<App />);
    await page
      .getByRole('row', { name: /Sam Smith/ })
      .getByText('sam@example.com')
      .click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect.element(page.getByText('The payment for Sam Smith and its 0 callbacks', { exact: false })).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect.element(page.getByText('Could not delete the payment')).toBeVisible();
    expect(count(seen, 'GET', '/admin/api/payments')).toBe(1);
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();
  });

  it('loads more payments and more callbacks', async () => {
    const { seen } = fakeApi({ paged: true });
    await renderPanel(<App />);
    await expect.element(page.getByRole('row', { name: /Jane Citizen/ })).toBeVisible();
    expect(page.getByRole('row', { name: /Sam Smith/ }).elements()).toHaveLength(0);

    await page.getByRole('region', { name: 'Payments' }).getByRole('button', { name: 'Load more' }).click();
    await expect.element(page.getByRole('row', { name: /Sam Smith/ })).toBeVisible();
    expect(seen.find((request) => request.query.get('before') === 'cursor-p')).toBeDefined();
    await expect.element(page.getByRole('region', { name: 'Payments' }).getByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    await page.getByRole('region', { name: 'Callbacks' }).getByRole('button', { name: 'Load more' }).click();
    await expect.element(page.getByRole('row', { name: /The callback address has no token/ })).toBeVisible();
    expect(seen.find((request) => request.query.get('before') === 'cursor-c')).toBeDefined();
  });

  it('tells the person when more payments could not be loaded', async () => {
    fakeApi({ paged: true, fail: 'morePayments' });
    await renderPanel(<App />);
    await page.getByRole('region', { name: 'Payments' }).getByRole('button', { name: 'Load more' }).click();
    await expect.element(page.getByText('Could not load more payments')).toBeVisible();
    await expect.element(page.getByRole('region', { name: 'Payments' }).getByRole('button', { name: 'Load more' })).toBeEnabled();
  });

  it('tells the person when more callbacks could not be loaded', async () => {
    fakeApi({ paged: true, fail: 'moreCallbacks' });
    await renderPanel(<App />);
    await page.getByRole('region', { name: 'Callbacks' }).getByRole('button', { name: 'Load more' }).click();
    await expect.element(page.getByText('Could not load more callbacks')).toBeVisible();
  });

  it('copies text and says it did', async () => {
    fakeApi();
    const writeText = fakeClipboard(true);
    await renderPanel(<App />);
    await page
      .getByRole('row', { name: /Jane Citizen/ })
      .getByText('jane@example.com')
      .click();
    await page.getByRole('button', { name: 'Copy payment ID' }).click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('pay-jane');
    await expect.element(page.getByText('Copied to clipboard')).toBeVisible();
  });

  it('says so when the clipboard refuses', async () => {
    fakeApi();
    fakeClipboard(false);
    await renderPanel(<App />);
    await page
      .getByRole('row', { name: /Jane Citizen/ })
      .getByText('jane@example.com')
      .click();
    await page.getByRole('button', { name: 'Copy payment ID' }).click();
    await expect.element(page.getByText('Could not copy; select the text and copy it manually')).toBeVisible();
  });
});
