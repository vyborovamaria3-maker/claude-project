"use client";

import dynamic from "next/dynamic";

// The workspace initializes browser storage and the user's timezone on mount.
// Rendering those values on the server produces a different initial UI.
const TGInviteWorkspace = dynamic(() => import("./TGInviteWorkspace"), {
  ssr: false,
  loading: () => <div role="status" className="p-6 text-content">Loading TG Invite…</div>,
});

export default TGInviteWorkspace;
