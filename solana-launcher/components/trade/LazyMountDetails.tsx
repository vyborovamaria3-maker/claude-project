"use client";

import { useState, type ReactNode } from "react";

type Props = {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
};

export default function LazyMountDetails({ summary, children, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="rounded-2xl border border-bg-border bg-bg-card/45"
      data-tag="blockchain.lazy-details.v1-2-3"
    >
      <summary className="cursor-pointer px-4 py-3 text-[11px] font-semibold text-content-muted">
        {summary}
      </summary>
      {open ? <div className="border-t border-bg-border p-4">{children}</div> : null}
    </details>
  );
}
