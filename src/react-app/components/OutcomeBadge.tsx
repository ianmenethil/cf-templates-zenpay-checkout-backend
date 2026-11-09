import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { ReactNode } from "react";
import type { CallbackOutcome } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { OUTCOME_LABELS } from "../lib/labels";

/** Each outcome's look: `verified` is green, `unsigned` a dashed amber warning, `rejected` red. */
const LOOKS: Record<CallbackOutcome, { variant: "secondary" | "outline"; className: string; icon: ReactNode }> = {
  verified: {
    variant: "secondary",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    icon: <ShieldCheck aria-hidden="true" />,
  },
  unsigned: {
    variant: "outline",
    className: "border-dashed border-amber-500/70 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: <ShieldAlert aria-hidden="true" />,
  },
  rejected: {
    variant: "secondary",
    className: "bg-destructive/10 text-destructive",
    icon: <ShieldX aria-hidden="true" />,
  },
};

/** Props for {@link OutcomeBadge}. */
type OutcomeBadgeProps = {
  /** What the Worker made of the callback. */
  outcome: CallbackOutcome;
};

/** A callback's outcome as a badge with an icon, so the three outcomes look different even without colour. */
export const OutcomeBadge = ({ outcome }: OutcomeBadgeProps) => {
  const { variant, className, icon } = LOOKS[outcome];
  const { label, hint } = OUTCOME_LABELS[outcome];
  return (
    <Badge variant={variant} className={className} title={hint}>
      {icon}
      {label}
    </Badge>
  );
};
