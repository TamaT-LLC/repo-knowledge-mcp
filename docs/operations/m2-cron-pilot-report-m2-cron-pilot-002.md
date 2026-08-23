# M2 cron pilot 最終 report（m2-cron-pilot-002）

[M2 cron pilot 計画](./m2-cron-pilot-plan.md) に基づき、14 UTC 日の運用結果と M2 go/no-go を記録する。

## 1. pilot 概要

| 項目 | 値 |
| --- | --- |
| pilot_id | `m2-cron-pilot-002` |
| 対象 repository | `TamaT-LLC/repo-knowledge-mcp` |
| 期間（UTC） | `2026-08-09` 〜 `2026-08-22`（14 日間） |
| cron 頻度 | 15 分間隔 |
| 蒸留経路 | cron は送信なし / Claude Max host-assisted（明示セッション 6 回、各回 1 lease ずつ処理） |
| 日次記録 log | `~/.repo-knowledge/pilot/m2-cron-pilot-002.jsonl` |

Anthropic API と API key は使用していない。

host-assisted session では review comment 本文だけを一時的な明示同意の下で扱い、diff hunk は送信していない。

各 session の終了後は provider と host-assisted の送信設定を無効化し、doctor で確認した。

## 2. 日次記録の集約結果

`pilot:daily -- summarize --require-complete` は 2026-08-23 09:36 JST に exit 0 で完了した。

| 判定材料 | 実測値 | go 条件 | 判定 |
| --- | --- | --- | --- |
| `coverage.complete` | `true`（observed 14 / expected 14 / missing 0） | `true` | go |
| `sync.run_success_rate` | `0.9947955390334573`（1,338 / 1,345 runs） | 0.99 以上 | go |
| `sync.unchanged`（重複 no-op 件数） | 21、canonical integrity failure 0 日 | 増殖なしの傍証 | go |
| `sync.retry_attempts / failed_pull_requests` | `0 / []` | rollback 条件に非該当 | go |
| `backlog.pending_jobs_monotonically_increasing` | `false` | `false` | go |
| `backlog.final_pending_jobs / pending_jobs_by_day` | `0 / [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]` | 系列の目視確認 | go |
| `quality.days_by_gate_status.integrity_failure` | 0 日（pass 14 日） | 0 日 | go |

```json
{
  "backlog": {
    "backlog_series_gaps": [],
    "final_failed_jobs": 0,
    "final_pending_jobs": 0,
    "max_failed_jobs": 0,
    "max_pending_jobs": 3,
    "pending_jobs_by_day": [
      { "date": "2026-08-09", "pending_jobs": 0 },
      { "date": "2026-08-10", "pending_jobs": 0 },
      { "date": "2026-08-11", "pending_jobs": 0 },
      { "date": "2026-08-12", "pending_jobs": 0 },
      { "date": "2026-08-13", "pending_jobs": 3 },
      { "date": "2026-08-14", "pending_jobs": 0 },
      { "date": "2026-08-15", "pending_jobs": 0 },
      { "date": "2026-08-16", "pending_jobs": 0 },
      { "date": "2026-08-17", "pending_jobs": 0 },
      { "date": "2026-08-18", "pending_jobs": 0 },
      { "date": "2026-08-19", "pending_jobs": 0 },
      { "date": "2026-08-20", "pending_jobs": 0 },
      { "date": "2026-08-21", "pending_jobs": 0 },
      { "date": "2026-08-22", "pending_jobs": 0 }
    ],
    "pending_jobs_monotonically_increasing": false
  },
  "coverage": {
    "complete": true,
    "days_expected": 14,
    "days_missing": 0,
    "days_observed": 14,
    "unrecorded_dates": []
  },
  "missing_days": [],
  "pilot_id": "m2-cron-pilot-002",
  "quality": {
    "days_by_gate_status": {
      "integrity_failure": 0,
      "metric_failure": 0,
      "not_run": 0,
      "pass": 14
    },
    "final_canonical_digest": "4a5fdea8009aec269b3ed1b7d9338e6759efbadf5c3131bdb2b81868a50c4ba5",
    "final_knowledge_total": 64,
    "final_outcomes_total": 0
  },
  "report_kind": "m2_pilot_summary_report",
  "schema_version": 1,
  "sync": {
    "discovered": 33,
    "failed_pull_requests": [],
    "ingested": 12,
    "jobs_created": 16,
    "retry_attempts": 0,
    "run_success_rate": 0.9947955390334573,
    "runs_failed": 7,
    "runs_total": 1345,
    "unchanged": 21
  },
  "window": {
    "duration_days": 14,
    "end_date": "2026-08-22",
    "start_date": "2026-08-09"
  }
}
```

- `backlog_series_gaps`: なし。
- review 結果と判断根拠: 14 日すべてに record があり、pending は Day 5 の 3 件を翌日までに処理して 0 へ戻したため、backlog は発散していない。
- reviewer: TakehiroT（operator）、Codex（operator-delegated evidence review）。

欠測日はない。

## 3. incident 一覧

