import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { AdminProfile, CallbackOutcome, CallbackRecord, PaymentDetail, PaymentState } from "../shared/types";
import { CallbackDialog } from "./components/CallbackDialog";
import { CallbacksCard } from "./components/CallbacksCard";
import { ConfirmDeleteDialog } from "./components/ConfirmDeleteDialog";
import { PaymentDialog } from "./components/PaymentDialog";
import { PaymentsCard } from "./components/PaymentsCard";
import { Topbar } from "./components/Topbar";
import { Toaster } from "./components/ui/sonner";
import { useDebouncedValue } from "./hooks/use-debounced-value";
import { useFeed } from "./hooks/use-feed";
import { deletePayment, getCallbacks, getPayments, getProfile } from "./lib/api";
import { countOf } from "./lib/format";

/** The page title until the profile says which brand to name. */
const DEFAULT_TITLE = "ZenPay checkout";

/** A delete waiting for the person's yes, with the words to ask it in. */
type PendingDelete = {
  title: string;
  description: string;
  run: () => Promise<void>;
};

/**
 * Copies text to the clipboard and tells the person, with a toast, whether it worked.
 * @param text - The text to copy.
 * @returns Nothing; it resolves once the toast is shown.
 */
const copy = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast.error("Could not copy; select the text and copy it manually");
  }
};

/** The admin panel: see, search, read and delete the payment attempts, and read the callbacks ZenPay posted for them. */
export const App = () => {
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [stateFilter, setStateFilter] = useState<PaymentState | undefined>();
  const [outcomeFilter, setOutcomeFilter] = useState<CallbackOutcome | undefined>();
  const [search, setSearch] = useState("");
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [callbackId, setCallbackId] = useState<string | null>(null);
  const [callbackOpen, setCallbackOpen] = useState(false);
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const query = useDebouncedValue(search.trim(), 300);
  const paymentFilter = useMemo(() => ({ state: stateFilter, q: query }), [stateFilter, query]);
  const callbackFilter = useMemo(() => ({ outcome: outcomeFilter }), [outcomeFilter]);
  const payments = useFeed(getPayments, paymentFilter);
  const callbacks = useFeed(getCallbacks, callbackFilter);

  useEffect(() => {
    getProfile().then(setProfile, () => toast.error("Could not load your profile. Refresh the page to try again."));
  }, []);

  const loadMorePayments = () => {
    void payments.loadMore().catch(() => toast.error("Could not load more payments"));
  };

  const loadMoreCallbacks = () => {
    void callbacks.loadMore().catch(() => toast.error("Could not load more callbacks"));
  };

  const copyText = (text: string) => {
    void copy(text);
  };

  const openPayment = (id: string) => {
    setCallbackOpen(false);
    setPaymentId(id);
    setPaymentOpen(true);
  };

  const viewCallback = (callback: CallbackRecord) => {
    setCallbackId(callback.id);
    setCallbackOpen(true);
  };

  const removePayment = async (payment: PaymentDetail) => {
    try {
      await deletePayment(payment.id);
    } catch {
      toast.error("Could not delete the payment");
      return;
    }
    payments.reload();
    callbacks.reload();
    toast("Deleted the payment and its callbacks");
  };

  const askToDeletePayment = (payment: PaymentDetail) => {
    setPaymentOpen(false);
    setPending({
      title: "Delete this payment?",
      description: `The payment for ${payment.customerName} and its ${countOf(
        payment.callbackCount,
        "callback",
      )} will be deleted. This cannot be undone.`,
      run: () => removePayment(payment),
    });
    setConfirmOpen(true);
  };

  return (
    <>
      <title>{profile ? `${profile.brand} checkout` : DEFAULT_TITLE}</title>
      <Topbar profile={profile} />
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 pt-8 pb-16 sm:px-6">
        <PaymentsCard
          stateFilter={stateFilter}
          onStateFilterChange={setStateFilter}
          search={search}
          onSearchChange={setSearch}
          feed={payments}
          onRefresh={payments.reload}
          onView={(payment) => openPayment(payment.id)}
          onLoadMore={loadMorePayments}
        />
        <CallbacksCard
          outcomeFilter={outcomeFilter}
          onOutcomeFilterChange={setOutcomeFilter}
          feed={callbacks}
          onRefresh={callbacks.reload}
          onView={viewCallback}
          onLoadMore={loadMoreCallbacks}
        />
      </main>
      <PaymentDialog id={paymentId} open={paymentOpen} onOpenChange={setPaymentOpen} onCopy={copyText} onDelete={askToDeletePayment} />
      <CallbackDialog id={callbackId} open={callbackOpen} onOpenChange={setCallbackOpen} onCopy={copyText} onOpenPayment={openPayment} />
      <ConfirmDeleteDialog
        title={pending?.title ?? ""}
        description={pending?.description ?? ""}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          void pending?.run();
        }}
      />
      <Toaster position="bottom-center" duration={2500} />
    </>
  );
};
