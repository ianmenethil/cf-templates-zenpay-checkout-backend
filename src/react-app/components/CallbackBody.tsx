import { Copy } from "lucide-react";
import { useId, useMemo } from "react";
import { prettyBody } from "../lib/pretty-body";
import { IconButton } from "./IconButton";

/** Props for {@link CallbackBody}. */
type CallbackBodyProps = {
  /** The callback body exactly as received, as text. */
  body: string;
  /** Copies text to the clipboard. */
  onCopy: (text: string) => void;
};

/** A callback's body in a scrollable box, indented when it is JSON and as received otherwise, with a copy button. */
export const CallbackBody = ({ body, onCopy }: CallbackBodyProps) => {
  const headingId = useId();
  const text = useMemo(() => prettyBody(body), [body]);

  return (
    <section className="grid gap-2" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          Body
        </h3>
        {text && (
          <IconButton label="Copy body" variant="ghost" size="icon-sm" onClick={() => onCopy(text)}>
            <Copy />
          </IconButton>
        )}
      </div>
      {text ? (
        <pre
          className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"
          tabIndex={0}
          aria-labelledby={headingId}
        >
          {text}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">The body was empty.</p>
      )}
    </section>
  );
};
