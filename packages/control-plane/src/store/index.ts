import type { DeployCursor, Finding, Repository, Run, Stage } from "@qa-agent/shared-types";

/** One tenant: an org or user account that installed the GitHub App. */
export interface Installation {
  installationId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  /** "all" = every repo in the account; "selected" = explicit list. */
  repositorySelection: "all" | "selected";
  suspended: boolean;
  installedAt: string;
}

/**
 * Persistence boundary for the control plane. Everything is async so the
 * in-memory implementation used for local dev can be swapped for Postgres
 * without touching callers.
 */
export interface Store {
  // --- installations / repositories (written by webhooks) ---
  upsertInstallation(inst: Installation): Promise<void>;
  getInstallation(installationId: number): Promise<Installation | undefined>;
  listInstallations(): Promise<Installation[]>;
  deleteInstallation(installationId: number): Promise<void>;

  upsertRepository(repo: Repository): Promise<void>;
  getRepository(repositoryId: string): Promise<Repository | undefined>;
  getRepositoryByFullName(fullName: string): Promise<Repository | undefined>;
  listRepositories(installationId?: number): Promise<Repository[]>;
  deleteRepository(repositoryId: string): Promise<void>;

  // --- stages / cursors (user configuration) ---
  upsertStage(stage: Stage): Promise<void>;
  getStage(stageId: string): Promise<Stage | undefined>;
  listStages(repositoryId: string): Promise<Stage[]>;
  findStageByBranch(repositoryId: string, branch: string): Promise<Stage | undefined>;
  /** Unconditional set; used when a user seeds the first cursor manually. */
  setCursor(stageId: string, cursor: DeployCursor): Promise<void>;
  /**
   * Compare-and-set advance. Returns false (and leaves the cursor untouched)
   * if the current cursor SHA is not `expectedSha`, so two concurrent pushes
   * cannot both claim the same base.
   */
  advanceCursor(stageId: string, expectedSha: string, next: DeployCursor): Promise<boolean>;

  // --- runs ---
  createRun(run: Run): Promise<void>;
  updateRun(runId: string, patch: Partial<Run>): Promise<Run>;
  getRun(runId: string): Promise<Run | undefined>;
  listRuns(stageId: string, limit?: number): Promise<Run[]>;
  /** Runs across every stage of a repository, newest first. */
  listRunsByRepository(repositoryId: string, opts?: { stageId?: string; limit?: number }): Promise<Run[]>;
  nextRunNumber(stageId: string): Promise<number>;

  // --- findings (written by the orchestrator / triage judge) ---
  /** Insert or replace findings by id. Every finding must belong to `runId`. */
  saveFindings(runId: string, findings: Finding[]): Promise<void>;
  /** Most severe first, then newest. */
  listFindings(runId: string): Promise<Finding[]>;
  listFindingsByRepository(repositoryId: string, limit?: number): Promise<Finding[]>;
  getFinding(findingId: string): Promise<Finding | undefined>;

  // --- webhook delivery dedupe ---
  /** Returns true if this delivery id is new (and records it). */
  claimDelivery(deliveryId: string): Promise<boolean>;
}
