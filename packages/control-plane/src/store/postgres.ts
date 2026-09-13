import type { JSONValue, Sql } from "postgres";
import type { DeployCursor, Finding, ManifestSnapshot, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { Installation, Store } from "./index";

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

/**
 * Durable store. Mirrors MemoryStore's behavior (the reference
 * implementation); the contract tests in store.contract.test.ts run against
 * both. Key columns hold what we query or compare-and-set on; reads always
 * return the `data` jsonb so callers see exactly the shared-types shape.
 */
export class PostgresStore implements Store {
  constructor(private readonly sql: Sql) {}

  /** postgres.js types json params structurally; our domain objects are plain JSON. */
  private json(value: unknown) {
    return this.sql.json(value as JSONValue);
  }

  // --- installations / repositories ---

  async upsertInstallation(inst: Installation): Promise<void> {
    await this.sql`
      INSERT INTO installations (installation_id, installed_at, data)
      VALUES (${inst.installationId}, ${inst.installedAt}, ${this.json(inst)})
      ON CONFLICT (installation_id) DO UPDATE
        SET installed_at = EXCLUDED.installed_at, data = EXCLUDED.data
    `;
  }
  async getInstallation(installationId: number): Promise<Installation | undefined> {
    const [row] = await this.sql`SELECT data FROM installations WHERE installation_id = ${installationId}`;
    return row?.data as Installation | undefined;
  }
  async listInstallations(): Promise<Installation[]> {
    const rows = await this.sql`SELECT data FROM installations ORDER BY installed_at, installation_id`;
    return rows.map((r) => r.data as Installation);
  }
  async deleteInstallation(installationId: number): Promise<void> {
    // Its repositories go too; their stages and runs are kept.
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM repositories WHERE installation_id = ${installationId}`;
      await tx`DELETE FROM installations WHERE installation_id = ${installationId}`;
    });
  }

  async upsertRepository(repo: Repository): Promise<void> {
    await this.sql`
      INSERT INTO repositories (id, installation_id, full_name, data)
      VALUES (${repo.id}, ${repo.installationId}, ${repo.fullName}, ${this.json(repo)})
      ON CONFLICT (id) DO UPDATE
        SET installation_id = EXCLUDED.installation_id, full_name = EXCLUDED.full_name, data = EXCLUDED.data
    `;
  }
  async getRepository(repositoryId: string): Promise<Repository | undefined> {
    const [row] = await this.sql`SELECT data FROM repositories WHERE id = ${repositoryId}`;
    return row?.data as Repository | undefined;
  }
  async getRepositoryByFullName(fullName: string): Promise<Repository | undefined> {
    const [row] = await this.sql`SELECT data FROM repositories WHERE lower(full_name) = lower(${fullName})`;
    return row?.data as Repository | undefined;
  }
  async listRepositories(installationId?: number): Promise<Repository[]> {
    const rows =
      installationId === undefined
        ? await this.sql`SELECT data FROM repositories ORDER BY full_name`
        : await this.sql`SELECT data FROM repositories WHERE installation_id = ${installationId} ORDER BY full_name`;
    return rows.map((r) => r.data as Repository);
  }
  async deleteRepository(repositoryId: string): Promise<void> {
    await this.sql`DELETE FROM repositories WHERE id = ${repositoryId}`;
  }

  // --- stages / cursors ---

  async upsertStage(stage: Stage): Promise<void> {
    await this.sql`
      INSERT INTO stages (id, repository_id, branch, sort_order, cursor_sha, data)
      VALUES (${stage.id}, ${stage.repositoryId}, ${stage.branch}, ${stage.order}, ${stage.cursor?.sha ?? null}, ${this.json(stage)})
      ON CONFLICT (id) DO UPDATE
        SET repository_id = EXCLUDED.repository_id, branch = EXCLUDED.branch, sort_order = EXCLUDED.sort_order,
            cursor_sha = EXCLUDED.cursor_sha, data = EXCLUDED.data
    `;
  }
  async getStage(stageId: string): Promise<Stage | undefined> {
    const [row] = await this.sql`SELECT data FROM stages WHERE id = ${stageId}`;
    return row?.data as Stage | undefined;
  }
  async listStages(repositoryId: string): Promise<Stage[]> {
    const rows = await this.sql`SELECT data FROM stages WHERE repository_id = ${repositoryId} ORDER BY sort_order, id`;
    return rows.map((r) => r.data as Stage);
  }
  async findStageByBranch(repositoryId: string, branch: string): Promise<Stage | undefined> {
    const [row] = await this.sql`
      SELECT data FROM stages WHERE repository_id = ${repositoryId} AND branch = ${branch} ORDER BY sort_order, id LIMIT 1
    `;
    return row?.data as Stage | undefined;
  }
  async setCursor(stageId: string, cursor: DeployCursor): Promise<void> {
    const rows = await this.sql`
      UPDATE stages SET cursor_sha = ${cursor.sha}, data = jsonb_set(data, '{cursor}', ${this.json(cursor)})
      WHERE id = ${stageId}
      RETURNING id
    `;
    if (rows.length === 0) throw new Error(`Stage ${stageId} not found`);
  }
  async advanceCursor(stageId: string, expectedSha: string, next: DeployCursor): Promise<boolean> {
    // Single-statement compare-and-set: only one of any concurrent callers matches.
    const rows = await this.sql`
      UPDATE stages SET cursor_sha = ${next.sha}, data = jsonb_set(data, '{cursor}', ${this.json(next)})
      WHERE id = ${stageId} AND cursor_sha = ${expectedSha}
      RETURNING id
    `;
    if (rows.length > 0) return true;
    const [exists] = await this.sql`SELECT 1 FROM stages WHERE id = ${stageId}`;
    if (!exists) throw new Error(`Stage ${stageId} not found`);
    return false;
  }

  // --- runs ---

  async createRun(run: Run): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO runs (id, repository_id, stage_id, number, status, started_at, data)
        VALUES (${run.id}, ${run.repositoryId}, ${run.stageId}, ${run.number}, ${run.status}, ${run.startedAt}, ${this.json(run)})
      `;
      // Keep numbering monotonic when runs are inserted with an explicit number (dev seed).
      await tx`
        INSERT INTO run_counters (stage_id, last_number) VALUES (${run.stageId}, ${run.number})
        ON CONFLICT (stage_id) DO UPDATE SET last_number = GREATEST(run_counters.last_number, EXCLUDED.last_number)
      `;
      await tx`
        UPDATE stages SET data = jsonb_set(data, '{latestRunId}', to_jsonb(${run.id}::text)) WHERE id = ${run.stageId}
      `;
    });
  }
  async updateRun(runId: string, patch: Partial<Run>): Promise<Run> {
    // `||` on jsonb is a shallow merge, same as { ...existing, ...patch }.
    const [row] = await this.sql`
      UPDATE runs
      SET data = data || ${this.json(patch)},
          status = COALESCE(${patch.status ?? null}, status),
          started_at = COALESCE(${patch.startedAt ?? null}::timestamptz, started_at)
      WHERE id = ${runId}
      RETURNING data
    `;
    if (!row) throw new Error(`Run ${runId} not found`);
    return row.data as Run;
  }
  async getRun(runId: string): Promise<Run | undefined> {
    const [row] = await this.sql`SELECT data FROM runs WHERE id = ${runId}`;
    return row?.data as Run | undefined;
  }
  async listRuns(stageId: string, limit = 50): Promise<Run[]> {
    const rows = await this.sql`SELECT data FROM runs WHERE stage_id = ${stageId} ORDER BY number DESC LIMIT ${limit}`;
    return rows.map((r) => r.data as Run);
  }
  async listRunsByRepository(
    repositoryId: string,
    opts: { stageId?: string; limit?: number } = {},
  ): Promise<Run[]> {
    const limit = opts.limit ?? 50;
    const rows =
      opts.stageId === undefined
        ? await this.sql`
            SELECT data FROM runs WHERE repository_id = ${repositoryId} ORDER BY started_at DESC LIMIT ${limit}
          `
        : await this.sql`
            SELECT data FROM runs WHERE repository_id = ${repositoryId} AND stage_id = ${opts.stageId}
            ORDER BY started_at DESC LIMIT ${limit}
          `;
    return rows.map((r) => r.data as Run);
  }
  async nextRunNumber(stageId: string): Promise<number> {
    const [row] = await this.sql`
      INSERT INTO run_counters (stage_id, last_number) VALUES (${stageId}, 1)
      ON CONFLICT (stage_id) DO UPDATE SET last_number = run_counters.last_number + 1
      RETURNING last_number
    `;
    return row!.last_number as number;
  }

  // --- findings ---

  async saveFindings(runId: string, findings: Finding[]): Promise<void> {
    for (const f of findings) {
      if (f.runId !== runId) throw new Error(`Finding ${f.id} belongs to run ${f.runId}, not ${runId}`);
    }
    if (findings.length === 0) return;
    await this.sql.begin(async (tx) => {
      const [run] = await tx`SELECT repository_id FROM runs WHERE id = ${runId}`;
      if (!run) throw new Error(`Run ${runId} not found`);
      for (const f of findings) {
        await tx`
          INSERT INTO findings (id, run_id, repository_id, severity_rank, reported_at, data)
          VALUES (${f.id}, ${runId}, ${run.repository_id as string}, ${SEVERITY_RANK[f.severity]}, ${f.reportedAt}, ${this.json(f)})
          ON CONFLICT (id) DO UPDATE
            SET run_id = EXCLUDED.run_id, repository_id = EXCLUDED.repository_id,
                severity_rank = EXCLUDED.severity_rank, reported_at = EXCLUDED.reported_at, data = EXCLUDED.data
        `;
      }
    });
  }
  async listFindings(runId: string): Promise<Finding[]> {
    const rows = await this.sql`
      SELECT data FROM findings WHERE run_id = ${runId} ORDER BY severity_rank, reported_at DESC, id
    `;
    return rows.map((r) => r.data as Finding);
  }
  async listFindingsByRepository(repositoryId: string, limit = 200): Promise<Finding[]> {
    const rows = await this.sql`
      SELECT data FROM findings WHERE repository_id = ${repositoryId}
      ORDER BY severity_rank, reported_at DESC, id LIMIT ${limit}
    `;
    return rows.map((r) => r.data as Finding);
  }
  async getFinding(findingId: string): Promise<Finding | undefined> {
    const [row] = await this.sql`SELECT data FROM findings WHERE id = ${findingId}`;
    return row?.data as Finding | undefined;
  }

  // --- QA manifests ---

  async saveManifestSnapshot(repositoryId: string, snapshot: ManifestSnapshot): Promise<void> {
    await this.sql`
      INSERT INTO manifest_snapshots (repository_id, commit_sha, loaded_at, data)
      VALUES (${repositoryId}, ${snapshot.commitSha}, ${snapshot.loadedAt}, ${this.json(snapshot)})
      ON CONFLICT (repository_id, commit_sha) DO UPDATE SET loaded_at = EXCLUDED.loaded_at, data = EXCLUDED.data
    `;
  }
  async getManifestSnapshot(repositoryId: string, commitSha: string): Promise<ManifestSnapshot | undefined> {
    const [row] = await this.sql`
      SELECT data FROM manifest_snapshots WHERE repository_id = ${repositoryId} AND commit_sha = ${commitSha}
    `;
    return row?.data as ManifestSnapshot | undefined;
  }
  async getLatestManifestSnapshot(repositoryId: string): Promise<ManifestSnapshot | undefined> {
    const [row] = await this.sql`
      SELECT data FROM manifest_snapshots WHERE repository_id = ${repositoryId} ORDER BY loaded_at DESC LIMIT 1
    `;
    return row?.data as ManifestSnapshot | undefined;
  }

  // --- webhook delivery dedupe ---

  async claimDelivery(deliveryId: string): Promise<boolean> {
    await this.sql`DELETE FROM webhook_deliveries WHERE received_at < now() - interval '24 hours'`;
    const rows = await this.sql`
      INSERT INTO webhook_deliveries (id) VALUES (${deliveryId}) ON CONFLICT (id) DO NOTHING RETURNING id
    `;
    return rows.length > 0;
  }
}
