# Contributing to repo-knowledge-mcp

Issue、文書、テスト、コードへの貢献を歓迎します。
このプロジェクトはPull Requestのレビュー内容をローカルへ永続化するため、機能の正しさに加えてprivacyと監査可能性を重視します。

## 報告先を選ぶ

- 再現可能な不具合は[Bug report](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/new?template=bug_report.yml)から報告してください。
- 機能提案は[Feature request](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/new?template=feature_request.yml)から提案してください。
- security vulnerabilityはpublic Issueへ書かず、[private vulnerability report](https://github.com/TamaT-LLC/repo-knowledge-mcp/security/advisories/new)から報告してください。

Issueを作る前に、既存Issueと[READMEのトラブルシュート](./README.md#troubleshooting)を確認してください。
質問に診断結果を添える場合は、token、review本文、diff、個人情報、private repository名を除いてください。

## 開発環境を準備する

Node.js 22.13以降、またはNode.js 24以降を使用してください。
依存packageのlifecycle scriptは、registry signatureと既知vulnerabilityを確認してから実行します。

```console
npm ci --ignore-scripts
npm audit --audit-level=high
npm audit signatures
npm rebuild
npm run build
```

GitHub連携を含む手動確認では、対象repositoryを読めるaccountで`gh auth status`が成功することも確認してください。

## 変更を作る

`main`への直接pushは保護されています。
変更ごとに短いbranchを作り、目的と関係しない変更を同じPull Requestへ含めないでください。

不具合修正には、修正前に失敗し、修正後に成功するテストを追加してください。
公開されるinterface、設定、運用手順を変える場合は、READMEまたは該当runbookも更新してください。

fixtureには合成データか匿名化済みデータだけを使用してください。
実際のreview本文、credential、個人情報、private repositoryの識別子をcommitしてはいけません。
テストからcloud transmissionを有効にせず、networkとcredentialがない環境でもgateが動く状態を保ってください。

## 変更を検証する

commit前にformatを適用し、repositoryのgateを実行してください。

```console
npm run format
npm run check
npm run golden
npm run quality:gate
npm run package:smoke
```

文書だけの変更でも、少なくとも`npm run docs:check`と`npm run format:check`を実行してください。
Pull RequestのCIはNode.js 22と24で全gateを再実行します。

## Pull Requestを作る

Pull Requestには、変更理由、変更内容、関連Issue、検証結果を記載してください。
実行できなかった検証がある場合は、理由と影響範囲を明記してください。

次の変更では、privacyとreleaseへの影響を本文で説明してください。

- 外部送信の対象またはopt-in条件を変える変更
- trust、approval、knowledge statusを変える変更
- canonical data、migration、recoveryを変える変更
- npm packageの内容またはrelease workflowを変える変更

CODEOWNERSのreviewと必須CIが完了するまでmergeできません。
version tag、GitHub Release、npm publishはmaintainerが[release runbook](./docs/operations/npm-release-runbook.md)に従って実行します。
依存packageとGitHub Actionsの更新は[dependency update runbook](./docs/operations/dependency-update-runbook.md)に従って実行します。

## 行動規範

すべての参加者は[Code of Conduct](./CODE_OF_CONDUCT.md)に従ってください。
