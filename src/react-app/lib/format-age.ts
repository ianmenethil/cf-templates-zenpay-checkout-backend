/** Words for a time distance in the visitor's language; `numeric: "auto"` gives "yesterday" and "now" where they exist. */
const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

/**
 * A full date and time in the visitor's language, for tooltips and dialogs.
 * It is an `Intl.DateTimeFormat`: call `absoluteTime.format(new Date(iso))`.
 */
export const absoluteTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The ladder {@link formatAge} climbs, smallest unit first. Each entry is how many of that unit make up the next
 * one, so 60 seconds make a minute; the last entry is infinite so the ladder always ends.
 */
const STEPS: readonly [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.35, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

/**
 * Describes how long ago a timestamp was, for example "3 hours ago"; a time in the future reads "in 3 hours".
 * @param iso - An ISO 8601 timestamp.
 * @returns The age in the visitor's language, or `iso` unchanged when it is not a valid date.
 */
export const formatAge = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return iso;
  }
  let value = (then - Date.now()) / 1000;
  // The last step's size is infinite, so the loop always returns there.
  for (let i = 0; ; i++) {
    const [size, unit] = STEPS[i];
    if (Math.abs(value) < size) {
      return relativeTime.format(Math.round(value), unit);
    }
    value /= size;
  }
};
