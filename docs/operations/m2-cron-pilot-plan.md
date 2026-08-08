# M2 cron pilot 計画（2 週間運用）

M2 完了条件「cron 同期で 2 週間運用し、ランキングが体感に合う」
（[repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md) §19 M2）を、
再現可能な計画・日次記録・human rubric・最終 report で検証するための固定計画。
運用手順そのものは [sync cron runbook](./sync-cron-runbook.md) に従い、
本計画は pilot 固有の決定事項（対象・頻度・経路・privacy・rollback）と記録様式を固定する。

## pilot 識別子

- `pilot_id`: `m2-cron-pilot-001`
- 期間: 開始日（`--since` を確定した初回同期の翌 UTC 日）から **14 UTC 日**
- 日次記録 log: `~/.repo-knowledge/pilot/m2-cron-pilot-001.jsonl`（追記専用 JSONL）

開始日・終了日は pilot 開始時に本節へ追記し、以後変更しない。
中断した場合は新しい `pilot_id`（`-002` 以降）で最初からやり直す。

- **開始日**: 2026-08-09（UTC）。初回同期（全期間、`--since` なし）は 2026-08-08 に完了し、
  checkpoint は PR #84 / `2026-08-07T13:38:02Z`。同日中に再実行で `discovered: 0` の冪等性を確認済み
- **終了日**: 2026-08-22（UTC、開始日を day 1 として 14 UTC 日）
- **rubric checkpoint**: day 1 = 2026-08-09、day 7 = 2026-08-15、day 14 = 2026-08-22
- **運用ノート**: 実行環境は operator の macOS（常時稼働ではない）。スリープ中の cron 未実行は
  欠測理由付き日次記録で追跡する。cron の失敗通知は MAILTO ではなく
  `~/log/repo-knowledge-sync.err` と日次記録の `runs_failed` で追跡する（ローカル MTA 未設定のため）

## 固定条件

### 対象 repository

- **`TamaT-LLC/repo-knowledge-mcp`（本リポジトリ、dogfooding）** を対象とする
- 選定理由: レビュー活動が継続しており、評価者自身が「体感」を持つ唯一のリポジトリで
  あるため、rubric 評価（後述）の妥当性を担保できる
- 対象の追加・変更は pilot の再開始（新 `pilot_id`）として扱う

### cron 頻度

- **15 分間隔**（[sync cron runbook](./sync-cron-runbook.md) の crontab 例と同一）
- 日次記録を日単位で切り出せるよう、sync summary の log は **UTC 日付単位で分割**する:

```crontab
MAILTO=ops@example.com
PATH=/opt/homebrew/bin:/usr/bin:/bin
*/15 * * * * repo-knowledge sync TamaT-LLC/repo-knowledge-mcp >> "$HOME/log/repo-knowledge-sync-$(date -u +\%F).jsonl" 2>> "$HOME/log/repo-knowledge-sync.err" || echo "repo-knowledge sync failed with exit $?"
```

### provider 経路

- cron 同期は **provider 送信なし**（`llm.allowCloudTransmission` は無効のまま）。
  runbook の推奨どおり、cron は raw 保存と job 化までを担う
- 蒸留は operator が対話セッションで実行する（頻度は任意、ただし
  backlog（`pending_jobs`）が日次記録で単調増加し続けないよう週 2 回以上を目安とする）

### privacy 条件

- GitHub トークンを保存しない（認証は `gh` CLI に委譲）
- cron 環境・log ファイルに review content（コメント本文）を書かない。
  sync summary は件数と PR 番号のみ、日次記録 log も件数・PR 番号・digest のみを持つ
- クラウド送信は上記 provider 経路の明示実行のみ。pilot 期間中に
  `allowCloudTransmission` の既定を変更しない
- 日次記録 log と最終 report に secret・コード断片を含めない

### rollback 条件

次のいずれかが起きたら cron エントリを無効化（コメントアウト）して pilot を中断し、
incident として最終 report に記録する:

1. 同期の再実行で canonical state が増殖した（同一 window の 2 回目が
   `discovered: 0` または全件 `unchanged` にならない）
2. `npm run quality:gate` が `integrity_failure`（exit 2）になった
3. sync の失敗が 2 UTC 日連続で全 run に及んだ（`runs_failed == runs_total`）
4. storage 破損（`SYNC_CHECKPOINT_INVALID` 等）が自動回復しなかった

中断後の再開は原因修復と記録を済ませたうえで、新 `pilot_id` で最初から行う。
なお `trust.autoActivateTrustedHuman` は pilot 期間中 **必ず既定（`false`）のまま**とし、
有効化の検討は pilot 完了後に
[auto activation runbook](./trusted-human-auto-activation-runbook.md) へ引き継ぐ。

