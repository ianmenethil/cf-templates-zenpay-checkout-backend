import type {
  AdminProfile,
  CallbackDetail,
  CallbackList,
  CallbackOutcome,
  CallbackRecord,
  CallbackResponse,
  PaymentDetail,
  PaymentList,
  PaymentResponse,
  PaymentState,
  PaymentSummary,
} from "../../shared/types";

/** One page of a newest-first list. */
export type Page<T> = {
  items: T[];
  /** Pass as `before` to get the next page; `null` when there are no more. */
  nextBefore: string | null;
};

/**
 * Calls the admin API and reads its JSON answer.
 * @param path - Path below `/admin/api`.
 * @param init - Request options.
 * @returns The parsed answer, or `undefined` for an empty `204`.
 * @throws An `Error` whose message is the API's `error` field when it has one, to show the person.
 */
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/admin/api${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `The request failed (${response.status}).`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
};

/**
 * Writes the query string for a list request, leaving out what is empty.
 * @param values - The filters and the cursor; an empty or missing one is left out.
 * @returns The query string with its leading `?`, or an empty string when nothing is set.
 */
const queryString = (values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value) params.set(name, value);
  }
  return params.size > 0 ? `?${params}` : "";
};

/**
 * Gets the signed-in user and the brand name.
 * @returns The signed-in user's email and the brand name.
 */
export const getProfile = (): Promise<AdminProfile> => request("/me");

/** Filters for {@link getPayments}. */
export type PaymentQuery = {
  /** Only payments in this state. */
  state?: PaymentState;
  /** Only payments whose ID, customer, reference or ZenPay reference contains this text. */
  q?: string;
};

/**
 * Gets one page of payments, newest first.
 * @param query - The filters; left out, everything.
 * @param before - The `nextBefore` of the previous page; left out, the first page.
 * @returns The payments on that page and the cursor for the next one.
 */
export const getPayments = async ({ state, q }: PaymentQuery, before?: string): Promise<Page<PaymentSummary>> => {
  const list = await request<PaymentList>(`/payments${queryString({ state, q, before })}`);
  return { items: list.payments, nextBefore: list.nextBefore };
};

/**
 * Gets one payment with all its callbacks.
 * @param id - The payment to read.
 * @returns The payment with its callbacks, newest first.
 */
export const getPayment = async (id: string): Promise<PaymentDetail> =>
  (await request<PaymentResponse>(`/payments/${encodeURIComponent(id)}`)).payment;

/**
 * Deletes a payment and its callbacks.
 * @param id - The payment to delete.
 * @returns Nothing; it resolves once the payment is gone.
 */
export const deletePayment = (id: string): Promise<void> => request(`/payments/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Filters for {@link getCallbacks}. */
export type CallbackQuery = {
  /** Only callbacks with this outcome. */
  outcome?: CallbackOutcome;
};

/**
 * Gets one page of callbacks, newest first.
 * @param query - The filters; left out, everything.
 * @param before - The `nextBefore` of the previous page; left out, the first page.
 * @returns The callbacks on that page and the cursor for the next one.
 */
export const getCallbacks = async ({ outcome }: CallbackQuery, before?: string): Promise<Page<CallbackRecord>> => {
  const list = await request<CallbackList>(`/callbacks${queryString({ outcome, before })}`);
  return { items: list.callbacks, nextBefore: list.nextBefore };
};

/**
 * Gets one callback with its body.
 * @param id - The callback to read.
 * @returns The callback with its body.
 */
export const getCallback = async (id: string): Promise<CallbackDetail> =>
  (await request<CallbackResponse>(`/callbacks/${encodeURIComponent(id)}`)).callback;
