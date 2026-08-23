# M2 acceptance traceability matrix

M2（v0.2）の明示要件を、実行可能な自動 test、quality gate、再現可能な運用 step へ対応付ける。
要件の出典は [repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md) の
§3.1（v0.2 ツール）、§6.4（outcome モデル）、§12.3（record_outcome）、§13（ランキング）、
§16（CLI）、§18（テスト方針）、§19 M2。
`npm run check` は automated 欄の test を実行し、Node 22/24 の matrix は CI で実行する。
`npm run golden` / `npm run quality:gate` / `npm run package:smoke` が gate 欄を実行する。
実運用でのみ確認できる項目は runbook の手順へ追跡する。
M1 の受け入れ条件 1〜63 は [M1 acceptance matrix](./m1-acceptance-matrix.md) が引き続き保証する。

## 同期（sync_repo / CLI sync）M2-1〜M2-8

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-1 | 保存済み checkpoint から (updatedAt, PR number) 昇順で増分同期する | [sync service test](../../test/sync-repo-service.test.ts)、[sync cursor test](../../test/sync-cursor.test.ts)、[checkpoint store test](../../test/sync-checkpoint-store.test.ts) | automated |
| M2-2 | CLI sync と MCP sync_repo が同一サービス・同一 summary schema を返す | [sync CLI/MCP E2E](../../test/sync-cli-mcp-e2e.test.ts) | automated process E2E |
| M2-3 | 同一 window の再同期・replay で canonical state が増殖しない | [sync CLI/MCP E2E](../../test/sync-cli-mcp-e2e.test.ts)、[M2 product E2E](../../test/m2-product-e2e.test.ts) | automated |
| M2-4 | checkpoint 境界以上の `--since` を fail-closed で拒否する | [sync service test](../../test/sync-repo-service.test.ts)、[sync CLI/MCP E2E](../../test/sync-cli-mcp-e2e.test.ts) | automated |
| M2-5 | 部分失敗時は最初の失敗 PR で停止し checkpoint が穴を作らない | [sync service test](../../test/sync-repo-service.test.ts) | automated |
| M2-6 | 同一リポジトリの同時 sync が lock で直列化される | [sync service test](../../test/sync-repo-service.test.ts)、[sync cron runbook](../operations/sync-cron-runbook.md) の lock contention 手順 | automated + operational |
| M2-7 | cron から非対話で運用できる（exit code 0/1/2 の契約を含む） | [CLI test](../../test/cli.test.ts) の sync / stats exit code test、[sync cron runbook](../operations/sync-cron-runbook.md) の crontab・診断・再試行手順 | automated + operational |
| M2-8 | provider disabled と enabled の双方で同期後の canonical state が整合する | [M2 product E2E](../../test/m2-product-e2e.test.ts) の収束 test | automated |

## outcome（record_outcome）M2-9〜M2-13c

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-9 | `event_id` で冪等化し、同一 payload の replay は再加算しない | [record outcome service test](../../test/record-outcome-mutation-service.test.ts)、[record_outcome MCP E2E](../../test/record-outcome-mcp-e2e.test.ts)、[M2 product E2E](../../test/m2-product-e2e.test.ts) | automated |
| M2-10 | 同一 `event_id` の異なる payload を fail-closed で拒否する | [record outcome service test](../../test/record-outcome-mutation-service.test.ts) | automated |
| M2-11 | applied / violated / not_applicable / false_positive を混ぜず別カウントで導出する | [record outcome service test](../../test/record-outcome-mutation-service.test.ts)、[domain projection test](../../test/domain-projection.test.ts) | automated |
| M2-12 | outcome は canonical event として記録され reindex で同じ集計へ再構築できる | [record outcome service test](../../test/record-outcome-mutation-service.test.ts)、[stats service test](../../test/stats-read-service.test.ts) の reindex 一致 | automated |
| M2-13 | active でない knowledge への outcome を拒否する | [record outcome service test](../../test/record-outcome-mutation-service.test.ts) | automated |
| M2-13a | host の安定した `event_key` から決定的に `event_id` を導出し、初回のみ記録して同一 request の retry を replay する | [record outcome service test](../../test/record-outcome-mutation-service.test.ts)、[record_outcome MCP E2E](../../test/record-outcome-mcp-e2e.test.ts) | automated + process E2E |
| M2-13b | `get_rules` だけでは outcome を記録せず、`event_key` 経路で観測確認・context・note が欠けると書き込み前に fail-closed とする | [record outcome service test](../../test/record-outcome-mutation-service.test.ts)、[MCP mutation tool test](../../test/mcp-mutation-tools.test.ts)、[record_outcome MCP E2E](../../test/record-outcome-mcp-e2e.test.ts) | automated + process E2E |
| M2-13c | Provider Adapter と host-assisted distillation を起動せず、get_rules → 判断 → record_outcome → stats を local canonical state だけで完結する | [record_outcome MCP E2E](../../test/record-outcome-mcp-e2e.test.ts)、[M2 product E2E](../../test/m2-product-e2e.test.ts) | automated process E2E |

