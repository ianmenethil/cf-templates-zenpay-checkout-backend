import type { ReactNode } from "react";

/** Props for {@link Fact}. */
type FactProps = {
  /** The name of the fact, shown above its value. */
  label: string;
  /** The value. */
  children: ReactNode;
};

/** One labelled fact in a dialog's summary grid; place inside a `dl`. */
export const Fact = ({ label, children }: FactProps) => (
  <div className="grid gap-0.5">
    <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
    <dd className="flex min-w-0 flex-wrap items-center gap-1 break-words">{children}</dd>
  </div>
);
