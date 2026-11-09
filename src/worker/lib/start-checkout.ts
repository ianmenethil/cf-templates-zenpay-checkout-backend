import { z } from 'zod';
import type { PaymentMode } from '../../shared/types';

/** Longest customer name and customer reference accepted. */
const MAX_NAME_LENGTH = 100;

/** Longest email address accepted, as set by the email standard. */
const MAX_EMAIL_LENGTH = 254;

/** Largest amount accepted, in dollars; a guard against typos, not a business limit. */
const MAX_AMOUNT = 10_000_000;

/** A non-negative number with at most two decimals, as ZenPay hashes it (the same rule as `@zp-hcp/server`). */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

/** One `@`, no spaces, a dot in the domain. ZenPay's own check (`ZpAuthoriseRequestSchema`) runs again on the launch. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is said when the body is not a JSON object. */
const NOT_AN_OBJECT_MESSAGE = 'The request body must be a JSON object.';

/** What is said when `mode` is missing or is not one of the plugin's four. */
const MODE_MESSAGE = 'mode must be 0, 1, 2 or 3.';

/** What is said when `paymentAmount` is not a usable number of dollars. */
const AMOUNT_MESSAGE = 'paymentAmount must be a number of dollars with at most 2 decimals.';

/**
 * Tells whether a value is a JSON object.
 * @param value - Anything.
 * @returns `true` for a non-null, non-array object.
 */
const isJsonObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Tells whether text holds a control character, which has no place in a name, email or reference.
 * @param text - The text to check.
 * @returns `true` when it holds one.
 */
const hasControlCharacter = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * The schema of a text field: trimmed, within its length, with no control character.
 * @param name - The field's name, for the messages.
 * @param maxLength - Longest allowed length.
 * @param required - Whether it may not be empty.
 * @returns The schema.
 */
const textField = (name: string, maxLength: number, required: boolean) => {
  const trimmed = z.string({ error: `${name} must be text.` }).trim();
  return (required ? trimmed.min(1, { error: `${name} is required for this mode.` }) : trimmed)
    .max(maxLength, { error: `${name} must be at most ${maxLength} characters.` })
    .refine((text) => !hasControlCharacter(text), { error: `${name} must not contain control characters.` });
};

/**
 * The schema of `paymentAmount`: dollars with at most two decimals, within `MAX_AMOUNT`.
 * @param positive - Whether it must be above 0 (every mode but Tokenise).
 * @returns The schema.
 */
const amountField = (positive: boolean) => {
  const dollars = z.number({ error: AMOUNT_MESSAGE }).refine((amount) => AMOUNT_PATTERN.test(String(amount)) && amount <= MAX_AMOUNT, {
    error: AMOUNT_MESSAGE,
  });
  return positive
    ? dollars.refine((amount) => amount > 0, { error: 'paymentAmount must be greater than 0 for modes 0, 2 and 3.' })
    : dollars;
};

/**
 * The schema of a request for some modes. The modes of one schema share their rules, which are the ones of ZenPay's own
 * launch check (`ZpAuthoriseRequestSchema`).
 * @param modes - The modes this schema is for.
 * @param rules - `positiveAmount`: the amount must be above 0. `identityRequired`: the customer's name and reference may not be empty.
 * @returns The schema.
 */
const requestFor = (modes: readonly PaymentMode[], rules: { positiveAmount: boolean; identityRequired: boolean }) =>
  z.object({
    mode: z.literal(modes),
    paymentAmount: amountField(rules.positiveAmount),
    customerName: textField('customerName', MAX_NAME_LENGTH, rules.identityRequired),
    customerReference: textField('customerReference', MAX_NAME_LENGTH, rules.identityRequired),
    customerEmail: textField('customerEmail', MAX_EMAIL_LENGTH, true).regex(EMAIL_PATTERN, {
      error: 'customerEmail must be an email address.',
    }),
  });

/**
 * The body of `POST /api/checkout`. Fields it does not name are dropped, so nothing a shopper's page adds can reach the
 * launch. Modes 0 and 2 need a customer name and reference and an amount above 0, mode 1 needs neither, and mode 3 needs
 * only the amount.
 */
export const startCheckoutSchema = z.discriminatedUnion(
  'mode',
  [
    requestFor([0, 2], { positiveAmount: true, identityRequired: true }),
    requestFor([1], { positiveAmount: false, identityRequired: false }),
    requestFor([3], { positiveAmount: true, identityRequired: false }),
  ],
  { error: (issue) => (isJsonObject(issue.input) ? MODE_MESSAGE : NOT_AN_OBJECT_MESSAGE) },
);
