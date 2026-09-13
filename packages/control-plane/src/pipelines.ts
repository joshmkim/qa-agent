import type { Pipeline, Repository } from "@qa-agent/shared-types";
import { DEFAULT_MANIFEST_PATH } from "./manifest/load";
import type { Store } from "./store";

/**
 * A pipeline is a view over a connected repository and its stages, not a
 * stored entity: `pipeline.id` is the repository id, which is also what run
 * links (check runs, Slack) put in `/pipelines/:id`.
 */
export async function toPipeline(store: Store, repository: Repository): Promise<Pipeline> {
  const [stages, installation, manifest] = await Promise.all([
    store.listStages(repository.id),
    store.getInstallation(repository.installationId),
    store.getLatestManifestSnapshot(repository.id),
  ]);
  return {
    id: repository.id,
    repository,
    name: repository.name,
    stages,
    manifestPath: manifest?.path ?? DEFAULT_MANIFEST_PATH,
    manifestVersion: manifest?.product?.manifestVersion ?? (manifest ? manifest.status : "none"),
    createdAt: installation?.installedAt ?? new Date().toISOString(),
  };
}