## 日次記録（機械記録）

毎 UTC 日の終了後に、当日分の sync log・stats・quality gate 出力を
`pilot-daily-record-cli` で 1 行の JSONL record に集約する。schema は
`src/pilot-daily-record.ts` の zod schema で固定されており、
成功率・重複（`unchanged`）・失敗/retry・job backlog・quality metric を含む。

```console
$ repo-knowledge stats TamaT-LLC/repo-knowledge-mcp > /tmp/stats-$(date -u +%F).json
$ npm run --silent quality:gate > /tmp/quality-gate-$(date -u +%F).json
$ npm run --silent pilot:daily -- record \
    --log ~/.repo-knowledge/pilot/m2-cron-pilot-001.jsonl \
    --pilot m2-cron-pilot-001 \
    --date $(date -u +%F) \
    --sync-log ~/log/repo-knowledge-sync-$(date -u +%F).jsonl \
    --stats /tmp/stats-$(date -u +%F).json \
    --quality-gate /tmp/quality-gate-$(date -u +%F).json
```

- 記録できなかった日は放置せず、翌日以降に **欠測理由付き**で記録する
  （`--missing --reason "..."`）。summarize は理由のない欠落日を
  `unrecorded_dates` として検出する
- 1 日 1 record。同一日の再記録は CLI が `PILOT_DUPLICATE_DATE` で拒否する
- 期間終了後（または進捗確認時）に集約する:

```console
$ npm run --silent pilot:daily -- summarize \
    --log ~/.repo-knowledge/pilot/m2-cron-pilot-001.jsonl \
    --start <開始日> --days 14 --require-complete
```

## human rubric 評価（体感評価）

「ランキングが体感に合う」は
[m2-pilot-human-rubric.json](../testing/m2-pilot-human-rubric.json)
（`rubric_id: m2-pilot-human-rubric-v1`）で評価する。
様式は outcome-ranking-golden の rubric（M2-20）を live 評価向けに流用したもので、
固定 query 5 件 × 評価 criteria + 4 段階 scale + 3 checkpoint（day 1 / 7 / 14）から成る。

- 各 checkpoint で全 query を `get_rules` で実行し、rubric の criteria を判定して
  score を付ける。評価結果は `PilotRubricEvaluationSchema`
  （`src/pilot-human-rubric.ts`）準拠の JSON として保存する
- score は主観だが下限は機械検証される: 各 scale level の
  `minimum_criteria_met_ratio` を満たす数の criteria が met でない限り
  その score は付けられない（score 4 は全 criteria met、score 3 は半数以上 met が必須。
  低い score を付けるのは常に許容）。不整合な評価は
  `validatePilotRubricEvaluation` が fail-closed で拒否する
- query 集合と criteria は pilot 期間中変更しない（変更は rubric の新 version と
  pilot 再開始を意味する）
- 判定の go 基準: **day 14 の全 query が score 3 以上**、かつ day 1 → day 14 で
  score が下がった query がないこと

## 最終 report と M2 完了判定

期間終了後、
[m2-cron-pilot-report-template.md](./m2-cron-pilot-report-template.md) に従って
最終 report を作成し、summarize 出力・rubric 評価・incident・未達項目・
follow-up Issue・M2 go/no-go 判断を記録する。判定材料は次のとおり:

| 判定材料            | 出典                                       | go 条件                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14 日間の記録完全性 | summarize の `coverage`                    | `complete: true`（欠測は理由付きのみ）                                                                                                                                                                                                                                                                     |
| sync 成功率         | summarize の `sync.run_success_rate`       | 0.99 以上、かつ rollback 条件に非該当                                                                                                                                                                                                                                                                      |
| 重複・冪等性        | summarize の `sync.unchanged` と再実行確認 | canonical state の増殖なし                                                                                                                                                                                                                                                                                 |
| job backlog         | summarize の `backlog`                     | `pending_jobs_monotonically_increasing: false`（`pending_jobs_by_day` の日次系列で確認）。window 内に欠測・未記録日が 1 日でもあると（先頭・末尾を含む）`null`（判定不能）になるため自動 go とせず、`backlog_series_gaps` の日付の日次記録と incident を人間が review し、判断根拠を最終 report に記録する |
| quality gate        | summarize の `quality.days_by_gate_status` | `integrity_failure` 0 日                                                                                                                                                                                                                                                                                   |
| ランキング体感      | rubric 評価（day 14）                      | 全 query score 3 以上かつ悪化なし                                                                                                                                                                                                                                                                          |
