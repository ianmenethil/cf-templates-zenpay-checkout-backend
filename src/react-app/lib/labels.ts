import type { CallbackOutcome, PaymentMode, PaymentState } from "../../shared/types";

/** The name ZenPay's plugin gives each mode. */
export const MODE_NAMES: Record<PaymentMode, string> = {
  0: "Make Payment",
  1: "Tokenise",
  2: "Custom Payment",
  3: "Preauthorisation",
};

/** How the panel names each payment state, and what it means. */
export const STATE_LABELS: Record<PaymentState, { label: string; hint: string }> = {
  pending: { label: "Pending", hint: "Started; no callback has arrived yet." },
  unverified: {
    label: "Unverified",
    hint: "Only unsigned callbacks arrived, which cannot be trusted, so nothing is fulfilled.",
  },
  processing: {
    label: "Processing",
    hint: "A verified callback says ZenPay is still working on it.",
  },
  succeeded: {
    label: "Succeeded",
    hint: "A verified callback says it succeeded.",
  },
  failed: {
    label: "Failed",
    hint: "A verified callback says it failed, errored, was cancelled or was suppressed.",
  },
};

/** What the panel shows for a callback that has no payment, and why that can be. */
export const NO_PAYMENT = {
  label: "No payment",
  hint: "The callback address token could not be read, or it was valid but the payment it names no longer exists.",
};

/** How the panel names each callback outcome, and what it means. */
export const OUTCOME_LABELS: Record<CallbackOutcome, { label: string; hint: string }> = {
  verified: {
    label: "Verified",
    hint: "The callback address token and the validation code both check out.",
  },
  unsigned: {
    label: "Unsigned",
    hint: "The token checks out but the body has no validation code; a notification only.",
  },
  rejected: {
    label: "Rejected",
    hint: "Rejected for one of these reasons: the callback address token is missing, changed or expired; the payment it names does not exist; the body is not JSON; the payment ID in the body differs from the one in the address; the validation code is not text or is wrong; or, for Custom Payment, the amount charged differs from the amount the payment started with.",
  },
};
