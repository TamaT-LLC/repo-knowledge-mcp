# M2 修正後限定再評価計画

`m2-cron-pilot-002` で合格した14日運用を再利用し、未達だった検索順位とhuman評価だけを修正後に再検証する。

## 対象と根拠

pilot-002は、14/14日の記録、sync成功率0.9948、integrity failure 0日、final pending 0、rollback条件非該当を確認した。
この運用証跡は、[pilot-002最終report](./m2-cron-pilot-report-m2-cron-pilot-002.md)に固定されている。

M2がno-goになった理由は次の二点である。

- `q-schema-validation`と`q-stdout-purity`がscore 2だった
- Day 7とDay 14の評価にnamed qualified human evaluatorの確認がなかった

Issue `#116`はread planeの検索関連度を修正し、Issue `#117`は実利用で観測したoutcomeを記録する導線を追加した。
両変更は、pilot-002が検証したsync scheduling、checkpoint、writer lock、canonical transaction、日次集計の契約を変更していない。
したがって、同じ運用耐久試験は繰り返さず、変更した契約と未達項目だけを再評価する。

## 再評価識別子

- `revalidation_id`: `m2-post-fix-revalidation-001`
- 対象repository: `TamaT-LLC/repo-knowledge-mcp`
- 関連Issue: #116と#117
- 実装PR: #120（merge `2cb2b4f600d832063a8ac51a4afbee43d292c96f`）と#121（merge `b6738bb56583c2370d725ad48a6fd208d8854fce`）
- 対象実装: PR #120とPR #121を含むcurrent main
- rubric: `m2-pilot-human-rubric-v1`
- named qualified human evaluator: `TakehiroT`
- 外部送信: provider、host-assistedともに無効

`m2-cron-pilot-003`は2026-08-24開始として準備したが、2026-08-23にDay 1より前に中止した。
開始artifactと空のJSONLは監査証跡として保持し、合格根拠には数えない。

## 再評価手順

1. current mainから作成したpackage artifact gate通過tarballをglobal packageへ反映する。
2. Codex、Claude、launchdが同じbinaryを参照し、doctorがfail 0、provider送信とhost-assisted送信が無効であることを確認する。
3. launchd wrapperでsyncを1回以上成功させ、canonical破損とversion skewがないことを確認する。
4. 固定5 queryをglobal MCPのfresh processで実行し、queryごとの上位3件、scope、severity、canonical digestをprivacy-safeな共有observation artifactへ保存する。
5. Codexはrubricに基づく事前評価だけを作る。
6. named qualified human evaluatorが各queryのcriteriaとscoreを確認し、必要なら修正したうえで明示承認し、evaluationとapproval artifactを共有する。
7. `npm run check`、`npm run golden`、`npm run quality:gate`、`npm run package:smoke`を実行する。
8. 修正前後の比較、outcome実測件数、incident、M2 go/no-goをreview済みreportへ記録する。

## ランキングgo条件

固定query、criteria、scaleはpilot-002から変更しない。
pilot-002 Day 14のscoreを修正前baselineとして使う。

- 修正後の固定5 queryがすべてscore 3以上である
- pilot-002 Day 14でscore 3以上だったqueryが悪化していない
- `q-schema-validation`と`q-stdout-purity`の直接関連ruleが上位3件以内に現れる
- observationとhuman evaluationの評価者、日時、digestを追跡できる

既存schemaの`cp-day-14-final`は、M2の最終ランキングgateを表すcheckpointとして限定再評価でも使用する。
reportにはcalendar上のDay 14を再実施したと誤認されないよう、`revalidation_id`と実際の評価日時を併記する。

## outcomeの扱い

実利用で結果を観測した場合だけ、#117の`event_key`経路からoutcomeを記録する。
release判定のためのsynthetic outcomeは作成しない。

実outcomeが0件でも、それだけを理由にM2をno-goとはしない。
M2の完了条件はoutcome件数ではなく、固定queryのhuman評価と既存のoutcome ranking自動testで判定する。
実outcomeがない場合は、live weightingを未観測としてrelease reportへ残す。

## 証跡の再利用を禁止する変更

次のいずれかを変更した場合は、pilot-002の運用証跡を再利用せず、新しい14日pilotを実施する。

- sync schedulingまたはcron wrapper
- checkpointまたはresume境界
- writer lockまたは同時実行制御
- canonical transaction、recovery、reindex
- pilot日次集計またはquality threshold

次の変更は、記載した条件と検証を満たす場合に限定再評価を使用できる。

- 検索関連度、表示、文書、release workflowの変更は、変更箇所に対応する自動testと限定再評価を行う
- Issue `#117`のoutcome input contractとMCP導線の変更は、canonical transaction、recovery、reindex、outcome ranking policyを変更していない場合に限り、record-outcome service test、MCP E2E、M2 product E2E、outcome golden、doctor、canonical検査を行う

この条件を外れるoutcome変更は、pilot-002の運用証跡を再利用しない。

## M2判定

M2は次の二つがそろった場合だけgoとする。

1. pilot-002最終reportの14日運用gateがgoである
2. 修正後限定再評価reportのranking gateがgoである

どちらかがno-goまたは未確認なら、npm publish、tag、GitHub Releaseへ進まない。
