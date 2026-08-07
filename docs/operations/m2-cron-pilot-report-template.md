# M2 cron pilot 最終 report（テンプレート）

[M2 cron pilot 計画](./m2-cron-pilot-plan.md) の 2 週間運用が終わったら、
本テンプレートを複製して `pilot_id` ごとの最終 report を作成する。
すべての判定は機械出力（summarize / quality gate / rubric 評価 JSON）を引用して行い、
引用元ファイルのパスを必ず残す。

## 1. pilot 概要

| 項目            | 値                                                |
| --------------- | ------------------------------------------------- |
| pilot_id        | `m2-cron-pilot-___`                               |
| 対象 repository | `TamaT-LLC/repo-knowledge-mcp`                    |
| 期間（UTC）     | `YYYY-MM-DD` 〜 `YYYY-MM-DD`（14 日間）           |
| cron 頻度       | 15 分間隔                                         |
| provider 経路   | cron は送信なし / 蒸留は対話実行（実施回数: ___） |
| 日次記録 log    | `~/.repo-knowledge/pilot/<pilot_id>.jsonl`        |

## 2. 日次記録の集約結果

`pilot:daily -- summarize --require-complete` の出力 JSON をここに貼り、
次の表へ転記する。

| 判定材料                                         | 実測値 | go 条件                                  | 判定 |
| ------------------------------------------------ | ------ | ---------------------------------------- | ---- |
| coverage.complete                                |        | `true`                                   |      |
| sync.run_success_rate                            |        | 0.99 以上                                |      |
| sync.unchanged（重複 no-op 件数）                |        | 増殖なしの傍証                           |      |
| sync.retry_attempts / failed_pull_requests       |        | rollback 条件に非該当                    |      |
| backlog.pending_jobs_monotonically_increasing    |        | `false`（`null` は下記の人間 review へ） |      |
| backlog.final_pending_jobs / pending_jobs_by_day |        | 系列の目視確認（傍証）                   |      |
| quality.days_by_gate_status.integrity_failure    |        | 0 日                                     |      |

`pending_jobs_monotonically_increasing` が `null`（欠測による系列断絶で判定不能）の
場合は自動 go としない。`backlog_series_gaps` に列挙された日付の日次記録・incident を
人間が review して backlog が発散していないことを確認し、判断根拠をここに記録する:

- backlog_series_gaps: ___
- review 結果と判断根拠: ___
- reviewer: ___

欠測日（`missing_days`）:

| date | reason |
| ---- | ------ |
|      |        |

## 3. incident 一覧

rollback 条件への該当有無を明記する。該当した場合、この pilot は no-go であり
新 `pilot_id` での再実施が必要。

| 発生日 | 事象 | 影響 | 対処 | rollback 条件該当 |
| ------ | ---- | ---- | ---- | ----------------- |
|        |      |      |      |                   |

## 4. human rubric 評価結果

[m2-pilot-human-rubric.json](../testing/m2-pilot-human-rubric.json) に基づく
3 checkpoint の評価 JSON（`PilotRubricEvaluationSchema` 準拠）のパスを記載し、
score を転記する。

| query               | day 1 | day 7 | day 14 | 悪化なし | day 14 が 3 以上 |
| ------------------- | ----- | ----- | ------ | -------- | ---------------- |
| q-error-handling    |       |       |        |          |                  |
| q-schema-validation |       |       |        |          |                  |
| q-lock-concurrency  |       |       |        |          |                  |
| q-sync-checkpoint   |       |       |        |          |                  |
| q-stdout-purity     |       |       |        |          |                  |

評価者と評価日時: ___

## 5. 未達項目と follow-up Issue

| 未達項目 | 内容 | follow-up Issue |
| -------- | ---- | --------------- |
|          |      | #___            |

## 6. proposed 承認 / trusted-human auto activation 判断

- pilot 期間中に人間 review した proposed ルール数: ___ 件（承認 ___ / 却下 ___）
- trusted human 由来 candidate の precision 所感: ___
- `trust.autoActivateTrustedHuman` の有効化検討へ進むか: **進む / 進まない**
  - 判断根拠（quality gate 結果・precision 確認・運用実績）: ___
  - 進む場合は [auto activation runbook](./trusted-human-auto-activation-runbook.md)
    の前提条件 1〜4 の充足を別途確認する。本 report はその前提条件 4
    （2 週間運用実績）のエビデンスとなる

## 7. M2 go/no-go 判断

| 完了条件                     | 判定       | 根拠（§2〜§6 の参照） |
| ---------------------------- | ---------- | --------------------- |
| cron 同期で 2 週間運用できた | go / no-go |                       |
| ランキングが体感に合う       | go / no-go |                       |

**総合判定: M2 完了 / 未完了**

- 判断者（maintainer 2 名以上）: ___
- 判断日: ___
