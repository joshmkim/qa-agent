import type { DeployCursor, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { Installation, Store } from "./index";

const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** Local-dev store. Not durable; everything is lost on restart. */
export class MemoryStore implements Store {
  private installations = new Map<number, Installation>();
  private repositories = new Map<string, Repository>();
  private stages = new Map<string, Stage>();
  private runs = new Map<string, Run>();
  private runCounters = new Map<string, number>();
  private deliveries = new Map<string, number>();

  async upsertInstallation(inst: Installation): Promise<void> {
    this.installations.set(inst.installationId, inst);
  }
  async getInstallation(installationId: number): Promise<Installation | undefined> {
    return this.installations.get(installationId);
  }
  async listInstallations(): Promise<Installation[]> {
    return [...this.installations.values()];
  }
  async deleteInstallation(installationId: number): Promise<void> {
    this.installations.delete(installationId);
    for (const repo of this.repositories.values()) {
      if (repo.installationId === installationId) {
        this.repositories.delete(repo.id);
      }
    }
  }

  async upsertRepository(repo: Repository): Promise<void> {
    this.repositories.set(repo.id, repo);
  }
  async getRepository(repositoryId: string): Promise<Repository | undefined> {
    return this.repositories.get(repositoryId);
  }
  async getRepositoryByFullName(fullName: string): Promise<Repository | undefined> {
    const needle = fullName.toLowerCase();
    for (const repo of this.repositories.values()) {
      if (repo.fullName.toLowerCase() === needle) return repo;
    }
    return undefined;
  }
  async listRepositories(installationId?: number): Promise<Repository[]> {
    const all = [...this.repositories.values()];
    return installationId === undefined
      ? all
      : all.filter((r) => r.installationId === installationId);
  }
  async deleteRepository(repositoryId: string): Promise<void> {
    this.repositories.delete(repositoryId);
  }

  async upsertStage(stage: Stage): Promise<void> {
    this.stages.set(stage.id, stage);
  }
  async getStage(stageId: string): Promise<Stage | undefined> {
    return this.stages.get(stageId);
  }
  async listStages(repositoryId: string): Promise<Stage[]> {
    return [...this.stages.values()]
      .filter((s) => s.repositoryId === repositoryId)
      .sort((a, b) => a.order - b.order);
  }
  async findStageByBranch(repositoryId: string, branch: string): Promise<Stage | undefined> {
    for (const s of this.stages.values()) {
      if (s.repositoryId === repositoryId && s.branch === branch) return s;
    }
    return undefined;
  }
  async setCursor(stageId: string, cursor: DeployCursor): Promise<void> {
    const stage = this.stages.get(stageId);
    if (!stage) throw new Error(`Stage ${stageId} not found`);
    this.stages.set(stageId, { ...stage, cursor });
  }
  async advanceCursor(stageId: string, expectedSha: string, next: DeployCursor): Promise<boolean> {
    const stage = this.stages.get(stageId);
    if (!stage) throw new Error(`Stage ${stageId} not found`);
    if (stage.cursor?.sha !== expectedSha) return false;
    this.stages.set(stageId, { ...stage, cursor: next });
    return true;
  }

  async createRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
    const stage = this.stages.get(run.stageId);
    if (stage) this.stages.set(stage.id, { ...stage, latestRunId: run.id });
  }
  async updateRun(runId: string, patch: Partial<Run>): Promise<Run> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`Run ${runId} not found`);
    const updated = { ...existing, ...patch };
    this.runs.set(runId, updated);
    return updated;
  }
  async getRun(runId: string): Promise<Run | undefined> {
    return this.runs.get(runId);
  }
  async listRuns(stageId: string, limit = 50): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => r.stageId === stageId)
      .sort((a, b) => b.number - a.number)
      .slice(0, limit);
  }
  async nextRunNumber(stageId: string): Promise<number> {
    const next = (this.runCounters.get(stageId) ?? 0) + 1;
    this.runCounters.set(stageId, next);
    return next;
  }

  async claimDelivery(deliveryId: string): Promise<boolean> {
    const now = Date.now();
    for (const [id, seenAt] of this.deliveries) {
      if (now - seenAt > DELIVERY_TTL_MS) this.deliveries.delete(id);
    }
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.set(deliveryId, now);
    return true;
  }
}
