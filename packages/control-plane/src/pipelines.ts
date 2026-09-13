import type { Pipeline, Repository } from "@qa-agent/shared-types";
import type { Store } from "./store";

/**
 * A pipeline is a view over a connected repository and its stages, not a
 * stored entity: `pipeline.id` is the repository id, which is also what run
 * links (check runs, Slack) put in `/pipelines/:id`.
 */
export async function toPipeline(store: Store, repository: Repository): Promise<Pipeline> {
  const [stages, installation] = await Promise.all([
    store.listStages(repository.id),
    store.getInstallation(repository.installationId),
  ]);
  return {
    id: repository.id,
    repository,
    name: repository.name,
    stages,
    // Placeholders until the manifest loader lands (pipeline-steps.MD Phase 3).
    manifestPath: ".qa/manifest.yaml",
    manifestVersion: "unloaded",
    createdAt: installation?.installedAt ?? new Date().toISOString(),
  };
}
