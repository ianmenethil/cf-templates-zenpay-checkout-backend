/** Days stored data is kept when `RETENTION_DAYS` is not a positive whole number. */
const DEFAULT_RETENTION_DAYS = 30;

/** Most days stored data is kept: 10 years. A larger `RETENTION_DAYS` counts as this, so the cutoff is always a valid date. */
const MAX_RETENTION_DAYS = 3650;

/**
 * Works out the time before which stored data is expired.
 * @param retentionDays - The `RETENTION_DAYS` variable; anything but a positive whole number means 30,
 * so a typo cannot delete everything, and a number above 3650 means 3650.
 * @returns The cutoff as an ISO 8601 time, as stored.
 */
export const retentionCutoff = (retentionDays: string): string => {
  const days = Number(retentionDays);
  const keepDays = Number.isInteger(days) && days > 0 ? Math.min(days, MAX_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS;
  return new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
};
