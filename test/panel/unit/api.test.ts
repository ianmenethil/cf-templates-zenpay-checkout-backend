import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deletePayment, getCallback, getCallbacks, getPayment, getPayments, getProfile } from '@/lib/api';
import { addressOf, makeCallback, makeCallbackDetail, makePayment, makePaymentDetail } from '../fixtures';

const fetchMock = vi.fn<typeof fetch>();

/** The address of the latest request, split so the query can be read without caring about its order. */
const lastRequest = (): { path: string; query: URLSearchParams; init: RequestInit | undefined } => {
  const call = fetchMock.mock.lastCall;
  if (!call) {
    throw new Error('fetch was not called');
  }
  const url = new URL(addressOf(call[0]), 'https://admin.test');
  return { path: url.pathname, query: url.searchParams, init: call[1] };
};

/** The address of the latest request exactly as written, to see how the path is encoded. */
const lastAddress = (): string => {
  const call = fetchMock.mock.lastCall;
  if (!call) {
    throw new Error('fetch was not called');
  }
  return addressOf(call[0]);
};

describe('the admin API client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getProfile', () => {
    it('reads /admin/api/me', async () => {
      fetchMock.mockResolvedValue(Response.json({ email: 'ian@example.com', brand: 'Acme' }));
      await expect(getProfile()).resolves.toEqual({ email: 'ian@example.com', brand: 'Acme' });
      expect(lastRequest().path).toBe('/admin/api/me');
    });
  });

  describe('getPayments', () => {
    it('asks for the bare path when no filter is set', async () => {
      fetchMock.mockResolvedValue(Response.json({ payments: [], nextBefore: null }));
      await getPayments({});
      expect(lastAddress()).toBe('/admin/api/payments');
    });

    it('leaves out empty and missing values', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(Response.json({ payments: [], nextBefore: null })));
      await getPayments({ state: undefined, q: '' }, '');
      expect(lastAddress()).toBe('/admin/api/payments');
      await getPayments({ state: 'failed', q: '' });
      expect(lastAddress()).toBe('/admin/api/payments?state=failed');
    });

    it('sends the state, the text and the cursor, encoded', async () => {
      fetchMock.mockResolvedValue(Response.json({ payments: [], nextBefore: null }));
      await getPayments({ state: 'succeeded', q: 'jane & co/é' }, '2026-11-09T09:00:00.000Z|pay 1');
      const { path, query } = lastRequest();
      expect(path).toBe('/admin/api/payments');
      expect(query.get('state')).toBe('succeeded');
      expect(query.get('q')).toBe('jane & co/é');
      expect(query.get('before')).toBe('2026-11-09T09:00:00.000Z|pay 1');
      expect(lastAddress()).not.toContain(' ');
      expect(lastAddress()).not.toContain('&co');
    });

    it('maps the answer to items and nextBefore', async () => {
      const payment = makePayment();
      fetchMock.mockResolvedValue(Response.json({ payments: [payment], nextBefore: 'cursor-2' }));
      await expect(getPayments({})).resolves.toEqual({ items: [payment], nextBefore: 'cursor-2' });
    });

    it('keeps a null nextBefore as null', async () => {
      fetchMock.mockResolvedValue(Response.json({ payments: [], nextBefore: null }));
      await expect(getPayments({})).resolves.toEqual({ items: [], nextBefore: null });
    });
  });

  describe('getPayment', () => {
    it('encodes the ID in the path and unwraps the payment', async () => {
      const payment = makePaymentDetail({ id: 'a/b c?d' });
      fetchMock.mockResolvedValue(Response.json({ payment }));
      await expect(getPayment('a/b c?d')).resolves.toEqual(payment);
      expect(lastAddress()).toBe('/admin/api/payments/a%2Fb%20c%3Fd');
    });
  });

  describe('deletePayment', () => {
    it('sends DELETE for the encoded ID and returns nothing for a 204', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await expect(deletePayment('a/b')).resolves.toBeUndefined();
      expect(lastAddress()).toBe('/admin/api/payments/a%2Fb');
      expect(lastRequest().init?.method).toBe('DELETE');
    });
  });

  describe('getCallbacks', () => {
    it('asks for the bare path when no filter is set', async () => {
      fetchMock.mockResolvedValue(Response.json({ callbacks: [], nextBefore: null }));
      await getCallbacks({});
      expect(lastAddress()).toBe('/admin/api/callbacks');
    });

    it('sends the outcome and the cursor', async () => {
      fetchMock.mockResolvedValue(Response.json({ callbacks: [], nextBefore: null }));
      await getCallbacks({ outcome: 'rejected' }, 'cursor 1');
      const { path, query } = lastRequest();
      expect(path).toBe('/admin/api/callbacks');
      expect(query.get('outcome')).toBe('rejected');
      expect(query.get('before')).toBe('cursor 1');
    });

    it('maps the answer to items and nextBefore', async () => {
      const callback = makeCallback();
      fetchMock.mockResolvedValue(Response.json({ callbacks: [callback], nextBefore: 'cursor-2' }));
      await expect(getCallbacks({})).resolves.toEqual({ items: [callback], nextBefore: 'cursor-2' });
    });
  });

  describe('getCallback', () => {
    it('encodes the ID in the path and unwraps the callback', async () => {
      const callback = makeCallbackDetail({ id: 'x y/z' });
      fetchMock.mockResolvedValue(Response.json({ callback }));
      await expect(getCallback('x y/z')).resolves.toEqual(callback);
      expect(lastAddress()).toBe('/admin/api/callbacks/x%20y%2Fz');
    });
  });

  describe('errors', () => {
    it("throws the API's own message", async () => {
      fetchMock.mockResolvedValue(Response.json({ error: 'Payment not found' }, { status: 404 }));
      await expect(getPayment('nope')).rejects.toThrow('Payment not found');
    });

    it('throws the API message on a failed delete too', async () => {
      fetchMock.mockResolvedValue(Response.json({ error: 'Not allowed' }, { status: 403 }));
      await expect(deletePayment('pay-1')).rejects.toThrow('Not allowed');
    });

    it('falls back to the status when the body is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
      await expect(getProfile()).rejects.toThrow('The request failed (502).');
    });

    it('falls back to the status when the JSON has no error field', async () => {
      fetchMock.mockResolvedValue(Response.json({ message: 'nope' }, { status: 500 }));
      await expect(getCallbacks({})).rejects.toThrow('The request failed (500).');
    });

    it('falls back to the status when the JSON body is null', async () => {
      fetchMock.mockResolvedValue(new Response('null', { status: 401 }));
      await expect(getProfile()).rejects.toThrow('The request failed (401).');
    });

    it('lets a network failure through', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await expect(getProfile()).rejects.toThrow('Failed to fetch');
    });
  });
});
