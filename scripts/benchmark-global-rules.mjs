/* global performance, process */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalTransactionStore } from "../dist/canonical-transaction-store.js";
import { GlobalStore } from "../dist/global-store.js";
import { createDomainId } from "../dist/ids.js";
import { serializeKnowledgeDocument } from "../dist/knowledge-document.js";
import { KnowledgeReadService } from "../dist/knowledge-read-service.js";

// M4-AC-032. Run locally after npm run build; exclude setup from request latency.
const root = await mkdtemp(join(tmpdir(), "rkm-global-benchmark-"));
try {
  const repository = new CanonicalTransactionStore(
    join(root, "repos", "bench"),
  );
  const options = { repo: "bench/repo", repoId: "bench", repository };
  const withoutGlobal = new KnowledgeReadService({
    ...options,
    globalStore: new GlobalStore(join(root, "empty")),
  });
  const global = new GlobalStore(root);
  await global.initialize();
  const date = "2026-01-01T00:00:00.000Z";
  const ids = Array.from({ length: 500 }, () => createDomainId("knowledge"));
  for (const [i, id] of ids.entries()) {
    const path = `knowledge/${id}.md`;
    await writeFile(
      join(global.reference.absolutePath, path),
      serializeKnowledgeDocument(
        path,
        {
          id,
          schema_version: 1,
          revision: 1,
          repo_id: global.reference.repoId,
          status: "active",
          category: "test",
          severity: "should",
          rule: `Validate schema ${i}`,
          created_at: date,
          updated_at: date,
          scope: ["src/**"],
          origin: { type: "manual" },
          activation: { origin: "human", pinned: false },
          related_ids: [],
        },
        "Check field types.",
      ),
      { mode: 0o600 },
    );
  }
  await global.reindex();
  const withGlobal = new KnowledgeReadService({
    ...options,
    globalStore: global,
  });
  await mkdir(repository.repositoryRoot, { recursive: true, mode: 0o700 });
  const request = { task: "schema", filePaths: ["src/input.ts"] };
  const measurements = [];
  const samples = [[], []];
  for (const i of Array(110).keys()) {
    const pair = [];
    for (const index of i % 2 ? [0, 1] : [1, 0]) {
      const start = performance.now();
      const result = await [withoutGlobal, withGlobal][index].getRules(request);
      const elapsed = performance.now() - start;
      if (index === 1 && result.global_matched_count !== 500)
        throw new Error("Expected 500 matching global rules");
      if (i >= 10) {
        samples[index].push(elapsed);
        pair.push({
          mode: index ? "global" : "baseline",
          elapsed_ms: elapsed,
          global_matched_count: result.global_matched_count ?? 0,
        });
      }
    }
    if (pair.length) measurements.push(pair);
  }
  const [baseline, globalP95] = samples.map(
    (values) => values.sort((a, b) => a - b)[94],
  );
  const build = createHash("sha256");
  for (const file of (await readdir("dist", { recursive: true }))
    .filter((f) => f.endsWith(".js"))
    .sort()) {
    build
      .update(file)
      .update("\0")
      .update(await readFile(join("dist", file)))
      .update("\0");
  }
  console.log(
    JSON.stringify(
      {
        command: "npm run build && node scripts/benchmark-global-rules.mjs",
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        build_sha256: build.digest("hex"),
        platform: process.platform,
        arch: process.arch,
        os_release: release(),
        cpu: cpus()[0]?.model,
        difference: "global − baseline",
        measurements,
        node: process.version,
        active_rules: 500,
        warmup: 10,
        samples: 100,
        baseline_p95_ms: baseline,
        global_p95_ms: globalP95,
        increase_ms: globalP95 - baseline,
      },
      null,
      2,
    ),
  );
  if (globalP95 - baseline > 20) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
