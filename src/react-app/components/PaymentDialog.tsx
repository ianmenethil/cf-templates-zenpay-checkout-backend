import { Copy, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PaymentDetail } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getPayment } from "../lib/api";
import { countOf, formatAmount, formatSize } from "../lib/format";
import { absoluteTime, formatAge } from "../lib/format-age";
import { MODE_NAMES, STATE_LABELS } from "../lib/labels";
import { CallbackBody } from "./CallbackBody";
import { Fact } from "./Fact";
import { IconButton } from "./IconButton";
import { OutcomeBadge } from "./OutcomeBadge";
import { StateBadge } from "./StateBadge";

/** The answer for one payment ID; `payment` is `null` when the fetch failed. */
type Loaded = { id: string; payment: PaymentDetail | null };

/** Props for {@link PaymentDialog}. */
type PaymentDialogProps = {
  /** The payment to show; kept while the dialog is closed so its text does not blank out. */
  id: string | null;
  /** Whether the dialog is showing. */
  open: boolean;
  /** Called with the new state when the person closes the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Copies text to the clipboard. */
  onCopy: (text: string) => void;
  /** Asks to delete the payment and its callbacks; the person confirms before it goes. */
  onDelete: (payment: PaymentDetail) => void;
};

/** Everything about one payment: its details, then every callback it received, newest first, each with its body. */
export const PaymentDialog = ({ id, open, onOpenChange, onCopy, onDelete }: PaymentDialogProps) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!open || id === null) {
      return;
    }
    let current = true;
    getPayment(id).then(
      (payment) => {
        if (current) setLoaded({ id, payment });
      },
      () => {
        if (current) setLoaded({ id, payment: null });
      },
    );
    return () => {
      current = false;
    };
  }, [id, open]);

  const answer = loaded?.id === id ? loaded : null;
  const payment = answer?.payment ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Payment</DialogTitle>
          <DialogDescription>
            {payment
              ? `${MODE_NAMES[payment.mode]} for ${payment.customerName}.`
              : answer
                ? "Could not load this payment. It may have been deleted."
                : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {payment && (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label="State">
                <StateBadge state={payment.state} />
                <span className="w-full text-xs text-muted-foreground">{STATE_LABELS[payment.state].hint}</span>
              </Fact>
              <Fact label="Payment ID">
                <span className="min-w-0 truncate font-mono text-xs">{payment.id}</span>
                <IconButton label="Copy payment ID" variant="ghost" size="icon-sm" onClick={() => onCopy(payment.id)}>
                  <Copy />
                </IconButton>
              </Fact>
              <Fact label="Mode">{MODE_NAMES[payment.mode]}</Fact>
              <Fact label="Amount">{formatAmount(payment.paymentAmount)}</Fact>
              <Fact label="Customer">{payment.customerName}</Fact>
              <Fact label="Email">
                <span className="min-w-0 break-all">{payment.customerEmail}</span>
              </Fact>
              <Fact label="Customer reference">
                <span className="min-w-0 break-all font-mono text-xs">{payment.customerReference}</span>
              </Fact>
              <Fact label="ZenPay reference">
                {payment.reference ? (
                  <>
                    <span className="min-w-0 truncate font-mono text-xs">{payment.reference}</span>
                    <IconButton
                      label="Copy ZenPay reference"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onCopy(payment.reference ?? "")}
                    >
                      <Copy />
                    </IconButton>
                  </>
                ) : (
                  <span className="text-muted-foreground">none yet</span>
                )}
              </Fact>
              <Fact label="Gateway status">{payment.gatewayStatus ?? <span className="text-muted-foreground">none yet</span>}</Fact>
              <Fact label="Callbacks">{payment.callbackCount}</Fact>
              <Fact label="Started">
                <time dateTime={payment.createdAt} title={formatAge(payment.createdAt)}>
                  {absoluteTime.format(new Date(payment.createdAt))}
                </time>
              </Fact>
              <Fact label="State changed">
                <time dateTime={payment.updatedAt} title={formatAge(payment.updatedAt)}>
                  {absoluteTime.format(new Date(payment.updatedAt))}
                </time>
              </Fact>
            </dl>
            <section className="grid gap-3" aria-labelledby="payment-callbacks-heading">
              <h3 id="payment-callbacks-heading" className="font-medium">
                Callbacks
              </h3>
              {payment.callbacks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No callbacks yet.</p>
              ) : (
                <ul className="grid gap-3">
                  {payment.callbacks.map((callback) => (
                    <li key={callback.id} className="grid gap-3 rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <OutcomeBadge outcome={callback.outcome} />
                        <time dateTime={callback.receivedAt} title={formatAge(callback.receivedAt)}>
                          {absoluteTime.format(new Date(callback.receivedAt))}
                        </time>
                        <span className="text-muted-foreground">
                          {countOf(callback.deliveries, "delivery", "deliveries")}
                          {callback.deliveries > 1 && (
                            <>
                              , latest{" "}
                              <time dateTime={callback.lastReceivedAt} title={formatAge(callback.lastReceivedAt)}>
                                {absoluteTime.format(new Date(callback.lastReceivedAt))}
                              </time>
                            </>
                          )}
                          {" · "}
                          {formatSize(callback.size)}
                        </span>
                      </div>
                      {callback.reason && <p className="text-sm text-destructive">Rejected: {callback.reason}</p>}
                      <CallbackBody body={callback.body} onCopy={onCopy} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <DialogFooter>
              <Button variant="destructive" onClick={() => onDelete(payment)}>
                <Trash2 />
                Delete
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
