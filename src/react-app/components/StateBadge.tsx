import { CircleCheck, CircleX, Clock, Hourglass, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { PaymentState } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { STATE_LABELS } from "../lib/labels";

/** Each state's look: only `succeeded` is green, and `unverified` is a dashed amber warning. */
const LOOKS: Record<PaymentState, { variant: "secondary" | "outline"; className: string; icon: ReactNode }> = {
  pending: {
    variant: "outline",
    className: "text-muted-foreground",
    icon: <Clock aria-hidden="true" />,
  },
  unverified: {
    variant: "outline",
    className: "border-dashed border-amber-500/70 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: <TriangleAlert aria-hidden="true" />,
  },
  processing: {
    variant: "secondary",
    className: "",
    icon: <Hourglass aria-hidden="true" />,
  },
  succeeded: {
    variant: "secondary",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: <CircleCheck aria-hidden="true" />,
  },
  failed: {
    variant: "secondary",
    className: "bg-destructive/10 text-destructive",
    icon: <CircleX aria-hidden="true" />,
  },
};

/** Props for {@link StateBadge}. */
type StateBadgeProps = {
  /** Where the payment stands. */
  state: PaymentState;
};

/** A payment's state as a badge with an icon, so the five states look different even without colour. */
export const StateBadge = ({ state }: StateBadgeProps) => {
  const { variant, className, icon } = LOOKS[state];
  const { label, hint } = STATE_LABELS[state];
  return (
    <Badge variant={variant} className={className} title={hint}>
      {icon}
      {label}
    </Badge>
  );
};
