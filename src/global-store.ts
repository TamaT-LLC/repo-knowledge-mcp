import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import { AdminPlaneService } from "./admin-plane-service.js";
import {
  ALWAYS_RETURN_LIMIT,
  ALWAYS_RETURN_PATH,
  GLOBAL_STORE_ID,
  latestAlwaysReturn,
  type AlwaysReturnActor,
  type AlwaysReturnResult,
} from "./global-always-return.js";
import { createDomainId } from "./ids.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";
import { KnowledgeIdSchema } from "./domain-schemas.js";

export type StoreReference =
  | { kind: "repository"; repoId: string; absolutePath: string }
  | { kind: "global"; repoId: typeof GLOBAL_STORE_ID; absolutePath: string };

export function openStore(ref: StoreReference) {
  return new CanonicalTransactionStore(ref.absolutePath, {
    global: ref.kind === "global",
  });
}

function activeSettings(snapshot: CanonicalProjectionSnapshot) {
  const active = new Set(
    snapshot.domain.knowledge
      .filter((k) => k.repoId === GLOBAL_STORE_ID && k.status === "active")
      .map((k) => k.id),
  );
  return [...latestAlwaysReturn(snapshot.records).values()].filter(
    (e) => e.enabled && active.has(e.knowledge_id),
  );
}

export class GlobalStore {
  readonly reference: Extract<StoreReference, { kind: "global" }>;
  readonly store: CanonicalTransactionStore;
  constructor(storageRoot: string) {
    this.reference = {
      kind: "global",
      repoId: GLOBAL_STORE_ID,
      absolutePath: join(storageRoot, "global"),
    };
    this.store = openStore(this.reference);
  }

  async exists(): Promise<boolean> {
    try {
      const info = await lstat(this.reference.absolutePath);
      if (!info.isDirectory())
        throw new Error("Global store must be a directory");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async initialize() {
    if (!(await this.exists()))
      await mkdir(this.reference.absolutePath, {
        recursive: true,
        mode: 0o700,
      });
    for (const dir of ["knowledge", "events"])
      await mkdir(join(this.reference.absolutePath, dir), {
        recursive: true,
        mode: 0o700,
      });
  }

  async addActive(input: Parameters<AdminPlaneService["addActive"]>[0]) {
    await this.initialize();
    return new AdminPlaneService({
      repo: GLOBAL_STORE_ID,
      repoId: GLOBAL_STORE_ID,
      repository: this.store,
    }).addActive(input);
  }
  async reindex() {
    await this.initialize();
    const snapshot = await this.store.reindex();
    return {
      store_id: GLOBAL_STORE_ID,
      knowledge_count: snapshot.domain.knowledge.length,
      canonical_digest: snapshot.canonicalDigest,
    };
  }
  async readRules(task?: string) {
    return (await this.exists()) ? this.store.readGlobalRules(task) : undefined;
  }
  async listAlwaysReturn() {
    return (await this.exists())
      ? activeSettings(await this.store.readSnapshot())
      : [];
  }
  async setAlwaysReturn(
    id: string,
    enabled: boolean,
    actor: AlwaysReturnActor,
  ): Promise<AlwaysReturnResult> {
    KnowledgeIdSchema.parse(id);
    if (!(await this.exists()))
      return {
        knowledge_id: id,
        state: "rejected",
        reason: "not_global",
        always_return: false,
        always_return_count: 0,
      };
    return this.store.runLockedMutation<AlwaysReturnResult>((snapshot) => {
      const knowledge = snapshot.domain.knowledge.find(
        (k) => k.id === id && k.repoId === GLOBAL_STORE_ID,
      );
      const settings = activeSettings(snapshot);
      const current = settings.find((e) => e.knowledge_id === id);
      const result = {
        knowledge_id: id,
        always_return: !!current,
        always_return_count: settings.length,
        ...(current ? { set_by: current.actor } : {}),
      };
      let reason: AlwaysReturnResult["reason"];
      if (!knowledge) reason = "not_global";
      else if (knowledge.status !== "active") reason = "not_active";
      else if (!enabled && actor.actor === "mcp" && current?.actor === "cli")
        reason = "set_by_cli";
      else if (enabled && !current && settings.length >= ALWAYS_RETURN_LIMIT)
        reason = "limit_reached";
      if (reason)
        return {
          transaction: null,
          value: { ...result, state: "rejected", reason },
        };
      if (enabled === !!current)
        return { transaction: null, value: { ...result, state: "unchanged" } };
      const recordedAt = new Date().toISOString();
      const transactionId = createDomainId("transaction");
      const eventId = createDomainId("event");
      return {
        transaction: {
          createdAt: recordedAt,
          transactionId,
          fileWrites: [],
          appendRecords: [
            {
              targetPath: ALWAYS_RETURN_PATH,
              record: {
                schema_version: 1,
                record_id: eventId,
                record_type: "GlobalAlwaysReturnChanged",
                recorded_at: recordedAt,
                transaction_id: transactionId,
                payload: {
                  event_id: eventId,
                  knowledge_id: id,
                  enabled,
                  ...actor,
                  recorded_at: recordedAt,
                },
              },
            },
          ],
        },
        value: {
          knowledge_id: id,
          state: "changed",
          always_return: enabled,
          always_return_count: settings.length + (enabled ? 1 : -1),
          ...(enabled ? { set_by: actor.actor } : {}),
        },
      };
    });
  }
}
