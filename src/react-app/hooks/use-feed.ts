import { useEffect, useState } from "react";
import type { Page } from "@/lib/api";

/** What one fetch of the list produced; `items` is `null` when the fetch failed. */
type Result<T, F> = {
  /** The filter the fetch was made for. */
  filter: F;
  /** The refresh count the fetch was made for; see {@link Feed.reload}. */
  version: number;
  /** The page's items, or `null` when the fetch failed. */
  items: T[] | null;
  /** The cursor for the next page; `null` when there is none or the fetch failed. */
  nextBefore: string | null;
};

/** A newest-first list as {@link useFeed} keeps it. */
export type Feed<T> = {
  /** Items loaded so far, newest first. */
  items: T[];
  /** `loading` before the first answer, then `ready`, or `error` when the latest fetch failed. */
  status: "loading" | "ready" | "error";
  /** `true` while the list on screen is being replaced after a filter change or refresh. */
  busy: boolean;
  /** Whether more items are waiting behind the ones loaded. */
  hasMore: boolean;
  /** `true` while {@link Feed.loadMore} is fetching. */
  loadingMore: boolean;
  /** Fetches the list again from the first page. */
  reload: () => void;
  /** Appends the next page; rejects when the fetch fails. */
  loadMore: () => Promise<void>;
};

/**
 * Loads a newest-first list a page at a time, and fetches again whenever the filter changes.
 * The previous list stays on screen until the new one arrives.
 * @param fetchPage - Gets one page for a filter; `before` is the previous page's `nextBefore`. Must not change between renders.
 * @param filter - The filter to fetch for; must keep its identity until its contents change, for example through `useMemo`.
 * @returns The list as loaded so far, its status, and the functions that reload it or add the next page.
 */
export const useFeed = <T, F>(fetchPage: (filter: F, before?: string) => Promise<Page<T>>, filter: F): Feed<T> => {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<Result<T, F> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let current = true;
    fetchPage(filter).then(
      (page) => {
        if (current) {
          setResult({
            filter,
            version,
            items: page.items,
            nextBefore: page.nextBefore,
          });
        }
      },
      () => {
        if (current) {
          setResult({ filter, version, items: null, nextBefore: null });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [fetchPage, filter, version]);

  const fresh = result?.filter === filter && result.version === version;

  const loadMore = async () => {
    if (!result?.items || result.nextBefore === null || !fresh) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await fetchPage(filter, result.nextBefore);
      setResult((latest) =>
        latest?.items && latest.filter === filter && latest.version === version
          ? {
              ...latest,
              items: [...latest.items, ...page.items],
              nextBefore: page.nextBefore,
            }
          : latest,
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    items: result?.items ?? [],
    status: result === null ? "loading" : result.items ? "ready" : "error",
    busy: result !== null && !fresh,
    hasMore: result?.nextBefore != null && fresh,
    loadingMore,
    reload: () => setVersion((count) => count + 1),
    loadMore,
  };
};
