import { RefreshCw } from "lucide-react";
import { CALLBACK_OUTCOMES, type CallbackOutcome, type CallbackRecord } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Feed } from "@/hooks/use-feed";
import { countOf, formatSize } from "../lib/format";
import { absoluteTime, formatAge } from "../lib/format-age";
import { NO_PAYMENT, OUTCOME_LABELS } from "../lib/labels";
import { TABLE_HEAD } from "../lib/styles";
import { IconButton } from "./IconButton";
import { OutcomeBadge } from "./OutcomeBadge";

/** The outcome filter's value for "no filter"; it cannot clash with a real outcome. */
const ALL_OUTCOMES = "all";

/** Props for {@link CallbacksCard}. */
type CallbacksCardProps = {
  /** The outcome the list is limited to; `undefined` for all of them. */
  outcomeFilter: CallbackOutcome | undefined;
  /** Called with the outcome the person picked, or `undefined` for all of them. */
  onOutcomeFilterChange: (outcome: CallbackOutcome | undefined) => void;
  /** The loaded callbacks and how to load more. */
  feed: Feed<CallbackRecord>;
  /** Fetches the list again. */
  onRefresh: () => void;
  /** Called with a callback the person wants to read in full. */
  onView: (callback: CallbackRecord) => void;
  /** Called when the person asks for the next page. */
  onLoadMore: () => void;
};

/** Every callback ZenPay posted, newest first, filtered by outcome; a click on a row opens the callback. */
export const CallbacksCard = ({ outcomeFilter, onOutcomeFilterChange, feed, onRefresh, onView, onLoadMore }: CallbacksCardProps) => {
  const message =
    feed.status === "loading"
      ? "Loading…"
      : feed.status === "error"
        ? "Could not load callbacks. Try the refresh button."
        : feed.items.length === 0
          ? outcomeFilter !== undefined
            ? "No callbacks match this filter."
            : "No callbacks yet. They appear here as soon as ZenPay posts one."
          : null;

  return (
    <Card role="region" aria-labelledby="callbacks-heading">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>
          <h2 id="callbacks-heading">Callbacks</h2>
        </CardTitle>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <label className="sr-only" htmlFor="outcome-filter">
            Filter by outcome
          </label>
          <Select
            value={outcomeFilter ?? ALL_OUTCOMES}
            onValueChange={(value) => onOutcomeFilterChange(CALLBACK_OUTCOMES.find((outcome) => outcome === value))}
          >
            <SelectTrigger id="outcome-filter" className="max-sm:flex-1 sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_OUTCOMES}>All outcomes</SelectItem>
              {CALLBACK_OUTCOMES.map((outcome) => (
                <SelectItem key={outcome} value={outcome}>
                  {OUTCOME_LABELS[outcome].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <IconButton label="Refresh callbacks" onClick={onRefresh}>
            <RefreshCw />
          </IconButton>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {message && <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{message}</p>}
        {!message && (
          <Table className="max-sm:block" aria-busy={feed.busy}>
            <TableHeader className="bg-muted/60 max-sm:hidden">
              <TableRow className="hover:bg-transparent">
                <TableHead className={`${TABLE_HEAD} rounded-l-md pl-3`}>Received</TableHead>
                <TableHead className={TABLE_HEAD}>Outcome</TableHead>
                <TableHead className={TABLE_HEAD}>Payment ID</TableHead>
                <TableHead className={TABLE_HEAD}>Deliveries</TableHead>
                <TableHead className={TABLE_HEAD}>Size</TableHead>
                <TableHead className={`${TABLE_HEAD} rounded-r-md pr-3`}>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={`max-sm:block ${feed.busy ? "opacity-60 transition-opacity" : ""}`}>
              {feed.items.map((callback) => (
                <TableRow
                  key={callback.id}
                  className="cursor-pointer max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-3"
                  onClick={() => onView(callback)}
                >
                  <TableCell className="pl-3 whitespace-nowrap max-sm:col-start-2 max-sm:row-start-3 max-sm:p-0 max-sm:text-right max-sm:text-sm">
                    {/* The row's click opens the callback; this button gives the keyboard the same way in. */}
                    <button
                      type="button"
                      className="rounded-sm text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <time dateTime={callback.receivedAt} title={absoluteTime.format(new Date(callback.receivedAt))}>
                        {formatAge(callback.receivedAt)}
                      </time>
                      <span className="sr-only">Open callback</span>
                    </button>
                  </TableCell>
                  <TableCell className="max-sm:col-start-2 max-sm:row-start-1 max-sm:p-0">
                    <OutcomeBadge outcome={callback.outcome} />
                  </TableCell>
                  <TableCell
                    className="w-[30%] max-w-0 font-mono text-xs max-sm:col-start-1 max-sm:row-start-1 max-sm:w-auto max-sm:max-w-none max-sm:p-0"
                    title={callback.paymentId ?? undefined}
                  >
                    <span className="block truncate">
                      {callback.paymentId ?? (
                        <span className="font-sans text-sm text-muted-foreground" title={NO_PAYMENT.hint}>
                          {NO_PAYMENT.label}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums max-sm:col-start-1 max-sm:row-start-3 max-sm:p-0 max-sm:text-sm">
                    {countOf(callback.deliveries, "delivery", "deliveries")}
                    <span className="text-muted-foreground sm:hidden"> · {formatSize(callback.size)}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums max-sm:hidden">{formatSize(callback.size)}</TableCell>
                  <TableCell
                    className="w-[24%] max-w-0 pr-3 max-sm:col-span-2 max-sm:row-start-2 max-sm:w-auto max-sm:max-w-none max-sm:p-0 max-sm:text-sm empty:max-sm:hidden"
                    title={callback.reason ?? undefined}
                  >
                    {callback.reason && <span className="block truncate">{callback.reason}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!message && feed.hasMore && (
          <Button variant="outline" className="justify-self-center" disabled={feed.loadingMore} onClick={onLoadMore}>
            {feed.loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
};