## stats M2-14〜M2-17

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-14 | MCP stats と CLI stats が同一 schema version と同一集計値を返す | [stats CLI/MCP E2E](../../test/stats-cli-mcp-e2e.test.ts) | automated process E2E |
| M2-15 | 同一 canonical state から決定的（byte 一致）に集計し read-only である | [stats service test](../../test/stats-read-service.test.ts)、[stats CLI/MCP E2E](../../test/stats-cli-mcp-e2e.test.ts) | automated |
| M2-16 | 半開区間 window と UTC 日次 bucket の契約を守る | [stats service test](../../test/stats-read-service.test.ts) | automated |
| M2-17 | 空 repository / zero stats を正常応答とし cron 監視に使える | [stats service test](../../test/stats-read-service.test.ts)、[package smoke](../../scripts/package-smoke.mjs) の zero stats call | automated + gate |

## ランキング（outcome 重み付け）M2-18〜M2-20

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-18 | outcome スコアは上限付きで、violated は M1 violation boost と二重加算しない | [knowledge search test](../../test/knowledge-search.test.ts)、[outcome ranking golden](../../test/outcome-ranking-golden.test.ts) | automated |
| M2-19 | outcome ゼロ件の順位は M1 と一致し、自己強化ループを作らない（applied は最小 sample 未満で無効） | [outcome ranking golden](../../test/outcome-ranking-golden.test.ts)、[knowledge search test](../../test/knowledge-search.test.ts) | automated |
| M2-20 | ランキングが体感に合うことを MRR / NDCG + 人間 rubric で追跡する | [outcome ranking golden](../../test/outcome-ranking-golden.test.ts)、`npm run golden` の outcome fixture | automated + gate |
| M2-20a | read plane の英語 task と日本語 rule/detail の技術語差を term alias で補い、schema / stdout の直接関連ルールを top 3 に保つ | [knowledge search test](../../test/knowledge-search.test.ts)、[read service test](../../test/knowledge-read-service.test.ts)、[privacy-safe fixed-query fixture](../../test/fixtures/golden/m2-live-ranking-regression.json) | automated |
| M2-20b | `get_rules` は scope 適格性を維持したまま task 一致を severity 単独より先に評価し、同じ canonical state から決定的な順位を返す | [read service test](../../test/knowledge-read-service.test.ts) | automated |

## コード例（根拠制約付き detail）M2-21〜M2-23

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-21 | code_example は cited evidence に現れる token だけを使い、根拠のない API を拒否する | [code example test](../../test/code-example-distillation.test.ts)、[fixture](../../test/fixtures/code-example-distillation.json) | automated |
| M2-22 | 生成例は `generated_example: true` を必須とし、schema 変更は distillation digest に反映される | [code example test](../../test/code-example-distillation.test.ts)、[domain schema test](../../test/domain-schemas.test.ts) | automated |
| M2-23 | 例付き knowledge が canonical Markdown を経由して get_knowledge から読める | [knowledge code example test](../../test/knowledge-code-example.test.ts)、[M2 product E2E](../../test/m2-product-e2e.test.ts) | automated |

