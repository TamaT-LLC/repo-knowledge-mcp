# M2 cron pilot 計画（2 週間運用）

M2 完了条件「cron 同期で 2 週間運用し、ランキングが体感に合う」
（[repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md) §19 M2）を、
再現可能な計画・日次記録・human rubric・最終 report で検証するための固定計画。
運用手順そのものは [sync cron runbook](./sync-cron-runbook.md) に従い、
本計画は pilot 固有の決定事項（対象・頻度・経路・privacy・rollback）と記録様式を固定する。

## 判定状態

`m2-cron-pilot-002` は 2026-08-23 に 14 日分の記録を完了し、cron 運用、canonical integrity、quality gate に合格した。

M2 の no-go は、固定 5 query 中 2 query の関連度不足と、Day 7 および Day 14 に named qualified human evaluator の確認がなかったことによる。
合格済みの運用耐久性を変更していない修正に対して、同じ 14 日試験を繰り返すことは要求しない。

修正後の M2 判定は、[pilot-002 最終 report](./m2-cron-pilot-report-m2-cron-pilot-002.md) の運用証跡と、[修正後限定再評価report](./m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md) のランキングおよびhuman評価を組み合わせる。

## pilot 識別子

- `pilot_id`: `m2-cron-pilot-002`
- 期間: 開始日（`--since` を確定した初回同期の翌 UTC 日）から **14 UTC 日**
- 日次記録 log: `~/.repo-knowledge/pilot/m2-cron-pilot-002.jsonl`（追記専用 JSONL）

開始日・終了日は pilot 開始時に本節へ追記し、以後変更しない。
中断した場合は新しい `pilot_id` で最初からやり直す。

- **開始日**: 2026-08-09（UTC）。初回同期（全期間、`--since` なし）は 2026-08-08 に完了し、
  checkpoint は PR #84 / `2026-08-07T13:38:02Z`。同日中に再実行で `discovered: 0` の冪等性を確認済み
- **終了日**: 2026-08-22（UTC、開始日を day 1 として 14 UTC 日）
- **rubric checkpoint**: day 1 = 2026-08-09、day 7 = 2026-08-15、day 14 = 2026-08-22
- **運用ノート**: 実行環境は operator の macOS（常時稼働ではない）。スリープ中の cron 未実行は
  欠測理由付き日次記録で追跡する。cron の失敗通知は MAILTO ではなく
  `~/log/repo-knowledge-sync.err` と日次記録の `runs_failed` で追跡する（ローカル MTA 未設定のため）
- **スケジューラ**: 実行環境の macOS では `crontab` 書き込みが TCC 承認待ちで完了しないため、
  同一の wrapper script（`sync-cron.sh`）と日次記録 script を launchd LaunchAgent
  （`jp.tamat.repo-knowledge.sync`: `StartInterval` 900 秒 / `jp.tamat.repo-knowledge.pilot-daily`:
  09:20 JST = 00:20 UTC）で起動する。実行内容・ログ・記録経路は crontab 例と同一

### 再開始履歴

2026-08-09 00:20 UTC に、`m2-cron-pilot-001` の日次記録 script が開始日前日の 2026-08-08 を先行記録した。

この記録を `--start 2026-08-09 --days 14` で集約すると、summarizer は `PILOT_DATE_OUT_OF_WINDOW` で拒否する。
したがって、`m2-cron-pilot-001` は M2 完了判定に使用しない。

無効な記録は監査証跡として `~/.repo-knowledge/pilot/m2-cron-pilot-001.jsonl` に残し、編集または削除しない。
日次記録 script には固定期間外の日付を追記せず正常終了する guard を追加した。

`m2-cron-pilot-002` は 2026-08-09 の UTC 日初から存在する sync log を使って同日に再開始する。
開始日の観測を失っていないため、終了日は 2026-08-22 のままとする。

### pilot-002 後の限定再評価

`m2-cron-pilot-002` は 2026-08-23 に 14 日分の完全集計を終え、cron、canonical integrity、quality gate に合格した。
一方、Day 14 の固定 5 query 中 2 query が score 2 で、Day 7 / 14 の評価も qualified human の確認を欠いたため M2 は no-go とした。
結果と根拠は [pilot-002 最終 report](./m2-cron-pilot-report-m2-cron-pilot-002.md) に固定し、事後の score 変更や synthetic outcome による補正は行わない。

