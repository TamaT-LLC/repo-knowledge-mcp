# Dependency update runbook

本runbookは、RenovateとGitHubのdependency security機能を併用し、依存packageとGitHub Actionsを更新する手順を定義する。

## 1. 責務の分離

依存関係の検出と更新Pull Requestの作成は、次のように分担する。

| 機能 | 責務 |
| --- | --- |
| GitHub dependency graph | repositoryの依存関係を検出する |
| Dependabot alerts | 既知vulnerabilityを通知する |
| Renovate | version updateとvulnerability fixのPull Requestを作成する |
| Dependabot security updates | Renovateの稼働確認後に無効化し、重複Pull Requestを防ぐ |
| CODEOWNERSとrepository ruleset | owner review、必須CI、CodeQLをmerge条件として適用する |

Dependabot alertsは無効化しない。
RenovateはGitHubのvulnerability alertを読み、修正版を選ぶために使用する。

## 2. 更新方針

通常のnpm updateは毎週月曜日の午前6時より前に処理し、公開から3日未満のversionを候補から外す。
Vulnerability fixは通常scheduleと公開後の待機期間を適用せず、検出後にPull Requestを作成する。

Major updateはDependency Dashboardでmaintainerが承認するまでPull Requestを作成しない。
Development dependencyのminor updateとpatch updateは、一つのPull Requestへまとめる。
GitHub Actionsのminor update、patch update、digest updateも一つのPull Requestへまとめる。

GitHub Actionsはcommit SHAに固定し、version commentを更新時の追跡情報として維持する。
Release workflowで使用するnpm CLIのversionもRenovateのcustom managerで更新する。

Renovateは自動mergeしない。
すべての更新はowner review、Node.js 22と24のCI、CodeQLを通過してからmergeする。

## 3. Appの権限境界

Mend Renovate Appは`repo-knowledge-mcp`だけを選択してinstallする。
組織の全repositoryへ一括で権限を付与しない。

Renovateにはbranch、Pull Request、Issue、check、workflowを更新する権限がある。
一方、repository rulesetではRenovateに`main`のbypassを付与しないため、Appは更新branchとPull Requestを経由する。

Renovate設定には`postUpgradeTasks`、任意command、private registry credentialを追加しない。
追加が必要になった場合は、権限と外部送信を別のsecurity reviewで確認する。

Appの権限と保存情報は[Renovate security and permissions](https://docs.renovatebot.com/security-and-permissions/)で確認する。

## 4. 初回有効化

1. `renovate.json`をdefault branchへmergeする。
2. TamaT-LLCのRenovate App設定で`repo-knowledge-mcp`だけを選択する。
3. RenovateのDependency Dashboardが作成され、configuration warningがないことを確認する。
4. Renovateが作成した最初のPull Requestで、owner reviewと必須checkが適用されることを確認する。
5. Renovateのvulnerability alert連携を確認してから、Dependabot security updatesを無効化する。

Renovateの確認前にDependabot security updatesを無効化すると、移行中にvulnerability fixの作成者が不在になる。
移行中は重複Pull Requestより未検出期間の回避を優先する。

## 5. 障害時の復旧

Renovateが更新を停止した場合は、Appのjob logとDependency Dashboardのwarningを確認する。
復旧に時間がかかる場合はDependabot security updatesを再度有効化し、vulnerability fixの作成をGitHubへ戻す。

意図しないbranchまたはPull Requestが作成された場合はRenovate Appから対象repositoryを外し、原因を確認する。
既存branchとPull Requestは自動削除せず、内容を確認してから個別に閉じる。
