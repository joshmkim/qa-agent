import { notFound } from "next/navigation";
import type { ManifestSnapshot } from "@qa-agent/shared-types";
import { getPipeline, getPipelineManifest } from "@/lib/data";
import { Code, Container, Pill, SeverityBadge, StatusIndicator } from "@/components/ui";
import { formatDateTime, shortSha } from "@/lib/format";

const FORMAT_DOCS = "https://github.com/joshmkim/qa-agent/blob/main/docs/qa-manifest.md";

export default async function ManifestPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();
  const manifest = await getPipelineManifest(pipeline.id);
  const product = manifest?.status === "loaded" ? manifest.product : undefined;

  if (!manifest || !product) {
    return <ManifestUnavailable manifest={manifest} path={pipeline.manifestPath} />;
  }

  const touched = product.surfaces.filter((s) => s.touchedByChange).length;

  return (
    <div className="space-y-5">
      <Container
        title={product.productName}
        description={
          <>
            <Code>{manifest.path}</Code> @ {product.manifestVersion} · read at commit{" "}
            <span className="mono">{shortSha(manifest.commitSha)}</span> · {formatDateTime(manifest.loadedAt)}
          </>
        }
      >
        <p className="max-w-[900px]">{product.intent}</p>
        {product.boundaries && product.boundaries.length > 0 && (
          <div className="mt-4">
            <div className="text-[12px] font-bold uppercase tracking-wide text-text-secondary">Boundaries</div>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {product.boundaries.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </Container>

      <Container
        title={`Invariants (${product.invariants.length})`}
        description="Team-authored statements that must always hold. Violations are scored automatically by the triage judge. This is the highest-leverage thing a team can maintain."
        padded={false}
      >
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Statement</th>
              <th>Check</th>
              <th>Surfaces</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {product.invariants.map((inv) => (
              <tr key={inv.id}>
                <td className="mono whitespace-nowrap">{inv.id}</td>
                <td className="max-w-[520px]">{inv.statement}</td>
                <td>{inv.check ? <Code>{inv.check}</Code> : <span className="text-text-secondary">LLM-judged</span>}</td>
                <td className="mono text-[12px]">{inv.surfaceIds?.join(", ") || "—"}</td>
                <td>
                  <SeverityBadge severity={inv.severityOnViolation} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Container>

      <Container
        title={`Surface inventory (${product.surfaces.length})`}
        description={`Pages, forms, buttons, endpoints and flows the fleet is expected to cover. ${touched} touched by the latest change.`}
        padded={false}
      >
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Kind</th>
              <th>Locator</th>
              <th>Sources</th>
              <th>Touched by latest change</th>
            </tr>
          </thead>
          <tbody>
            {product.surfaces.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="font-bold">{s.name}</div>
                  <div className="mono text-[12px] text-text-secondary">{s.id}</div>
                </td>
                <td>
                  <Pill>{s.kind}</Pill>
                </td>
                <td className="mono">{s.locator}</td>
                <td className="mono text-[12px]">
                  {s.sources?.length ? s.sources.join(", ") : <span className="font-sans text-text-secondary">Not mapped</span>}
                </td>
                <td>{s.touchedByChange ? <Pill tone="info">Yes</Pill> : <span className="text-text-secondary">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Container>
    </div>
  );
}

function ManifestUnavailable({ manifest, path }: { manifest?: ManifestSnapshot; path: string }) {
  const status = manifest?.status ?? "missing";
  return (
    <Container title="QA manifest">
      <div className="space-y-3">
        {status === "missing" ? (
          <>
            <StatusIndicator tone="warning">No manifest found</StatusIndicator>
            <p>
              Add <Code>{path}</Code> to the repository so agents know the product&apos;s surfaces, invariants, and
              boundaries. Runs still happen without it, but only hard errors can be caught.
            </p>
          </>
        ) : (
          <>
            <StatusIndicator tone="error">
              {status === "invalid" ? "Manifest is invalid" : "Manifest could not be read"}
            </StatusIndicator>
            {manifest?.commitSha && (
              <p className="text-text-secondary">
                <Code>{manifest.path}</Code> at commit <span className="mono">{shortSha(manifest.commitSha)}</span>
              </p>
            )}
            <ul className="list-disc space-y-1 pl-5">
              {(manifest?.errors ?? []).map((e) => (
                <li key={e} className="mono text-[13px]">
                  {e}
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          <a href={FORMAT_DOCS} target="_blank" rel="noreferrer">
            Manifest format
          </a>{" "}
          · validate locally with <Code>pnpm --filter @qa-agent/control-plane manifest:check .qa/manifest.yaml</Code>
        </p>
      </div>
    </Container>
  );
}
