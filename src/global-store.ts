import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  resolveStorageRoot,
  ensurePrivateDirectory,
  assertPrivateDirectoryIdentity,
} from "./config.js";
import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import { AdminPlaneService } from "./admin-plane-service.js";
import {
  AlwaysReturnChangeSchema,
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

function activeSettings(
  snapshot: CanonicalProjectionSnapshot,
  configured: ReturnType<typeof latestAlwaysReturn>,
) {
  const active = new Set(
    snapshot.domain.knowledge
      .filter((k) => k.repoId === GLOBAL_STORE_ID && k.status === "active")
      .map((k) => k.id),
  );
  return [...configured.values()].filter(
    (e) => e.enabled && active.has(e.knowledge_id),
  );
}

export class GlobalStore {
  readonly reference: Extract<StoreReference, { kind: "global" }>;
  private transactionStore?: CanonicalTransactionStore;
  get store(): CanonicalTransactionStore {
    this.transactionStore ??= openStore(this.reference);
    return this.transactionStore;
  }
  constructor(private readonly storageRoot: string) {
    this.reference = Object.freeze({
      kind: "global",
      repoId: GLOBAL_STORE_ID,
      absolutePath: resolve(storageRoot, "global"),
    } as const);
  }

  private validatedPath() {
    const root = resolveStorageRoot(this.storageRoot);
    // Validate the reference against the configured home before using either
    // the store path or its parent in a filesystem operation.
    const path = this.reference.absolutePath;
    if (!path.startsWith(root + sep) || path !== join(root, "global")) {
      throw new Error("Global store must be directly inside the storage root");
    }
    return path;
  }

  async exists(): Promise<boolean> {
    try {
      const path = this.validatedPath();
      const directory = dirname(path);
      const status = await lstat(directory);
      if (!status.isDirectory())
        throw new Error("Storage root must be a real directory");
      await assertPrivateDirectoryIdentity(directory, status);
      const parent = await realpath(directory);
      const expected = join(parent, "global");
      if ((await lstat(path)).isSymbolicLink())
        throw new Error(
          "Global store must be directly inside the storage root, not a symbolic link",
        );
      const actual = await realpath(path);
      if (actual !== expected || !actual.startsWith(parent + sep))
        throw new Error(
          "Global store must be directly inside the storage root",
        );
      if (!(await lstat(actual)).isDirectory())
        throw new Error("Global store must be a real directory");
      for (const child of [
        "knowledge",
        "events",
        "transactions",
        "index.sqlite",
        "index.sqlite-wal",
        "index.sqlite-shm",
      ]) {
        const path = join(actual, child);
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (info?.isSymbolicLink())
          throw new Error("Global store entries must not be symbolic links");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async initialize() {
    const path = this.validatedPath();
    await ensurePrivateDirectory(dirname(path));
    await this.exists();
    await ensurePrivateDirectory(path);
    for (const dir of ["knowledge", "events"])
      await ensurePrivateDirectory(join(path, dir));
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
    if (!(await this.exists())) return [];
    const { records } = await this.store.readSnapshot();
    return [...latestAlwaysReturn(records).values()];
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
      const configured = latestAlwaysReturn(snapshot.records);
      const settings = activeSettings(snapshot, configured);
      const current = configured.get(id);
      const isActive = knowledge?.status === "active";
      const result = {
        knowledge_id: id,
        always_return: !!current && isActive,
        always_return_count: settings.length,
        ...(current ? { set_by: current.actor } : {}),
      };
      const reject = (reason: NonNullable<AlwaysReturnResult["reason"]>) => ({
        transaction: null,
        value: { ...result, state: "rejected" as const, reason },
      });
      const removingCliReservation =
        !enabled && !!current && actor.actor === "cli";
      if (!knowledge && !removingCliReservation) return reject("not_global");
      if (!isActive && !removingCliReservation) return reject("not_active");
      if (!enabled && actor.actor === "mcp" && current?.actor === "cli")
        return reject("set_by_cli");
      if (enabled && !current && configured.size >= ALWAYS_RETURN_LIMIT)
        return reject("limit_reached");
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
                payload: AlwaysReturnChangeSchema.parse({
                  event_id: eventId,
                  knowledge_id: id,
                  enabled,
                  ...actor,
                  recorded_at: recordedAt,
                }),
              },
            },
          ],
        },
        value: {
          knowledge_id: id,
          state: "changed",
          always_return: enabled,
          always_return_count:
            settings.length + (enabled ? 1 : isActive ? -1 : 0),
          ...(enabled ? { set_by: actor.actor } : {}),
        },
      };
    });
  }
}
