# M3 v0.4.4 release preparation report

`@tamat-llc/repo-knowledge-mcp@0.4.4` は公開準備中であり、release 完了ではない。
この report は準備段階の実測と未完了 gate を分けて記録する。
`v0.4.3` の公開結果を今回の pass として転記しない。

## 1. Release identity と変更内容

| 項目 | 値 |
| --- | --- |
| package / planned version | `@tamat-llc/repo-knowledge-mcp` / `0.4.4` |
| source base | `391017f7644f834c26a2510816bfe7ddccd55ffd` |
| planned tag | `v0.4.4`。未作成 |
| final release commit / main 到達確認 | 未確定。準備 PR の merge 後に検証 |
| GitHub Release / npm publish | 未実施 |
| npm integrity / provenance / release workflow | 未生成 |
| registry availability | 2026-10-02 UTC: exact `0.4.4` は `E404`、`latest` は `0.4.3` |

今回の後方互換 patch は次の修正を含む。

- [PR #194](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/194): 中断した provider distillation job の期限切れ lease 後の再試行、failed-only readiness の回復案内、bootstrap の repository scope、MCP の package version 表示を修正
- [PR #195](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/195): setup / doctor に repository の実効送信設定と global 同意・override を区別して表示し、storage 全体と将来追加する repository への同意範囲を説明
- この準備 PR: version / lockfile と現行ガイドを更新し、公開前後の証跡を区別

`v0.4.3` から lockfile の依存関係構成、release workflow、canonical schema、approval / trust の判定は変更していない。
既存 repository override を setup で変更せず、host-assisted の同意は従来どおり global-only である。

## 2. 公開前提

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| package scope / license | 確認済み | package scope は `tamat-llc`、`package.json` / `LICENSE` は MIT |
| GitHub repository visibility | 確認済み | 2026-10-02 UTC の repository API で `public` |
| exact version 未使用 | 確認済み（要再確認） | `npm view @tamat-llc/repo-knowledge-mcp@0.4.4 version --json` は `E404` |
| initial bootstrap / initial publisher | n/a | 後続 stable release。再実施しない |
| final commit / clean worktree / tag identity | pending | main merge と tag 作成の承認前 |
| GitHub repository / npm environment の credential metadata | pass | 2026-10-02 07:15 UTC: repository と `npm` environment の secret / variable は各0件。repository が利用できる organization secret / variable も各0件。値は参照していない |
| npm environment protection | 設定確認済み | required reviewer は `TakehiroT` / `Fuelda`、self-review 禁止、selected branches/tags は `v*` tag のみ。管理者 bypass の既存設定は下記 |
| main / code-owner / version tag protection | 確認済み | 2026-10-02 06:16–06:18 UTC の ruleset API。下記 |
| security review / alert disposition | pending | §4。CodeQL と package scan だけで secret scanning の状態を代用しない |

### 現在の repository protection（read-only 確認）

- [main ruleset 20803864](https://github.com/TamaT-LLC/repo-knowledge-mcp/rules/20803864): active。PR、review thread 解決、strict な Node 22 / 24 と CodeQL Actions / JavaScript-TypeScript checks を要求。deletion / non-fast-forward を制限し、bypass actor なし
- [code-owner ruleset 20804041](https://github.com/TamaT-LLC/repo-knowledge-mcp/rules/20804041): active。1 approval、code-owner review、stale review dismissal、last-push approval を要求。Integration `2740` と User `33048137` の pull-request-only bypass が存在する。bypass を今回の承認の代用として使用しない
- [version-tag ruleset 20807010](https://github.com/TamaT-LLC/repo-knowledge-mcp/rules/20807010): active。`refs/tags/v*` の update / deletion を制限し、除外・bypass actor なし

管理情報は connector の対応 API に含まれなかったため、認証後の browser UI で read-only 確認を行った。

| 確認項目 | 2026-10-02 07:15 UTC の実測と source |
| --- | --- |
| repository / organization Actions secrets | repository 0件、repository が利用できる organization secrets 0件。[settings](https://github.com/TamaT-LLC/repo-knowledge-mcp/settings/secrets/actions) |
| repository / organization Actions variables | repository 0件、repository が利用できる organization variables 0件。metadata だけを照合。[settings](https://github.com/TamaT-LLC/repo-knowledge-mcp/settings/variables/actions) |
| npm environment secrets / variables | 各0件。[environment](https://github.com/TamaT-LLC/repo-knowledge-mcp/settings/environments/19807183312/edit) |
| npm environment review / deployment | required reviewers `TakehiroT` / `Fuelda`、prevent self-review ON、`v*` tag policy、許可 branch 0件。同じ environment 画面 |
| npm environment admin bypass | 既存の「Allow administrators to bypass configured protection rules」は ON。今回の準備では変更・使用していない。code-owner ruleset の bypass と併せ、maintainer の残余リスク review 対象とする |

secret や variable の値、認証情報は report に含めない。

前回 npm package settings 対話監査日は 2026-08-24、記録上の次回期限は 2026-11-22。
今回の準備では npm package settings を変更しておらず、日付上の定期監査は `not_due`。
未観測の変更・incident の有無を maintainer が公開前に確認する。現在の token 禁止設定を直接確認したという意味ではない。

## 3. M2 release gate

[M2 pilot report](./m2-cron-pilot-report-m2-cron-pilot-002.md)、[限定再評価 report](./m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md) と対応 artifact は `v0.4.3` と byte 単位で一致する。
2026-10-02 UTC に [Issue #118](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/118) の closed 状態を確認した。
これらは過去の証跡の保持を示し、今回の変更への適用承認を意味しない。

| 証跡 | SHA-256 |
| --- | --- |
| pilot report | `192b53509c6cecf5a47608a72cd63f412f5348aa0dd27cacf93c295bacb36b44` |
| revalidation report | `b09c5e3030bee3b26b950fab573b802f6d8897e58103c0783fb82d088dc7192a` |
| observation | `f45dcfadc3779be59825bcdb85aa4d6d7b70364fb3301370821e5b23a9a41531` |
| human evaluation | `7e816c12ce44d33a104fc73018429b3098f07e1394b65d511beca6b040b8f22d` |
| human approval | `88934752d2e92d6a508e87d354883d0fd225866fbc141d9c401008c1245ca63e` |

**今回の M2 証跡再利用の適用判定: owner が既存 pilot 証跡と今回の回帰検証を採用。**
2026-10-02 UTC、repository owner `TakehiroT` は下記の変更範囲・検証方針の説明を受け、patch `0.4.4` の release を明示的に承認した。
これは今回の patch に対する owner の適用判断であり、過去の human evaluation の書き換え、新しい独立 human evaluation、一般的な運用 gate の免除ではない。
[限定再評価計画](./m2-post-fix-revalidation-plan.md) の再利用禁止条件は、writer lock / 同時実行制御、canonical transaction / recovery / reindex などの変更時に新しい14日 pilot を要求する。
一方、後から更新された [M3 acceptance matrix の運用 gate](../testing/m3-acceptance-matrix.md) は、後続 release で証跡と変更範囲を確認し、影響する契約を再検証すると定める。
[pilot plan](./m2-cron-pilot-plan.md) も、合格済みの運用耐久性を変更しない修正に同じ14日試験の反復を要求しない。

### 変更範囲の適用判断資料

| 契約 | 差分と再検証 |
| --- | --- |
| pilot-002 の稼働経路 | cron は provider 送信を無効にし、6回の明示的 host-assisted session を実施。今回の provider-only 分岐は pilot の cron では実行していない |
| provider job 回復 | #194 が期限切れ processing job を再試行対象に追加。provider 呼出元だけで extraction-only lease admission を指定し、awaiting_finalize の再抽出を防止 |
| lease の不変条件 | default acquireLease、期限、generation / token fencing、writer-lock 実装は未変更。競合 runner、stale token、期限切れ job、finalize の回帰 test を再実行 |
| canonical / 継続運用 | canonical transaction / recovery engine、checkpoint / resume、reindex、cron wrapper、日次集計、ranking、quality threshold は未変更。全 suite と golden / quality gate で回帰検証 |
| setup / doctor | #195 は表示と同意範囲の説明を修正。policy precedence、trust / approval、storage 形式は未変更。実効 consent の matrix と TTY / JSON 回帰 test を再実行 |

これは「pilot が検証した運用契約を維持した provider 回復修正」として限定再検証する根拠である。owner は既存 hash の一致だけではなく、この差分と回帰検証を今回の patch release に採用した。
同時実行制御 / recovery の広い文言との関係をこの記録に残す。運用契約を変更する別の変更では、計画に従って新しい14日 pilot の要否を再判定し、今回の判断を一般的な免除として流用しない。
独立した新しい14日 pilot や human ranking evaluation は実施していない。

## 4. Local verification と security

| 項目 | 値 |
| --- | --- |
| environment | Linux x86_64、隔離した source worktree / temporary storage |
| Node.js / npm | `v24.19.0` / `12.0.2` |
| source | §1 の base とこの準備 PR の変更 |
| 実行日 | 2026-10-02 UTC |

runbook の順序で dependency を検証し、audit / signature の成功後にだけ lifecycle script を実行した。
2026-10-02 06:18 UTC の再確認でも vulnerability 0件、signature 112件、attestation 43件だった。

| command | 結果 | 実測 |
| --- | --- | --- |
| `npm ci --ignore-scripts` | pass | 112 packages |
| `npm run install-scripts:check` | pass | approved 1、denied 1 |
| `npm audit --audit-level=high` | pass | vulnerability 0件 |
| `npm audit signatures` | pass | signature 112件、attestation 43件 |
| `npm rebuild` | pass after environment retry | §9 |
| `npm run check` | pass | 36 docs、80 test files / 1,070 tests。release-tools 18 / coverage-threshold 3 tests |
| `npm run golden` | pass | M1、M2 outcome ranking、provider baseline |
| `npm run quality:gate` | pass | 全10 metrics が threshold 以上。fixture replay の回帰 gate であり live provider 品質の再測定ではない |
| `npm run package:smoke` | pass | 255 files、11 MCP tools、server version `0.4.4`、CLI / stdio / Node API / workspace clean |
| `release:verify` | not run | exact tag / main 上の final release commit が未確定 |

Coverage は statements 88.88%、branches 79.45%、functions 94.09%、lines 89.63%。
local package smoke の clean install は依存範囲内の MCP SDK `2.2.0`、固定 TypeScript `7.0.2` を取得した。source lockfile の依存関係構成は未変更。

### Security review の区別

| 項目 | 状態 |
| --- | --- |
| CodeQL exact PR head | `178154ff` の [run 36973264324](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36973264324) は Actions / JavaScript-TypeScript とも success。最新 head の結果は §5 の PR 記録を参照。open alert 0件の証明ではない |
| dependency / registry signature audit | 上記 local gate は pass |
| package credential / local-data scan | pass。local package smoke の artifact allowlist / source scan。Git history scan ではない |
| GitHub CodeQL open alerts | 2026-10-02 07:17 UTC: `is:open branch:main` は0件、closed 78件、全 tool 正常。tool 一覧は CodeQL のみ。[code scanning](https://github.com/TamaT-LLC/repo-knowledge-mcp/security/code-scanning) |
| GitHub secret scanning | 2026-10-02 07:17 UTC: `is:open` は0件、closed 0件、unresolved secrets なし。[secret scanning](https://github.com/TamaT-LLC/repo-knowledge-mcp/security/secret-scanning) |
| 独立した local Git history scan | 未実施。上記 GitHub secret scanning の実測と、local package artifact の credential scan を区別して記録 |
| Dependabot open alerts | 2026-10-02 07:21 UTC: 利用者の明示承認で Dependency graph だけを有効化後、`Dependency files checked` と `is:open` 0件 / closed 0件を確認。[alerts](https://github.com/TamaT-LLC/repo-knowledge-mcp/security/dependabot) / [settings](https://github.com/TamaT-LLC/repo-knowledge-mcp/settings/security_analysis)。発見時の inactive と対応は §9 |
| source boundary review | AI による差分 review で具体的な新規 defect は未検出。人間の security approval ではない |
| owner の release 判断 / 残余リスク | 実測と未実施項目を示したうえで `TakehiroT` が patch release を承認。独立 security audit や GitHub の required approval を代行するものではない。既存 bypass は使用しない |

## 5. Pull Request CI

準備 head `178154ff723f286c45fae6057bf7214b221301f8` の terminal result は次のとおり。

| 対象 | 結果 | run URL |
| --- | --- | --- |
| CI Node.js 22 / 24 | success。audit / signatures / check / golden / quality / package smoke を両環境で完了 | [run 36973267381](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36973267381) |
| CodeQL Actions / JavaScript-TypeScript | success | [run 36973264324](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36973264324) |

この表は明記した head の結果である。report 更新後も最新の exact head の全 CI を再確認し、次の PR 記録で追跡する。
最終的な run URL と review 状態は[準備 PR #196](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/196)へ記録する。
CodeRabbit は当初 draft の自動 review を skip した。利用者の承認後、2026-10-02 06:17 UTC に[手動 review](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/196#issuecomment-5946616361)を依頼した。実際の review 結果と対象 head を準備 PR に記録し、skip の success status を内容の review 完了とは扱わない。
PR CI は main の release commit の検証や registry smoke の代わりにはならない。

## 6. M3 acceptance と live workflow の範囲

[M3 acceptance matrix](../testing/m3-acceptance-matrix.md) に対応する自動 test / local package smoke は §4 と PR CI で再実行する。
M3-AC-008 の exact-version registry smoke は公開後まで未実施であり、全11項目 pass とは記録しない。
owner は今回の patch release を承認した。これは未実施の registry smoke を pass とするものではなく、公開後の M3-AC-008 完了確認は引き続き必要である。

別途、source base `391017f`（当時の package version `0.4.3`）で実 PR #194 の検証を行った。
実 `gh` 取得 → 実 OpenAI assistant の host-assisted prepare / submit → 隔離 storage の実 TTY 確認 → 実 Codex MCP client の承認前後・scope 別 read は成功した。
fixture のみの流れとは区別する一方、次の制約がある。

- Codex CLI 自身の model inference は read-only の認証済み `CODEX_HOME` により起動前に停止し、生成結果はない
- 自律 Codex end-to-end の検証成功とは扱わない
- 隔離 storage での検証であり、production activation や今回の release に対する人間の承認ではない
- この実 PR 検証は今回の `0.4.4` exact tarball / npm package の証明ではない

## 7. Package artifact

公開 artifact は未生成。local package smoke の検査結果と公開 artifact を混同しない。
公開時に release workflow が生成した tarball / report の SHA-256、integrity、file list を記録し、registry から取得した同一 version と照合する。

次は準備 head `00ddb404b403f6cabc12289206e1ffca9713fe29` で再実行した local gate の artifact であり、公開 artifact ではない。

| 項目 | local 検証値 |
| --- | --- |
| tarball | `tamat-llc-repo-knowledge-mcp-0.4.4.tgz` |
| tarball SHA-256 | `740c7f5b9872ba6f0ef248ab778e5cb20e53a517b4706c4f2664e40e4b1c032f` |
| artifact report SHA-256 | `590105a4ba18f3cda128c47502c1a351c0b60e9e0d5f24ebba80360df7a6bc03` |
| allowlist / credential scan | pass、255 entries、`dist-js-dts-plus-explicit-root-files-v3` |

CLI bin は `repo-knowledge` / `repo-knowledge-mcp`、MCP tool 契約は11件のままである。

## 8. Release CI と registry smoke

Node.js 22 / 24 の verify release、OIDC publish、provenance、exact-version registry smoke はすべて未実施。
GitHub Release、tag、npm publish はこの準備作業では作成・実行しない。

## 9. Incident と差分

local rebuild は初回および `HOME` だけの変更後に、cloud の `XDG_CACHE_HOME` が指す書き込み不可の cache path で失敗した。
`XDG_CACHE_HOME` と node-gyp cache を書き込み可能な temporary directory に設定して再実行し、成功した。
dependency / signature gate を飛ばさず、product source、lockfile、security 設定はこの回避のために変更していない。

07:16–07:18 UTC の設定確認で、Dependabot alerts は ON だが Dependency graph は OFF のため、alerts の詳細ページが inactive であることを検出した。
利用者の明示承認後、07:21:20 UTC に Dependency graph だけを ON にし、`Repository settings saved` と実設定を確認した。
07:21:41 UTC の alerts ページで dependency files の検査時刻と open 0件 / closed 0件を確認した。inactive の表示を0件と誤認していない。
既存の Renovate は [Dependency Dashboard #114](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/114) と `renovate.json` で稼働している。
[dependency update runbook](./dependency-update-runbook.md) に従い、Dependency graph / Dependabot alerts が検知し、Renovate が更新 PR を作成する役割分担を維持する。新たな bot の導入、security-update PR の自動作成、他の security option は有効化していない。

## 10. Go / no-go と残る手順

**総合判定: owner の release 承認済み、release 実行・完了検証は未完了。**
owner は patch `0.4.4` の merge / release を明示承認した。既存の required review / environment approval はこの承認と別に満たす。保護の bypass や未実施検証の pass 扱いは承認されていない。

1. 上記の owner による M2 適用判断を維持し、今回の検証範囲と未実施項目を区別する
2. exact PR head の Node.js 22 / 24 CI、CodeQL と required review を確認する。GitHub が独立 reviewer を要求する場合は待ち、bypass しない
3. required review 完了後に main の final commit を確定し、runbook の全 gate と exact-version 未使用を再確認する
4. tag と draft GitHub Release を用意し、`release:verify` と公開前 report の整合性を確認する。`npm` environment の必要な承認は別途取得する
5. OIDC publish、provenance、Node.js 22 / 24 registry smoke、artifact の一致を確認してから release 完了に更新する
