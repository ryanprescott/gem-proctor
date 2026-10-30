import { PgBoss } from "pg-boss";

export const HEARTBEAT_QUEUE = "system.heartbeat";
/** A heartbeat older than this means the queue isn't processing jobs. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
/** An eval on a local GPU takes minutes per trial. */
const LONG_JOB_EXPIRE_SECONDS = 6 * 60 * 60;

/**
 * pg-boss, started with the API (P0.md S4). The `system.heartbeat` job is sent at startup and every
 * minute; health reports the queue ok once a heartbeat job has gone through a worker recently.
 */
export class Queue {
  private lastHeartbeat: Date | null = null;
  private constructor(private readonly boss: PgBoss) {}

  static async start(connectionString: string, log: (msg: string, err?: unknown) => void): Promise<Queue> {
    // The pgboss schema is created (owned by gem_app) by the grants migration; gem_app can't create schemas.
    const boss = new PgBoss({ connectionString, schema: "pgboss", createSchema: false, max: 4 });
    boss.on("error", (err) => log("pg-boss error", err));
    await boss.start();
    const queue = new Queue(boss);
    await boss.createQueue(HEARTBEAT_QUEUE);
    await boss.work(HEARTBEAT_QUEUE, { pollingIntervalSeconds: 1 }, async () => {
      queue.lastHeartbeat = new Date();
    });
    await boss.schedule(HEARTBEAT_QUEUE, "* * * * *");
    await boss.send(HEARTBEAT_QUEUE, { at: new Date().toISOString() });
    return queue;
  }

  /** A long-running job queue: one job at a time, no retries (a failed job has already recorded why). */
  async workOne<T extends object>(name: string, handler: (data: T) => Promise<void>): Promise<void> {
    await this.boss.createQueue(name);
    await this.boss.work<T>(name, { pollingIntervalSeconds: 1 }, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  async send(name: string, data: object): Promise<void> {
    await this.boss.send(name, data, { retryLimit: 0, expireInSeconds: LONG_JOB_EXPIRE_SECONDS });
  }

  status(now = new Date()): { ok: boolean; lastHeartbeatAt: string | null } {
    const last = this.lastHeartbeat;
    return {
      ok: last !== null && now.getTime() - last.getTime() < HEARTBEAT_STALE_MS,
      lastHeartbeatAt: last?.toISOString() ?? null,
    };
  }

  /** Resolves once a heartbeat has been processed (startup checks and tests). */
  async waitForHeartbeat(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.lastHeartbeat) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 5000 });
  }
}
