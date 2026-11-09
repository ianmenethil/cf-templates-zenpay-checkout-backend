import { RefreshCw, Search } from "lucide-react";
import { PAYMENT_STATES, type PaymentState, type PaymentSummary } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Feed } from "@/hooks/use-feed";
import { countOf, formatAmount } from "../lib/format";
import { absoluteTime, formatAge } from "../lib/format-age";
import { MODE_NAMES, STATE_LABELS } from "../lib/labels";
import { TABLE_HEAD } from "../lib/styles";
import { IconButton } from "./IconButton";
import { StateBadge } from "./StateBadge";

/** The state filter's value for "no filter"; it cannot clash with a real state. */
const ALL_STATES = "all";

/** Props for {@link PaymentsCard}. */
type PaymentsCardProps = {
  /** The state the list is limited to; `undefined` for all of them. */
  stateFilter: PaymentState | undefined;
  /** Called with the state the person picked, or `undefined` for all of them. */
  onStateFilterChange: (state: PaymentState | undefined) => void;
  /** The text in the search box. */
  search: string;
  /** Called with the new text as the person types. */
  onSearchChange: (search: string) => void;
  /** The loaded payments and how to load more. */
  feed: Feed<PaymentSummary>;
  /** Fetches the list again. */
  onRefresh: () => void;
  /** Called with a payment the person wants to read in full. */
  onView: (payment: PaymentSummary) => void;
  /** Called when the person asks for the next page. */
  onLoadMore: () => void;
};

/** The payment attempts, newest first, filtered by state and text; a click on a row opens the payment. */
export const PaymentsCard = ({
  stateFilter,
  onStateFilterChange,
  search,
  onSearchChange,
  feed,
  onRefresh,
  onView,
  onLoadMore,
}: PaymentsCardProps) => {
  const filtered = stateFilter !== undefined || search.trim() !== "";
  const message =
    feed.status === "loading"
      ? "Loading…"
      : feed.status === "error"
        ? "Could not load payments. Try the refresh button."
        : feed.items.length === 0
          ? filtered
            ? "No payments match your filters."
            : "No payments yet. They appear here as soon as a shopper presses Pay."
          : null;

  return (
    <Card role="region" aria-labelledby="payments-heading">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>
          <h1 id="payments-heading">Payments</h1>
        </CardTitle>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <label className="sr-only" htmlFor="state-filter">
            Filter by state
          </label>
          <Select
            value={stateFilter ?? ALL_STATES}
            onValueChange={(value) => onStateFilterChange(PAYMENT_STATES.find((state) => state === value))}
          >
            <SelectTrigger id="state-filter" className="max-sm:w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATES}>All states</SelectItem>
              {PAYMENT_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {STATE_LABELS[state].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="sr-only" htmlFor="payment-search">
            Search payments
          </label>
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="payment-search"
              className="pl-8"
              type="search"
              placeholder="Search ID, customer or reference"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
          <IconButton label="Refresh payments" onClick={onRefresh}>
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
                <TableHead className={`${TABLE_HEAD} rounded-l-md pl-3`}>Started</TableHead>
                <TableHead className={TABLE_HEAD}>Customer</TableHead>
                <TableHead className={TABLE_HEAD}>Amount</TableHead>
                <TableHead className={TABLE_HEAD}>Mode</TableHead>
                <TableHead className={TABLE_HEAD}>State</TableHead>
                <TableHead className={TABLE_HEAD}>ZenPay reference</TableHead>
                <TableHead className={`${TABLE_HEAD} rounded-r-md pr-3 text-right`}>Callbacks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={`max-sm:block ${feed.busy ? "opacity-60 transition-opacity" : ""}`}>
              {feed.items.map((payment) => (
                <TableRow
                  key={payment.id}
                  className="cursor-pointer max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:py-3"
                  onClick={() => onView(payment)}
                >
                  <TableCell className="pl-3 whitespace-nowrap max-sm:col-start-2 max-sm:row-start-3 max-sm:p-0 max-sm:text-right max-sm:text-sm">
                    {/* The row's click opens the payment; this button gives the keyboard the same way in. */}
                    <button
                      type="button"
                      className="rounded-sm text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <time dateTime={payment.createdAt} title={absoluteTime.format(new Date(payment.createdAt))}>
                        {formatAge(payment.createdAt)}
                      </time>
                      <span className="sr-only">Open payment for {payment.customerName}</span>
                    </button>
                  </TableCell>
                  <TableCell
                    className="w-[24%] max-w-0 max-sm:col-start-1 max-sm:row-start-1 max-sm:w-auto max-sm:max-w-none max-sm:p-0"
                    title={payment.customerEmail}
                  >
                    <span className="block truncate font-medium">{payment.customerName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{payment.customerEmail}</span>
                  </TableCell>
                  <TableCell className="tabular-nums max-sm:col-start-1 max-sm:row-start-3 max-sm:p-0 max-sm:text-sm">
                    {formatAmount(payment.paymentAmount)}
                    <span className="hidden max-sm:inline">
                      {" "}
                      <span className="text-muted-foreground">· {MODE_NAMES[payment.mode]}</span>
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap max-sm:hidden">{MODE_NAMES[payment.mode]}</TableCell>
                  <TableCell className="max-sm:col-start-2 max-sm:row-start-1 max-sm:p-0">
                    <StateBadge state={payment.state} />
                  </TableCell>
                  <TableCell
                    className="w-[16%] max-w-0 font-mono text-xs max-sm:col-start-1 max-sm:row-start-4 max-sm:w-auto max-sm:max-w-none max-sm:p-0"
                    title={payment.reference ?? undefined}
                  >
                    <span className="block truncate">
                      {payment.reference ?? <span className="font-sans text-sm text-muted-foreground">none yet</span>}
                    </span>
                  </TableCell>
                  <TableCell className="pr-3 text-right text-muted-foreground tabular-nums max-sm:col-start-2 max-sm:row-start-4 max-sm:p-0 max-sm:text-sm">
                    <span className="sm:hidden">{countOf(payment.callbackCount, "callback")}</span>
                    <span className="max-sm:hidden">{payment.callbackCount}</span>
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
