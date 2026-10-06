import { fontSize, fontWeight, motion, radius } from "@canvas/scale.stylex";
import * as stylex from "@stylexjs/stylex";
import { createContext, useContext, useState } from "react";

import { RefreshIcon } from "./icons";
import { withClass } from "./stylex-props";
import { tokens } from "./tokens.stylex";
import { useTooltip } from "./use-tooltip";

export interface LostConnection {
  host?: string;
  detail: string;
  retry?(): Promise<void>;
}

export const ConnectionContext = createContext<LostConnection | undefined>(
  undefined,
);

/** Shown while the review stream is down. On a remote review, a click retries the host. */
export function ConnectionChip() {
  const connection = useContext(ConnectionContext);
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<string>();

  const tooltip = useTooltip<HTMLElement>(
    connection?.retry ? "Click to retry" : "Reconnecting…",
    { detail: failure ?? connection?.detail },
  );

  if (!connection) return null;

  const label = connection.host
    ? `${connection.host} disconnected`
    : "Disconnected";

  const { retry } = connection;

  if (!retry)
    return (
      <span
        {...withClass("connection-chip", styles.chip)}
        role="status"
        ref={tooltip}
      >
        {label}
      </span>
    );

  return (
    <button
      type="button"
      {...withClass("connection-chip", styles.chip, styles.button)}
      aria-label={`${label}. Retry.`}
      aria-busy={retrying || undefined}
      disabled={retrying}
      ref={tooltip}
      onClick={() => {
        setRetrying(true);
        setFailure(undefined);
        retry()
          .catch((error: Error) => setFailure(error.message))
          .finally(() => setRetrying(false));
      }}
    >
      <span role="status">{label}</span>
      <RefreshIcon xstyle={[styles.icon, retrying && styles.spinning]} />
    </button>
  );
}

const REDUCED = "@media (prefers-reduced-motion: reduce)";

const spin = stylex.keyframes({
  to: { transform: "rotate(360deg)" },
});

const styles = stylex.create({
  chip: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: "6px",
    height: tokens.chromeControlHeight,
    marginInline: "4px",
    padding: "0 10px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tokens.warningOutline,
    borderRadius: radius.pill,
    backgroundColor: tokens.warningWash,
    color: tokens.changeModified,
    font: `${fontWeight.semibold} ${fontSize.small} ${tokens.fontMono}`,
    whiteSpace: "nowrap",
  },
  button: {
    paddingInlineEnd: "7px",
    cursor: { default: "pointer", ":disabled": "progress" },
    filter: { default: null, ":hover:not(:disabled)": "brightness(1.15)" },
    outline: {
      default: null,
      ":focus-visible": `1px solid ${tokens.changeModified}`,
    },
    outlineOffset: { default: null, ":focus-visible": "1px" },
  },
  icon: {
    width: "13px",
    height: "13px",
  },
  spinning: {
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: { default: motion.pulse, [REDUCED]: motion.instant },
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});
