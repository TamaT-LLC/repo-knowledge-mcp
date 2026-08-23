# M2修正後限定再評価report

## 1. 再評価の対象

| 項目 | 値 |
| --- | --- |
| revalidation_id | `m2-post-fix-revalidation-001` |
| 対象repository | `TamaT-LLC/repo-knowledge-mcp` |
| 修正前baseline | `m2-cron-pilot-002` Day 14 |
| 対象実装 | PR #120とPR #121を含むcurrent main |
| 評価時のmain commit | `1f07edcc46f9e603e10e80de864792d62f67ca04` |
| package version | `0.3.0` |
| human evaluator | `TakehiroT` |
| 評価日時 | `2026-08-23T09:48:26Z` |
| provider送信 | disabled |
| host-assisted送信 | disabled |

[M2修正後限定再評価計画](./m2-post-fix-revalidation-plan.md)に従い、pilot-002で合格した14日運用証跡と、修正後のランキング評価を組み合わせてM2を判定する。

## 2. pilot-002から再利用する運用証跡

[pilot-002最終report](./m2-cron-pilot-report-m2-cron-pilot-002.md)の運用gateはgoだった。

| 判定材料 | pilot-002実測値 | go条件 | 判定 |
| --- | ---: | ---: | --- |
| coverage | 14 / 14、missing 0 | 14日を追跡可能 | go |
| sync | 1,345 runs、1,338 success、7 failed | 成功率0.99以上 | go |
| sync成功率 | 0.9947955390 | 0.99以上 | go |
| integrity failure | 0日 | 0日 | go |
| backlog | max pending 3、final pending 0 | 発散なし | go |
| rollback条件 | 非該当 | 非該当 | go |

PR #120は検索とread planeだけを変更した。
PR #121は観測済みoutcomeの入力契約とMCP導線を変更した。
どちらのPRも、sync scheduling、checkpoint、writer lock、canonical transactionの実装、pilot日次集計、quality thresholdを変更していない。
このため、pilot-002の運用証跡を再利用する。

## 3. 修正後の実行状態

| 検査 | 結果 | 根拠 |
| --- | --- | --- |
| package artifact gate | pass | version `0.3.0`、183 entries、npm shasum `b8676406798e246a24db0e56bf7e5650bf6b2df2` |
| package smoke | pass | 11 MCP tools、guided setup、stdio JSON-RPC、workspace clean |
| doctor | pass | 26 pass、0 warn、0 fail |
| canonical | pass | digest `58da42c3fd709534cc803ed6c3e8b2d94de670744cb17a0aca56fb687b55ce4c`、unresolved transaction 0、SQLite `quick_check: ok` |
| launchd sync | pass | 900秒間隔、last exit 0 |
| post-fix sync probe | pass | discovered 0、failed 0、ingested 0、jobs_created 0、unchanged 0 |
| jobs | pass | pending 2、failed 0 |
| privacy | pass | provider送信とhost-assisted送信はdisabled |
| full test | pass | 74 files、772 tests |
| golden | pass | outcome rubric pass rate 1、search MRR 1、search NDCG 1 |
| quality gate | pass | status `pass`、integrity failureなし |

## 4. 固定queryのhuman評価

固定query、criteria、scaleはpilot-002から変更していない。
Codexはfresh processからobservationとAI事前評価を作成し、`TakehiroT`が5件のscoreを明示承認した。
AI事前評価だけをhuman評価として扱っていない。

| query | pilot-002 Day 14 | 修正後 | 直接関連ruleの最高順位 | 悪化なし | score 3以上 |
| --- | ---: | ---: | ---: | --- | --- |
| `q-error-handling` | 3 | 4 | 1 | yes | yes |
| `q-schema-validation` | 2 | 3 | 1 | yes | yes |
| `q-lock-concurrency` | 4 | 4 | 1 | yes | yes |
| `q-sync-checkpoint` | 3 | 3 | 1 | yes | yes |
| `q-stdout-purity` | 2 | 4 | 1 | yes | yes |

`q-schema-validation`では、入力日付をwindow判定前に検証するruleがrank 1になった。
`q-stdout-purity`では、異常終了を含む定期処理結果を構造化ログへ記録するruleがrank 1になった。
pilot-002でscore 3以上だった3 queryは悪化していない。

human evaluationは`PilotRubricEvaluationSchema`を通過し、`validatePilotRubricEvaluation`のissuesは0件だった。

| artifact | SHA-256 |
| --- | --- |
| `~/.repo-knowledge/pilot/m2-post-fix-revalidation-001-observation.json` | `88934bd78f0d4cf95fa8fb083439ee4cbdd1a861026103fdd44ab53aef2b62ac` |
| `~/.repo-knowledge/pilot/m2-post-fix-revalidation-001-ai-pre-evaluation.json` | `365733431cdea79ce8fd213ad31d13a7f0ff29a65e24937e105d38b58f49cdce` |
| `~/.repo-knowledge/pilot/m2-post-fix-revalidation-001-human-evaluation.json` | `7e816c12ce44d33a104fc73018429b3098f07e1394b65d511beca6b040b8f22d` |
| `~/.repo-knowledge/pilot/m2-post-fix-revalidation-001-human-approval.json` | `483ab2cb9ab863c225e6c18674e8de7087e794e0c38d02054d5663377ffa470e` |

## 5. outcome実測

再評価時のoutcomeは0件だった。
release判定のためのsynthetic outcomeは作成していない。

live weightingは未観測のまま残る。
一方、outcomeの冪等性、競合拒否、canonical再構築、重み上限、zero-outcome互換性は自動testとgolden fixtureで検証済みである。
#117により、今後は実利用結果を安定した`event_key`から記録できる。

## 6. pilot-003の中止

`m2-cron-pilot-003`は2026-08-24開始として準備したが、追加14日を重複実施しない判断により、Day 1前に中止した。
日次recordは0件だった。

開始artifact、prestart observation、空のJSONL、中止artifactはローカルの監査証跡として保持した。
pilot日次LaunchAgentはdisabledかつunloadedであり、15分sync LaunchAgentは継続している。

## 7. trusted-human auto activation

`trust.autoActivateTrustedHuman`は`false`のまま維持する。

現在のquality thresholdは`source: fixture_replay`であり、auto activation runbookが要求する`live_measurement`ではない。
この未達はnpm packageの個人利用と明示TTY reviewを妨げないが、自動active化を許可する根拠には使用しない。

## 8. M2判定

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| cron同期で2週間運用できた | go | pilot-002の14/14日、成功率0.9948、integrity failure 0、backlog非発散 |
| ランキングが体感に合う | go | named human評価で固定5 queryがすべてscore 3以上、既存合格queryの悪化なし |

**総合判定はM2完了である。**

判断者は`TakehiroT`である。
Codexは証跡取得とAI事前評価を担当し、人間の判断を代行していない。

M2 goを前提とするIssue #93のnpm release gateへ進める。
npm publish、tag、GitHub Releaseは、公開主体、npm owner、trusted publisher、exact version、provenance、Node.js 22と24のregistry smokeを確認するまで実行しない。
