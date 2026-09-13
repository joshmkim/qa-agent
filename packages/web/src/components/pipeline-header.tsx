import type { Pipeline } from "@qa-agent/shared-types";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Tabs } from "@/components/tabs";
import { Button, Icons, PageHeader, Pill } from "@/components/ui";

/**
 * Title, repo/manifest meta, actions, and tab strip for a pipeline. Shared by
 * the pipeline detail layout and the homepage.
 */
export function PipelineHeader({
  pipeline,
  showBreadcrumb = true,
}: {
  pipeline: Pipeline;
  showBreadcrumb?: boolean;
}) {
  const base = `/pipelines/${pipeline.id}`;

  return (
    <>
      {showBreadcrumb && (
        <Breadcrumbs items={[{ label: "Pipelines", href: "/" }, { label: pipeline.name }]} />
      )}
      <PageHeader
        title={pipeline.name}
        meta={
          <>
            <a
              href={pipeline.repository.url}
              className="inline-flex items-center gap-1.5"
              target="_blank"
              rel="noreferrer"
            >
              <Icons.github />
              {pipeline.repository.fullName}
              <Icons.external />
            </a>
            <span className="text-text-secondary">·</span>
            <span className="text-text-secondary">
              QA manifest <code className="mono">{pipeline.manifestPath}</code> @ {pipeline.manifestVersion}
            </span>
            <Pill tone="info">GitHub App installed</Pill>
          </>
        }
        actions={
          <>
            <Button disabled title="Coming soon">
              Trigger run
            </Button>
            <Button variant="primary" disabled title="Coming soon">
              Pipeline actions
            </Button>
          </>
        }
      />
      <Tabs
        tabs={[
          { label: "Pipeline", href: base },
          { label: "Runs", href: `${base}/runs`, prefix: true },
          { label: "Findings", href: `${base}/findings`, prefix: true },
          { label: "QA manifest", href: `${base}/manifest` },
          { label: "Settings", href: `${base}/settings` },
        ]}
      />
    </>
  );
}