| 発生日 | 事象 | 影響 | 対処 | rollback 条件該当 |
| --- | --- | --- | --- | --- |
| 2026-08-09 | `m2-cron-pilot-001` が開始日前日を記録した | pilot-001 を完了判定に使用できなかった | 監査証跡を保持し、期間外記録を拒否する guard を追加して pilot-002 を開始日の観測を失わず再開始した | pilot-001 のみ再開始、pilot-002 には非該当 |
| 2026-08-09 | launchd/global package と current main の canonical receipt schema に version skew を検出した | 定期 run の失敗前に検出し、canonical 破損と同期失敗は発生しなかった | package artifact gate を通した tarball で global package を更新し、doctor と wrapper sync を再確認した | 非該当 |
| 2026-08-14 | PR #109〜#113 の binary / canonical 更新後に global package を current main へ揃える必要が生じた | pilot record と canonical に破損はなかった | package artifact gate と package smoke を通した tarball で更新し、Codex、Claude、launchd、doctor を再確認した | 非該当 |
| 2026-08-15 | GitHub CLI の repository identity 解決が 30 秒で timeout した | 97 runs 中 1 run が失敗した | wrapper が構造化 failure marker を記録し、後続 run の成功と launchd exit 0 を確認した | 非該当 |
| 2026-08-17 | GitHub GraphQL が HTTP 503 を返した | 96 runs 中 6 runs が失敗した | failure marker を記録し、失敗前後と翌日の run が成功することを確認した | 非該当 |
| 2026-08-21 | host-assisted の 2 opt-in が有効な設定 drift を検出した | pending job は 0 で、2026-08-14 以降の distillation event と外部送信はなかった | 両 opt-in を直ちに無効化し、provider、diff hunk、auto activation も無効であることを doctor で確認した | 非該当 |

pilot-002 では、canonical 増殖、integrity failure、2 UTC 日連続の全 run 失敗、未回復の storage 破損は発生していない。

## 4. human rubric 評価結果

評価 artifact は local privacy boundary 内に mode 0600 で保存し、report には path と SHA-256 だけを記録する。

| checkpoint | evaluation path | SHA-256 |
| --- | --- | --- |
| Day 1 | `~/.repo-knowledge/pilot/m2-cron-pilot-002-rubric-day-01-evaluation.json` | `82d6ecad1b0118099d3a575c994e16817f10975ca98802438e4e5555e664365b` |
| Day 7 | `~/.repo-knowledge/pilot/m2-cron-pilot-002-rubric-day-07-evaluation.json` | `f6fdf787d253971578f1573cc13577b677c30cc01c9ca7407c857372bd963310` |
| Day 14 | `~/.repo-knowledge/pilot/m2-cron-pilot-002-rubric-day-14-evaluation.json` | `7ebd35cc04c823c08642a2dce5ddc1942455e49384af33a78b636905b3ba1b69` |

3 artifact は `PilotRubricEvaluationSchema` と `validatePilotRubricEvaluation` を通過した。

| query | day 1 | day 7 | day 14 | 悪化なし | day 14 が 3 以上 |
| --- | ---: | ---: | ---: | --- | --- |
| `q-error-handling` | 1 | 3 | 3 | yes | yes |
| `q-schema-validation` | 1 | 2 | 2 | yes | **no** |
| `q-lock-concurrency` | 1 | 4 | 4 | yes | yes |
| `q-sync-checkpoint` | 1 | 3 | 3 | yes | yes |
| `q-stdout-purity` | 1 | 2 | 2 | yes | **no** |

Day 14 の `q-schema-validation` では、入力 schema rule が rank 5 で top 3 の外に残った。

Day 14 の `q-stdout-purity` では、structured-log rule が rank 6 で top 3 の外に残った。

Day 7 から Day 14 まで保存対象 ranking ID に変化はなく、全 query で Day 1 からの悪化はなかった。

評価者と評価日時は、Day 1 が TakehiroT / 2026-08-09T06:55:44Z、Day 7 が Codex（operator-delegated）/ 2026-08-15T00:40:54Z、Day 14 が Codex（operator-delegated）/ 2026-08-22T00:37:17Z である。

## 5. 未達項目と follow-up Issue

| 未達項目 | 内容 | follow-up Issue |
| --- | --- | --- |
| schema relevance | `q-schema-validation` の直接的な入力 schema rule が top 3 に入らない | [#116](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/116) |
| stdout relevance | `q-stdout-purity` の structured-log rule が top 3 に入らない | [#116](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/116) |
| live outcome evidence | pilot 期間中の outcome が 0 件で、applied / violated / false-positive の live ranking 効果を評価できない | [#117](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/117) |
| M2 再評価 | 上記を実利用で検証していないため、新しい pilot_id で固定 query と rubric を再評価する必要がある | [#118](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/118) |

## 6. proposed 承認 / trusted-human auto activation 判断

- pilot 期間中に人間 review した proposed ルール数: 58 件（承認 58 / 却下 0）。
- 承認前の edit: 9 operations。
- 最終時点の未 review proposed: 5 件。
- trusted human 由来 candidate の precision 所感: review 済み 58 件に却下はなかったが、9 件は承認前の修正を要し、live outcome が 0 件なので production precision は算出しない。
- `trust.autoActivateTrustedHuman` の有効化検討へ進むか: **進まない**。
  - M2 の ranking gate が未達であり、outcome による実利用評価がなく、未 review proposed も 5 件残るためである。
  - `autoActivateTrustedHuman` は `false` のまま維持する。

## 7. M2 go/no-go 判断

| 完了条件 | 判定 | 根拠（§2〜§6 の参照） |
| --- | --- | --- |
| cron 同期で 2 週間運用できた | go | 14/14 日記録、成功率 0.9948、integrity failure 0、final pending 0、rollback 条件非該当（§2〜§3） |
| ランキングが体感に合う | no-go | Day 14 の 5 query 中 2 query が score 2 で、全 query score 3 以上の固定条件を満たさない（§4〜§5） |

**総合判定: M2 未完了**

M2 go を前提とする Issue #93 の npm release gate には進まない。

- 判断者: TakehiroT（maintainer/operator）、Codex（operator-delegated evidence review）。
- maintainer 2 名条件: 個人利用を基本とする現行方針では 2 人目の maintainer review は未充足であり、go の根拠には使用しない。
- 判断日: 2026-08-23。
