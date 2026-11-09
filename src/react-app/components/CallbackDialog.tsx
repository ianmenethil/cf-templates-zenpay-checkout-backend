import { CreditCard } from "lucide-react";
import { useEffect, useState } from "react";
import type { CallbackDetail } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getCallback } from "../lib/api";
import { countOf, formatSize } from "../lib/format";
import { absoluteTime, formatAge } from "../lib/format-age";
import { NO_PAYMENT, OUTCOME_LABELS } from "../lib/labels";
import { CallbackBody } from "./CallbackBody";
import { Fact } from "./Fact";
import { OutcomeBadge } from "./OutcomeBadge";

/** The answer for one callback ID; `callback` is `null` when the fetch failed. */
type Loaded = { id: string; callback: CallbackDetail | null };

/** Props for {@link CallbackDialog}. */
type CallbackDialogProps = {
  /** The callback to show; kept while the dialog is closed so its text does not blank out. */
  id: string | null;
  /** Whether the dialog is showing. */
  open: boolean;
  /** Called with the new state when the person closes the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Copies text to the clipboard. */
  onCopy: (text: string) => void;
  /** Called with the ID of the payment the person wants to open from here. */
  onOpenPayment: (paymentId: string) => void;
};

/** Everything one callback arrived with: outcome, times and the body, with a button to open its payment. */
export const CallbackDialog = ({ id, open, onOpenChange, onCopy, onOpenPayment }: CallbackDialogProps) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!open || id === null) {
      return;
    }
    let current = true;
    getCallback(id).then(
      (callback) => {
        if (current) setLoaded({ id, callback });
      },
      () => {
        if (current) setLoaded({ id, callback: null });
      },
    );
    return () => {
      current = false;
    };
  }, [id, open]);

  const answer = loaded?.id === id ? loaded : null;
  const callback = answer?.callback ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Callback</DialogTitle>
          <DialogDescription>
            {callback
              ? OUTCOME_LABELS[callback.outcome].hint
              : answer
                ? "Could not load this callback. It may have been deleted."
                : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {callback && (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label="Outcome">
                <OutcomeBadge outcome={callback.outcome} />
              </Fact>
              <Fact label="Payment ID">
                {callback.paymentId ? (
                  <span className="min-w-0 truncate font-mono text-xs">{callback.paymentId}</span>
                ) : (
                  <span className="text-muted-foreground" title={NO_PAYMENT.hint}>
                    {NO_PAYMENT.label}
                  </span>
                )}
              </Fact>
              {callback.reason && (
                <Fact label="Reason">
                  <span className="text-destructive">{callback.reason}</span>
                </Fact>
              )}
              <Fact label="Received">
                <time dateTime={callback.receivedAt} title={formatAge(callback.receivedAt)}>
                  {absoluteTime.format(new Date(callback.receivedAt))}
                </time>
              </Fact>
              <Fact label="Deliveries">
                {countOf(callback.deliveries, "delivery", "deliveries")}
                {callback.deliveries > 1 && (
                  <span className="text-muted-foreground">
                    , latest{" "}
                    <time dateTime={callback.lastReceivedAt} title={formatAge(callback.lastReceivedAt)}>
                      {absoluteTime.format(new Date(callback.lastReceivedAt))}
                    </time>
                  </span>
                )}
              </Fact>
              <Fact label="Size">{formatSize(callback.size)}</Fact>
            </dl>
            <CallbackBody body={callback.body} onCopy={onCopy} />
            {callback.paymentId && (
              <DialogFooter>
                <Button variant="outline" onClick={() => onOpenPayment(callback.paymentId ?? "")}>
                  <CreditCard />
                  Open payment
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