## quality gate M2-24〜M2-27

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-24 | §18.1 全指標に review 済み閾値があり、下回ると gate が失敗する | [quality gate test](../../test/quality-gate.test.ts)、[gate runner test](../../test/quality-gate-runner.test.ts)、[gate CLI test](../../test/quality-gate-cli.test.ts) | automated |
| M2-25 | thresholds は baseline artifact（measured_at + artifact_digest）に束縛され、別測定を拒否する | [quality gate test](../../test/quality-gate.test.ts)、[gate runner test](../../test/quality-gate-runner.test.ts) | automated |
| M2-26 | CI は network なし・credential なしで gate を毎回実行する（fixture drift 検出込み） | [CI workflow](../../.github/workflows/ci.yml) の `npm run golden` / `npm run quality:gate`、[gate CLI test](../../test/quality-gate-cli.test.ts) | CI gate |
| M2-27 | 実測・閾値更新・緩和は runbook の合意手続きに従う | [golden baseline runbook](../operations/golden-baseline-runbook.md) 手順 3〜4.1、[golden baseline test](../../test/golden-baseline.test.ts)、[baseline CLI test](../../test/golden-baseline-cli.test.ts) | automated + operational |

## trust / 自動 activation M2-28〜M2-29

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| M2-28 | `trust.autoActivateTrustedHuman` の出荷既定は false のまま維持される | [config test](../../test/config.test.ts)、[gate runner test](../../test/quality-gate-runner.test.ts) | automated |
| M2-29 | 有効化は quality gate 通過・live 閾値・人間 review・2 週間運用を前提とする明示 opt-in のみ | [auto activation runbook](../operations/trusted-human-auto-activation-runbook.md) の前提条件と rollback 手順 | operational |

## Cross-cutting M2 gates

- **product E2E**: [M2 product E2E](../../test/m2-product-e2e.test.ts) が
  sync → ingest → distill → approve → get_rules → record_outcome → stats を
  fake gh / fake provider だけで 1 本のフローとして検証する。provider disabled の
  cron 同期と、disabled → 後日 distill / enabled 同時蒸留の canonical 収束を含む。
- **real stdio interface**: [stdio E2E](../../test/mcp-stdio-e2e.test.ts) が実 child process で
  M2 追加分（sync_repo / record_outcome / stats）を含む全 11 tool の list / call と
  stdout の JSON-RPC 純度を確認する。
- **package smoke**: [package smoke](../../scripts/package-smoke.mjs) が `npm pack` した
  tarball のみを install し、公開 file、M2 command を含む CLI help、全 11 tool の list、
  fake gh 経由の sync_repo / stats / get_rules call、stdout 純度を検証する。
- **Node 22 / 24**: [CI workflow](../../.github/workflows/ci.yml) が両バージョンで
  `npm run check` / `npm run golden` / `npm run quality:gate` / `npm run package:smoke` を実行する。
- **2 週間 cron 運用（§19 M2 完了条件）**: 自動化不能の実運用項目。
  [M2 cron pilot 計画](../operations/m2-cron-pilot-plan.md) の固定条件で
  [sync cron runbook](../operations/sync-cron-runbook.md) の手順により運用し、
  日次記録は `pilot-daily-record-cli`（[test](../../test/pilot-daily-record-cli.test.ts)）、
  ランキングの体感評価は
  [pilot human rubric](./m2-pilot-human-rubric.json) と M2-20 の rubric、
  最終判定は
  [pilot report テンプレート](../operations/m2-cron-pilot-report-template.md) と
  [auto activation runbook](../operations/trusted-human-auto-activation-runbook.md) の
  棚卸し手順で記録する。
  pilot-002で合格した運用契約を変更せず、検索関連度、またはcanonical transactionとranking policyを変更しないoutcome input contractとMCP導線だけを修正した場合は、
  [修正後限定再評価計画](../operations/m2-post-fix-revalidation-plan.md)に従って運用証跡を再利用し、
  固定queryのnamed human評価と、record-outcome service test、MCP E2E、M2 product E2E、outcome golden、doctor、canonical検査を実施して
  [限定再評価report](../operations/m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md)へ記録する。
  別reviewerは共有された[observation](./evidence/m2-post-fix-revalidation-001-observation.json)、
  [human evaluation](./evidence/m2-post-fix-revalidation-001-human-evaluation.json)、
  [human approval](./evidence/m2-post-fix-revalidation-001-human-approval.json)を照合する。
