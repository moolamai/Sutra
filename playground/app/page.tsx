"use client";

import dynamic from "next/dynamic";

/**
 * The console is a session-local instrument seeded with real HLC
 * timestamps; rendering it on the server would produce a different
 * genesis state than the client. SSR is disabled deliberately.
 */
const ProtocolConsole = dynamic(
  () => import("./console/ProtocolConsole").then((m) => m.ProtocolConsole),
  {
    ssr: false,
    loading: () => (
      <main className="mx-auto max-w-[1500px] px-6 py-5 font-mono text-[11px] text-ink-faint">
        initializing protocol console…
      </main>
    ),
  },
);

export default function Page() {
  return <ProtocolConsole />;
}
