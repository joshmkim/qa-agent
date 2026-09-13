"use client";

import { Container, PageHeader, StatusIndicator } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-5">
      <PageHeader title="Control plane unreachable" />
      <Container>
        <div className="space-y-3">
          <StatusIndicator tone="error">Couldn&apos;t load pipeline data</StatusIndicator>
          <p className="text-text-secondary">
            The web UI reads from the control plane at <code className="mono">CONTROL_PLANE_URL</code>. Check that it
            is running, or set <code className="mono">DATA_SOURCE=mock</code> to use fixtures.
          </p>
          {error.digest && <p className="mono text-text-secondary text-[12px]">digest {error.digest}</p>}
          <button type="button" className="btn btn-primary" onClick={reset}>
            Retry
          </button>
        </div>
      </Container>
    </div>
  );
}