#116 の検索関連度改善と #117 の実 outcome 記録導線を merge した後、`m2-cron-pilot-003` を 2026-08-24 から開始する計画を一度固定した。
しかし、両変更は pilot-002 が合格した sync scheduling、checkpoint、writer lock、canonical transaction、日次集計の契約を変更していない。
このため maintainer は 2026-08-23 に、Day 1 の日次 record が作られる前に pilot-003 の追加 14 日運用を中止した。
開始 artifact と空の JSONL は監査証跡としてローカルに保持し、M2 の go 根拠には使用しない。

残る未達項目は、[修正後限定再評価計画](./m2-post-fix-revalidation-plan.md) に従って評価する。
今後、sync scheduling、checkpoint、writer lock、canonical transaction、日次集計、quality threshold のいずれかを変更した場合は、pilot-002 の運用証跡を再利用せず、新しい 14 日 pilot を行う。

## 固定条件

### 対象 repository

- **`TamaT-LLC/repo-knowledge-mcp`（本リポジトリ、dogfooding）** を対象とする
- 選定理由: レビュー活動が継続しており、評価者自身が「体感」を持つ唯一のリポジトリで
  あるため、rubric 評価（後述）の妥当性を担保できる
- 対象の追加・変更は pilot の再開始（新 `pilot_id`）として扱う

### cron 頻度

- **15 分間隔**（[sync cron runbook](./sync-cron-runbook.md) の頻度と同一）
- 日次記録を日単位で切り出せるよう、sync summary の log は **UTC 日付単位で分割**する
- cron は直接 `repo-knowledge sync` を呼ばず、**wrapper script 経由**で実行する。
  sync が summary JSON を stdout に出す前に異常終了した run（`LOCK_TIMEOUT` や
  `gh` 失敗など）は、wrapper が機械可読な失敗マーカー行
  `{"cron_run_failed":true,"exit_code":<n>}` を sync log へ追記する。
  マーカー行は日次記録の `runs_total` / `runs_failed` に 1 失敗 run として
  計上され、rollback 条件「全 run 失敗が 2 UTC 日連続」を summary 欠落時にも
  正しく判定できる

wrapper（`~/.repo-knowledge/pilot/sync-cron.sh`、パーミッション 700）:

```sh
#!/bin/sh
# repo-knowledge sync cron wrapper: summary JSON が出なかった失敗 run も
# 機械可読マーカーとして sync log (JSONL) に残す
set -u
LOG_DIR="$HOME/log"
SYNC_LOG="$LOG_DIR/repo-knowledge-sync-$(date -u +%F).jsonl"
ERR_LOG="$LOG_DIR/repo-knowledge-sync.err"

summary="$(repo-knowledge sync TamaT-LLC/repo-knowledge-mcp 2>>"$ERR_LOG")"
exit_code=$?
if [ -n "$summary" ]; then
  printf '%s\n' "$summary" >>"$SYNC_LOG"
else
  printf '{"cron_run_failed":true,"exit_code":%d}\n' "$exit_code" >>"$SYNC_LOG"
fi
exit "$exit_code"
```

- summary が出力された部分失敗（exit 1 かつ `failed >= 1`）は summary 行自体が
  失敗 run として集計されるため、マーカーは追記されない（二重計上なし）
- stderr の diagnostic は従来どおり `repo-knowledge-sync.err` に残る

```crontab
MAILTO=ops@example.com
PATH=/opt/homebrew/bin:/usr/bin:/bin
*/15 * * * * "$HOME/.repo-knowledge/pilot/sync-cron.sh"
```

### 蒸留経路

- cron 同期は **provider 送信なし**（`llm.allowCloudTransmission` は無効のまま）。
  runbook の推奨どおり、cron は raw 保存と job 化までを担う
- pilot では provider CLI の自動実行を使わず、Claude Code から MCP の
  **host-assisted distillation** を対話実行する。
  `llm.mode` / `llm.allowCloudTransmission` は無効のままとする
