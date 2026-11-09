import { useEffect, useState } from "react";

/**
 * Follows a value after it has stopped changing for a moment, so typing does not fire a request per key.
 * @param value - The value to follow.
 * @param delay - How long, in milliseconds, the value must stay the same before it is passed on.
 * @returns The value as it was when it last stayed the same for `delay`; the first value to begin with.
 */
export const useDebouncedValue = <T>(value: T, delay: number): T => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
};
