# repo-knowledge-mcp ドキュメント

現行の stable release は `v0.4.1` です。
初めて使う場合は [README のセットアップ](../README.md#quick-start)から、導入済みの場合は[利用と運用の詳細ガイド](./operations/usage-reference.md)から確認してください。
この一覧は 2026-09-19 に `package.json` と npm の `latest` がともに `0.4.1` であることを確認して更新しました。

## 現在の利用方法と仕様

| 確認したいこと | 文書 |
| --- | --- |
| 対応環境、セットアップ、MCP 登録、最初のルールの承認 | [README](../README.md) |
| CLI、config、蒸留、outcome、stats、storage | [利用と運用の詳細ガイド](./operations/usage-reference.md) |
| 外部送信、trust、承認、ローカルのセキュリティ境界 | [Security policy](../SECURITY.md) |
| 増分同期、checkpoint、cron、失敗時の再開 | [sync cron runbook](./operations/sync-cron-runbook.md) |
| 自動 active 化の条件と rollback | [trusted-human auto activation runbook](./operations/trusted-human-auto-activation-runbook.md) |
| Node.js からの利用と `v0.3.0` からの API 移行 | [Node API と公開境界](./operations/node-api.md) |

既定では外部送信と自動 active 化は無効です。
同期だけでは active rule が作られない場合があるため、選択した送信経路で蒸留し、TTY の `review` で候補を確認します。
host-assisted の `includeDiffHunk` は Provider Adapter の送信内容を制限しません。

## 開発・検証・公開

| 作業 | 文書 |
| --- | --- |
| 開発環境、検証 command、coverage、貢献手順 | [Contributing guide](../CONTRIBUTING.md) |
| M1 の保存・復旧・権限境界の受け入れ条件 | [M1 acceptance matrix](./testing/m1-acceptance-matrix.md) |
| M2 の同期・outcome・検索・品質評価の受け入れ条件 | [M2 acceptance matrix](./testing/m2-acceptance-matrix.md) |
| M3 の個人利用・setup・review・公開の受け入れ条件 | [M3 acceptance matrix](./testing/m3-acceptance-matrix.md) |
| M1 fixture だけの評価 | [M1 golden runbook](./testing/m1-golden-runbook.md) |
| 実 PR を使う smoke | [M1 smoke runbook](./testing/m1-smoke-runbook.md) |
| オフライン品質ゲート、実 provider 測定、閾値更新 | [golden baseline runbook](./operations/golden-baseline-runbook.md) |
| npm 公開と rollback | [npm release runbook](./operations/npm-release-runbook.md) |
| リリースごとの検証記録 | [release report template](./operations/m3-release-report-template.md) |
| 依存関係と GitHub Actions の更新 | [dependency update runbook](./operations/dependency-update-runbook.md) |

M1 / M2 / M3 は機能開発のマイルストーン名で、npm の version とは別です。
各 acceptance matrix は、過去に追加された機能を現在も検証するための対応表として使います。
CLI やサービスを分割した場合は、検証対象の処理と起動経路の両方を追跡してください。

同梱の品質 threshold は `source: fixture_replay` です。
`npm run quality:gate` の成功は fixture の整合性と回帰検証を意味します。
実 provider の現在の品質、利用者の作業時間の短縮、自動 active 化に必要な live measurement とは区別してください。

## 設計の基準と過去の設計

[M3 個人利用要件](./design/repo-knowledge-mcp-v0.3-personal-use.md)が、現在の利用者モデルと対応範囲の基準です。
[統合仕様書 v0.3](./design/repo-knowledge-mcp-v0.3.md#reading-rules)には、保存・復旧・蒸留などの詳細と、後続仕様による差し替え範囲を残しています。
設計書名の `v0.3` を、npm の最新 version と読み替えないでください。

次の文書は統合前の設計履歴です。
現在の設定例や利用手順として使う場合は、統合仕様書の優先順位と現行ガイドを確認してください。

- [v0.2 本体](./design/repo-knowledge-mcp-v0.2.md)
- [v0.2.1 Mutation Path 補遺](./design/repo-knowledge-mcp-v0.2.1-supplement.md)
- [v0.2.2 Write Path 補遺](./design/repo-knowledge-mcp-v0.2.2-supplement.md)
- [v0.2.3 Write Path Freeze 補遺](./design/repo-knowledge-mcp-v0.2.3-supplement.md)
- [v0.2.3 Errata](./design/repo-knowledge-mcp-v0.2.3-errata.md)

## 日付と version を固定した検証記録

リリースと pilot の report は、対象 commit・環境・日時に対する記録です。
最新 checkout のテスト数や測定値で上書きせず、対象 version の結果として参照してください。

| 記録 | 対象と結論 |
| --- | --- |
| [v0.4.1 release report](./operations/m3-release-v0.4.1.md) | 現行 stable の公開・provenance・registry smoke 完了 |
| [v0.4.0 release report](./operations/m3-release-v0.4.0.md) | stable Node API を縮小したリリース |
| [v0.3.0 release report](./operations/m3-release-v0.3.0.md) | M3 の初回 stable 公開 |
| [2026-08-13 security review](./operations/m3-prepublish-security-review-2026-08-13.md) | 公開前のコードと脅威モデルの検証 |
| [2026-08-24 npm security review](./operations/m3-npm-release-security-review-2026-08-24.md) | npm 公開方式と権限境界の検証 |
| [pilot-002 report](./operations/m2-cron-pilot-report-m2-cron-pilot-002.md) | 14日運用は合格、当時の総合判定は M2 未完了 |
| [修正後限定再評価 report](./operations/m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md) | 運用証跡と修正後の人間評価を合わせて M2 完了。評価時の outcome は0件 |

pilot の実施条件は [cron pilot 計画](./operations/m2-cron-pilot-plan.md)、[report template](./operations/m2-cron-pilot-report-template.md)、[限定再評価計画](./operations/m2-post-fix-revalidation-plan.md)で追跡できます。
M2 完了の判断だけで、fixture-based threshold を live measurement として扱うことはできません。

## 文書を更新するとき

公開 version は [package.json](../package.json) と npm registry、CLI は [引数処理](../src/cli-args.ts)、設定は [domain schema](../src/domain-schemas.ts)で確認します。
公開 API は [inventory](../scripts/public-api-inventory.mjs)、検証手順は [CI](../.github/workflows/ci.yml)と [coverage 設定](../coverage.config.mjs)に合わせます。
未公開 branch だけの変更は、公開済み package の機能や測定結果として記載しないでください。

`prompts/distill.md` は説明文書ではなく実行時の prompt です。
編集すると digest と蒸留結果に影響するため、通常の文書変更と区別して品質ゲートを確認します。

文書変更後は `npm run docs:check` と `npm run format:check` を実行します。
`docs:check` は README、SECURITY、docs 配下の見出しとローカルリンクを検証します。
外部 URL、command の引数、出力の形式、CONTRIBUTING など対象外の Markdown は別途確認してください。