- 実行時だけ `hostAssistedDistillation.enabled` と
  `hostAssistedDistillation.allowReviewContentTransmission` を明示的に有効化し、
  終了後に無効へ戻す。`includeDiffHunk` は `false`、1 job ずつ lease して完了後に
  次を取得する
- 頻度は任意だが、backlog（`pending_jobs`）が日次記録で単調増加し続けないよう
  週 2 回以上を目安とする
- この経路確定は初回蒸留前の 2026-08-09 に行った。
  pilot window、固定 query、rubric を変更しないため pilot は再開始しない

### privacy 条件

- GitHub トークンを保存しない（認証は `gh` CLI に委譲）
- cron 環境・log ファイルに review content（コメント本文）を書かない。
  sync summary は件数と PR 番号のみ、日次記録 log も件数・PR 番号・digest のみを持つ
- review content の送信は上記 host-assisted 経路の明示実行時だけ許可する。
  pilot 期間中に provider の `allowCloudTransmission` の既定を変更しない
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
    --log ~/.repo-knowledge/pilot/m2-cron-pilot-002.jsonl \
    --pilot m2-cron-pilot-002 \
    --date $(date -u +%F) \
    --start 2026-08-09 --days 14 \
    --sync-log ~/log/repo-knowledge-sync-$(date -u +%F).jsonl \
    --stats /tmp/stats-$(date -u +%F).json \
    --quality-gate /tmp/quality-gate-$(date -u +%F).json
```

- 記録できなかった日は放置せず、翌日以降に **欠測理由付き**で記録する
  （`--missing --reason "..."`）。summarize は理由のない欠落日を
  `unrecorded_dates` として検出する
- launchd 用 script は record command に `--start 2026-08-09 --days 14` を渡し、CLI が期間外の日付を追記前に拒否する
- launchd 用 script 自身も記録対象日を固定期間 `2026-08-09..2026-08-22` と照合し、期間外なら log へ追記せず正常終了する
- 1 日 1 record。同一日の再記録は CLI が `PILOT_DUPLICATE_DATE` で拒否する
- 期間終了後（または進捗確認時）に集約する:

```console
$ npm run --silent pilot:daily -- summarize \
    --log ~/.repo-knowledge/pilot/m2-cron-pilot-002.jsonl \
    --start 2026-08-09 --days 14 --require-complete
```

## human rubric 評価（体感評価）

「ランキングが体感に合う」は
[m2-pilot-human-rubric.json](../testing/m2-pilot-human-rubric.json)
（`rubric_id: m2-pilot-human-rubric-v1`）で評価する。
様式は outcome-ranking-golden の rubric（M2-20）を live 評価向けに流用したもので、
固定 query 5 件 × 評価 criteria + 4 段階 scale + 3 checkpoint（day 1 / 7 / 14）から成る。

- Codex が作成した observation と事前評価はhuman評価として扱わない。
  named qualified human evaluator が明示確認した evaluation artifact だけを判定に使う

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
- ranking 実装を変更した場合も、query と criteria は変更しない。
  変更前後の `get_rules` 結果を privacy-safe fixed-query fixture と checkpoint artifact に残し、既に score 3 以上だった query の直接関連ルールが top 3 から外れていないことを pilot 開始前に確認する
- `get_rules` の順位は、scope を候補の適格性に使い、task 一致、検索 score、severity の順で解釈する。
  英語 task と日本語 rule/detail の対応は設計書 §8.1 の term alias 契約に限り、query ID や knowledge ID による例外は認めない
- 判定の go 基準: **day 14 の全 query が score 3 以上**、かつ day 1 → day 14 で
  score が下がった query がないこと
- pilot-002 の ranking gate が no-goになった後に検索実装だけを修正した場合は、固定 query、criteria、scale を変えずに限定再評価する。
  限定再評価では、pilot-002 Day 14 の score を修正前baselineとし、全 query が score 3 以上で、修正前にscore 3以上だったqueryが悪化していないことをgo条件とする

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
| ランキング体感      | rubric 評価（day 14）または限定再評価      | 全 query score 3 以上かつ悪化なし                                                                                                                                                                                                                                                                          |

pilot-002 の最終 reportが運用gateをgoとし、限定再評価reportがranking gateをgoとした場合に限り、二つのreportを組み合わせてM2をgoと判定する。
