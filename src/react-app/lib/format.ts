/** The units {@link formatSize} chooses from, largest first, each with how many bytes it holds. */
const SIZE_UNITS: readonly [string, number][] = [
  ["megabyte", 1024 ** 2],
  ["kilobyte", 1024],
  ["byte", 1],
];

/**
 * Describes a size in bytes in the largest unit that keeps it above 1, for example "1.4kB" or "2.5MB" in English.
 * @param bytes - The size in bytes.
 * @returns The size in the visitor's language, with at most one decimal.
 */
export const formatSize = (bytes: number): string => {
  const [unit, size] = SIZE_UNITS.find(([, limit]) => bytes >= limit) ?? SIZE_UNITS[2];
  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: 1,
  }).format(bytes / size);
};

/**
 * Writes a count with its noun, for example "1 callback" or "3 callbacks".
 * @param count - The number of things.
 * @param singular - The noun for exactly one.
 * @param plural - The noun for any other count; defaults to the singular with an `s`.
 * @returns The count and the matching noun.
 */
export const countOf = (count: number, singular: string, plural = `${singular}s`): string => `${count} ${count === 1 ? singular : plural}`;

/** Formats dollars the same way for every visitor: always Australian English and Australian dollars, whatever the browser's language. */
const amountFormat = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

/**
 * Writes a payment amount as dollars and cents, for example "$49.90".
 * @param dollars - The amount in dollars.
 * @returns The amount in Australian dollars, always with two decimals.
 */
export const formatAmount = (dollars: number): string => amountFormat.format(dollars);
