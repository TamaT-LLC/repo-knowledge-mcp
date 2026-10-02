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

`v0.4.3` から dependency graph、release workflow、canonical schema、approval / trust の判定は変更していない。
既存 repository override を setup で変更せず、host-assisted の同意は従来どおり global-only である。

## 2. 公開前提

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| package scope / license | 確認済み | package scope は `tamat-llc`、`package.json` / `LICENSE` は MIT |
| GitHub repository visibility | 確認済み | 2026-10-02 UTC の repository API で `public` |
| exact version 未使用 | 確認済み（要再確認） | `npm view @tamat-llc/repo-knowledge-mcp@0.4.4 version --json` は `E404` |
| initial bootstrap / initial publisher | n/a | 後続 stable release。再実施しない |
| final commit / clean worktree / tag identity | pending | main merge と tag 作成の承認前 |
| GitHub repository / npm environment の credential 0件 | 未確認 | 今回の準備では secret / variable の管理 API を利用できない |
| npm environment protection / version tag protection | 未確認 | 過去 report の設定を今回直接確認したとは扱わない |
| security review / alert disposition | pending | §4。CodeQL と package scan だけで secret scanning の状態を代用しない |

前回 npm package settings 対話監査日は 2026-08-24、記録上の次回期限は 2026-11-22。
今回の準備では設定変更を行っておらず、日付上の定期監査は `not_due`。
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

**今回の M2 証跡再利用の適用判定: pending reviewer determination。**
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

これは「pilot が検証した運用契約を維持した provider 回復修正」として限定再検証する根拠案であり、新たな人間の M2 approval ではない。
同時実行制御 / recovery の広い文言が今回にも適用される余地があり、既存 hash の一致だけで go としない。
maintainer はこの差分資料と test 結果を review して適用範囲を記録する。運用契約を変更したと判断する場合は、計画に従い新しい14日 pilot が必要となる。
現時点で14日再実施が確定したとも、免除が承認済みとも扱わない。

## 4. Local verification と security

| 項目 | 値 |
| --- | --- |
| environment | Linux x86_64、隔離した source worktree / temporary storage |
| Node.js / npm | `v24.19.0` / `12.0.2` |
| source | §1 の base とこの準備 PR の変更 |
| 実行日 | 2026-10-02 UTC |

runbook の順序で dependency を検証し、audit / signature の成功後にだけ lifecycle script を実行した。

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
local package smoke の clean install は依存範囲内の MCP SDK `2.2.0`、固定 TypeScript `7.0.2` を取得した。source lockfile の dependency graph は未変更。

### Security review の区別

| 項目 | 状態 |
| --- | --- |
| CodeQL exact PR head | pending |
| dependency / registry signature audit | 上記 local gate は pass |
| package credential / local-data scan | pass。local package smoke の artifact allowlist / source scan。Git history scan ではない |
| GitHub secret scanning / Git history scan / Dependabot open alerts | 未確認。今回の接続では対応 API を利用できず、0件とは主張しない |
| source boundary review | AI による差分 review で具体的な新規 defect は未検出。人間の security approval ではない |
| maintainer security review / 残余リスク受容 | pending |

## 5. Pull Request CI

準備 PR の exact head で Node.js 22 / 24 と CodeQL の terminal result を確認する。
最終的な run URL と review 状態は[準備 PR #196](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/196)へ記録する。
CodeRabbit は draft の自動 review を skip しており、その success status を内容の review 完了とは扱わない。手動の外部 agent review は未依頼。
PR CI は main の release commit の検証や registry smoke の代わりにはならない。

## 6. M3 acceptance と live workflow の範囲

[M3 acceptance matrix](../testing/m3-acceptance-matrix.md) に対応する自動 test / local package smoke は §4 と PR CI で再実行する。
M3-AC-008 の exact-version registry smoke は公開後まで未実施であり、全11項目 pass とは記録しない。
最終 M3 acceptance の maintainer review は pending。

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

## 10. Go / no-go と残る手順

**総合判定: release 未完了。公開 no-go。**
準備 PR の検証成功は merge / tag / GitHub Release / npm publish の承認を意味しない。

1. M2 証跡の再利用可否を明示して判断し、必要な再評価を完了する
2. exact PR head の Node.js 22 / 24 CI、CodeQL と review を確認し、maintainer の security / acceptance review と必要な alert・environment 検査を完了する
3. 別途 merge 承認後に main の final commit を確定し、runbook の全 gate と exact-version 未使用を再確認する
4. 別途公開承認後に tag と draft GitHub Release を用意し、`release:verify` と公開前 report の review を完了する
5. OIDC publish、provenance、Node.js 22 / 24 registry smoke、artifact の一致を確認してから release 完了に更新する
