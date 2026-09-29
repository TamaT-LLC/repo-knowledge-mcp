# M3 v0.4.3 release report

`@tamat-llc/repo-knowledge-mcp@0.4.3`はnpm registryへ公開済みである。
OIDC publish、provenance、Node.js 22 / 24のregistry smokeはすべてpassした。
総合判定は`release完了`である。

## 1. Release identity

release identityはmain上のcommit `28366693`へ固定した。

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.4.3` |
| Git tag | `v0.4.3` |
| tag object | `5ebdd17695c10b9068d1aeaf4f5418401b380edd` |
| tag署名 | RSA key `SHA256:1X9sHQvcez+SrxBmBj/gXNBeItAjPh+889/T/ZSxX8o`でlocal検証済み |
| commit SHA | `2836669367907a01844d2f8c9b4b9443e9428a7f` |
| main到達確認 | `git merge-base --is-ancestor 28366693 origin/main`: pass |
| GitHub Release | [v0.4.3](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.3)。`2026-09-29T07:20:41Z`に公開 |
| npm registry | [@tamat-llc/repo-knowledge-mcp@0.4.3](https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.3)。`2026-09-29T07:28:08.418Z`に公開 |
| npm integrity | `sha512-kLe565jQjj0J6QIidMZp59YpX1CyaJ7c57JLMWBBt3nppRbJzDTFnklfPO3x8HfAOSMczCU3O/0FzoPWIsIdbw==` |
| npm shasum | `685a8a9e647916e637c75f6c601f84f32baee2ba` |
| npm provenance | pass。SLSA subject、release commit、workflow、runが一致 |
| release workflow | [run 36536073203](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203) |

`v0.4.3`は後方互換のpatch releaseである。
`@modelcontextprotocol/server` 2.1.0への追随、依存関係の更新、READMEの紹介動画追加を含む。
`v0.4.2`から`src/`の変更はなく、MCP tool、CLI、設定、local storageの形式は変わらない。

## 2. 公開前提

公開前提はすべてpassしている。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| npm organizationが`tamat-llc`である | pass | 公開済み`0.4.2`のregistry metadataと[v0.4.2 release report](./m3-release-v0.4.2.md) |
| 初回publisherがorganization内のpublish権限と2FAを持つ | n/a | bootstrapとstable publishは`v0.3.0`で完了済み |
| project licenseと`package.json`のlicenseが確定している | pass | `package.json`とGitHub repository metadataはMIT |
| 空でない通常ファイルの`LICENSE`がrelease commitに存在する | pass | `release:verify`のlicense gate |
| GitHub repositoryがpublicである | pass | `release:verify`のvisibility gate |
| inert bootstrap packageとstable OIDC publishingの境界が確定している | pass | `0.0.0-bootstrap.0`は公開・deprecate済み |
| bootstrap tarballのfile list、version、dist-tagがreview済みである | n/a | bootstrapを後続releaseで繰り返さない |
| 長期npm tokenをrepository secretに置いていない | pass | repositoryと`npm` environmentのsecret / variableは各0件 |
| 対象versionがregistryで未使用である | pass | `release:verify`の`registry_status: available` |
| working treeがcleanである | pass | cleanな一時worktreeでrelease identityを検証 |
| security reviewに未解決のcriticalまたはhigh findingがない | pass | CodeQL、secret scanning、Dependabotのopen alertは各0件 |

GitHub `npm` environmentは`v*`だけを許可し、required reviewerとself-review禁止を維持している。
前回のnpm package settings対話監査は2026-08-24で、次回期限は2026-11-22である。
今回の対話監査は`not_due`とする。

## 3. M2 release gate

既存のM2 gateは`go`を維持している。
各fileは`v0.4.2`以降に変更されていない。
SHA-256は`v0.4.3`のrelease commitで再計算し、`v0.4.2`の記録と一致した。

| 項目 | 値 |
| --- | --- |
| 14日pilot ID | `m2-cron-pilot-002` |
| 観測期間（UTC） | `2026-08-09`〜`2026-08-22` |
| 14日pilot report | [m2-cron-pilot-report-m2-cron-pilot-002.md](./m2-cron-pilot-report-m2-cron-pilot-002.md) |
| 14日pilot report SHA-256 | `sha256:192b53509c6cecf5a47608a72cd63f412f5348aa0dd27cacf93c295bacb36b44` |
| 修正後限定再評価 ID | `m2-post-fix-revalidation-001` |
| 修正後限定再評価 report | [m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md](./m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md) |
| 修正後限定再評価 report SHA-256 | `sha256:b09c5e3030bee3b26b950fab573b802f6d8897e58103c0783fb82d088dc7192a` |
| ranking observation | [observation.json](../testing/evidence/m2-post-fix-revalidation-001-observation.json) / `sha256:f45dcfadc3779be59825bcdb85aa4d6d7b70364fb3301370821e5b23a9a41531` |
| human evaluation | [human-evaluation.json](../testing/evidence/m2-post-fix-revalidation-001-human-evaluation.json) / `sha256:7e816c12ce44d33a104fc73018429b3098f07e1394b65d511beca6b040b8f22d` |
| human approval | [human-approval.json](../testing/evidence/m2-post-fix-revalidation-001-human-approval.json) / `sha256:88934752d2e92d6a508e87d354883d0fd225866fbc141d9c401008c1245ca63e` |
| maintainer reviewer | `TakehiroT` |
| M2 decision | `go` |
| Issue #118 | [closed](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/118) |

## 4. Local verification

release commitでrunbookの全ローカルgateと`release:verify`がpassした。
すべてcleanな一時worktreeで実行し、release準備PRのheadとはtreeが一致する。

| 項目 | 値 |
| --- | --- |
| OS | macOS 27.0 (26A425) |
| `node --version` | `v24.21.0` |
| `npm --version` | `11.19.0` |
| full gate実行commit | `2836669367907a01844d2f8c9b4b9443e9428a7f` |
| release準備PR head | `9d58c14e6a68e7da03c716a4997991a7c79b2a38` |
| tree一致 | 両commitとも`57ac4d85e3ecf5f6c8680bf6e96f3824a0c3a3df` |
| 実行日時 | `2026-09-29T07:02Z`〜`07:04Z`（UTC） |

dependency auditとsignature auditの後にだけlifecycle scriptを実行した。

| command | exit | report / digest | 判定 |
| --- | ---: | --- | --- |
| `npm ci --ignore-scripts` | 0 | 113 packagesを展開、vulnerability 0件 | pass |
| `npm run install-scripts:check` | 0 | approved 1件、denied 1件 | pass |
| `npm audit --audit-level=high` | 0 | vulnerability 0件 | pass |
| `npm audit signatures` | 0 | signature 113件、attestation 43件 | pass |
| `npm rebuild` | 0 | rebuild成功 | pass |
| `npm run check` | 0 | docs 34 files、80 test files / 1,047 tests | pass |
| `npm run golden` | 0 | M1、M2 outcome ranking、provider baseline | pass |
| `npm run quality:gate` | 0 | 全10 metricsがthreshold以上 | pass |
| `npm run package:smoke` | 0 | 253 files、11 MCP tools、CLI / stdio / Node API | pass |
| `npm run --silent release:verify -- --tag v0.4.3 --commit 2836669367907a01844d2f8c9b4b9443e9428a7f --repository-visibility public` | 0 | schema 2、license MIT、registry available | pass |

Coverageはstatements 88.69%、branches 78.79%、functions 94.11%、lines 89.45%だった。

### Security review

公開境界に影響する変更がないことをreview済みである。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL（Actions、JavaScript、TypeScript） | pass | [PR run 36532889526](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36532889526)、[main run 36534124013](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36534124013)、open alert 0件 |
| GitHub secret scanning | pass | open alert 0件 |
| Git historyのsecret scan | pass | GitHub secret scanningのopen alert 0件 |
| dependency audit | pass | vulnerability 0件。Dependabotのopen alert 0件 |
| registry signature audit | pass | signature 113件、attestation 43件 |
| package artifactのcredential scan | pass | private key、npm / GitHub token、AWS key、local-data pathの検査を通過 |
| data、command、path、admin boundary | pass | PR #183、#184、#186、#187、#189をreview。`src/`の変更なし |
| 残余リスク | pass | 変更は依存関係、test helper、文書に限られる。紹介動画はnpm packageの`files`に含まれない |

release検証では外部provider APIやTypeSafe APIへ実データを送信していない。

## 5. Pull Request CI

release準備PRとexact main commitのCIはNode.js 22 / 24でgreenである。

| 対象 | Node.js | check | golden | quality gate | package smoke | run URL |
| --- | --- | --- | --- | --- | --- | --- |
| PR #189 | 22 | pass | pass | pass | pass | [run 36532892556](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36532892556) |
| PR #189 | 24 | pass | pass | pass | pass | [run 36532892556](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36532892556) |
| main `28366693` | 22 | pass | pass | pass | pass | [run 36534124337](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36534124337) |
| main `28366693` | 24 | pass | pass | pass | pass | [run 36534124337](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36534124337) |

PR #189はCodeRabbitがpassし、指摘とreview threadは0件だった。

## 6. M3 acceptance

M3 acceptanceは全11項目がpassした。

| ID | 結果 | 実行または根拠 |
| --- | --- | --- |
| M3-AC-001 | pass | setup service、CLI runtime、local package smoke |
| M3-AC-002 | pass | provider拒否E2Eで外部送信0件 |
| M3-AC-003 | pass | readiness MCP E2Eとpackage smokeで`learning` |
| M3-AC-004 | pass | readiness MCP E2Eで正常な検索不一致 |
| M3-AC-005 | pass | trusted-human policy matrixとsubmit / finalize service |
| M3-AC-006 | pass | AI、未知bot、外部contributor、mixed trust、`must`のdeny matrix |
| M3-AC-007 | pass | review CLI real TTY E2E |
| M3-AC-008 | pass | 公開済みexact versionのNode.js 22 / 24 registry smoke |
| M3-AC-009 | pass | M2→M3 upgrade E2E |
| M3-AC-010 | pass | package smokeとupgrade E2Eのworkspace clean |
| M3-AC-011 | pass | setup / review real TTY E2EとJSON stdout purity |

### Readiness記録

全readiness状態で次の操作を特定できる。

| 状態 | 観測した結果 | 次の操作が具体的か |
| --- | --- | --- |
| `setup_required` | 未登録workspaceにsetup案内を返す | yes |
| `learning` | pending jobがありactive rule未作成 | yes |
| `ready` + match | active ruleを返す | yes |
| `ready` + normal mismatch | 正常な空`rules`を返す | yes |
| `empty` | 履歴もjobもないrepositoryを説明する | yes |

### Privacyとtrust記録

既存経路と任意のJev経路は、いずれも明示的なopt-inを要求する。

| 経路 | 結果 | 根拠 |
| --- | --- | --- |
| setupでproviderとhost-assistedを拒否し、外部送信が0件 | pass | CLI runtime E2E |
| host-assistedを明示opt-inし、diff hunkを含めず一件だけ送信 | pass | host-assisted distillation service test |
| JevをAPI keyまたはcloud consentなしで使用しない | pass | Jev classifier、setup、doctor test |
| Jevへraw review comment、diff hunk、evidence IDを送らない | pass | Jev request mapping test |
| sensitive contentをprovider / host-assisted / Jev境界の手前で拒否 | pass | sensitive content test |
| eligible trusted-human non-`must` candidateがactive | pass | trusted-human policy matrix |
| AI、未知bot、外部contributor、mixed trust、`must`がinboxに残る | pass | trusted-human policy matrix |
| unresolved inboxが既存active ruleを妨げない | pass | review inbox service test |
| batch reviewのapprove、reject、skip、edit、再開 | pass | review CLI real TTY E2E |
| workspaceに`.repo-knowledge/`が存在しない | pass | local package smokeとupgrade E2E |

## 7. Package artifact

公開物の正本は、cleanなRelease CIが生成したartifactである。
同じtarballをnpm registryから取得し、byte単位で一致することを確認した。

| 項目 | 値 |
| --- | --- |
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.4.3.tgz` |
| Release CI tarball SHA-256 | `sha256:629dbba35af616e77b86db83503c57fd5b33683f27a9d0ee666c2f94e0e87835` |
| npm shasum | `685a8a9e647916e637c75f6c601f84f32baee2ba` |
| npm integrity | `sha512-kLe565jQjj0J6QIidMZp59YpX1CyaJ7c57JLMWBBt3nppRbJzDTFnklfPO3x8HfAOSMczCU3O/0FzoPWIsIdbw==` |
| packed / unpacked size | 340,635 bytes / 1,603,021 bytes |
| package artifact | `npm-release-v0.4.3`、artifact ID `11018672378` |
| package artifact report SHA-256 | `sha256:3876a3c9029943ba5bd48839a6f8441f931add236df0d36ccbab2fa14ad76c1c` |
| bootstrap inventory | n/a。`v0.3.0`で完了済み |
| release gate report schema | `2` |
| allowlist判定 | pass。`dist-js-dts-plus-explicit-root-files-v3`、253 entries |
| credential / local-data scan | pass |
| stable root API | runtime `runDefaultRepoKnowledgeCli`、type `RunDefaultRepoKnowledgeCliOptions` |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

npm registryから`npm pack @tamat-llc/repo-knowledge-mcp@0.4.3`で取得したtarballは、Release CI artifactとSHA-256、バイト列とも完全に一致した（`cmp`でdiffなし）。

## 8. Release CIとregistry smoke

Release CIは全5ジョブがpassした。

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pass | [job 109300297768](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203/job/109300297768) |
| verify release | 24 | pass | [job 109300297641](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203/job/109300297641) |
| publish exact tarball（OIDC） | 24 | pass | [job 109300816311](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203/job/109300816311) |
| registry smoke | 22 | pass | [job 109301787719](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203/job/109301787719) |
| registry smoke | 24 | pass | [job 109301787598](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203/job/109301787598) |

### npm公開後の認証境界

OIDC publishとprovenanceは公開後の実測でpassした。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| OIDC publishが対象package、repository、workflow、environmentから成功した | pass | publish jobとnpm provenanceがrelease tag、commit、`release.yml`を示す |
| traditional npm credentialをworkflowで使用していない | pass | publish jobの`Reject traditional npm credentials and auth config`ステップがpassし、`npm publish ... --provenance`をOIDC経由で実行 |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass | repositoryとenvironmentのsecret / variableは各0件 |
| npm provenanceがrelease workflowとcommitを示す | pass | SLSA subject、tag、resolved commit、workflow、runを照合 |
| npm package settingsの対話監査 | not_due | 前回2026-08-24、次回期限2026-11-22。今回の事前契機なし |

`not_due`はnpm側のtoken禁止設定を今回直接確認したという意味ではない。
OIDC publishはtrusted publisherがpublish時に有効だったことを示す。
traditional token禁止設定までは証明しない。

### npm registry metadataとprovenance

registry metadataと2件のattestationは、packageとrelease identityに一致した。

| 項目 | 値 |
| --- | --- |
| version / `latest` | `0.4.3` / `0.4.3` |
| `bootstrap` dist-tag | `0.0.0-bootstrap.0` |
| 公開日時 | `2026-09-29T07:28:08.418Z` |
| file count / unpacked size | 253 / 1,603,021 bytes |
| SLSA subject | `pkg:npm/%40tamat-llc/repo-knowledge-mcp@0.4.3` |
| SLSA subject SHA-512 | `90b7b9eb98d08e3d09e9022274c669e7d6295f50b2689edce7b24b316041b779e9a516c9cc34c59e495f3cedf1f077c039231ccc25373bfd05ce83d622c21d6f` |
| resolved Git commit | `2836669367907a01844d2f8c9b4b9443e9428a7f` |
| workflow | `TamaT-LLC/repo-knowledge-mcp/.github/workflows/release.yml@refs/tags/v0.4.3` |
| builder | `https://github.com/actions/runner/github-hosted` |
| invocation | [run 36536073203 attempt 1](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/36536073203/attempts/1) |
| attestations | npm publish attestationとSLSA provenanceの2件 |

SLSA subjectのSHA-512はregistry integrityを16進数へ変換した値と一致した。
publish attestationのpackage、version、registryも公開物と一致した。

## 9. Incidentと差分

公開前に発生した操作上の失敗は、公開物へ影響していない。

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | PR #189がself-review禁止のrequired reviewで停止 | 通常mergeが拒否された | 全CI green、CodeRabbit指摘0件を確認してadmin merge | なし |
| PRE-002 | 最初のlocal gateがshellのPATH解決でNode.js `v22.23.2` / npm `10.9.8`になった | `release:verify`のnpm要件を満たさないため、記録に使えない | tag作成前に検出し、Node.js `v24.21.0` / npm `11.19.0`で`npm ci`から全gateを再実行してpass | なし |
| PRE-003 | GitHubのtag署名表示が`unknown_key` | GitHub UIは署名者を識別できない | localで署名の完全性とRSA fingerprintを検証。commit SHAとtag protectionも確認 | なし |
| REL-001 | `npm` environmentのrequired reviewerによりpublish jobが待機 | OIDC publishの開始が約2分27秒保留された（`waiting`: `2026-09-29T07:22:27Z`、`queued`: `2026-09-29T07:24:52Z`） | owner（`TakehiroT`）が承認した。self-review禁止、required reviewer、`v*` policyは変更・解除していない | なし |

`v0.4.2`のREL-001（self-review禁止の一時解除、約18分の待機）とは異なり、今回はpolicyを変更せずに短時間で承認が完了した。

## 10. Go / no-go

公開前gateと公開後検証はすべて`go`である。

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go | §3 |
| Local verification | go | §4 |
| Pull Request / main CI Node.js 22 / 24 | go | §5 |
| M3-AC-001〜011 | go | §6。全11項目pass |
| package artifact | go | Release CI artifact、registry integrity、provenanceが一致 |
| npm publishとregistry smoke Node.js 22 / 24 | go | §8。OIDC publishと両runtimeのsmokeがpass |
| tokenless OIDC publishing boundary | go | §8。OIDC publish、provenance、credential 0件、credential guardを確認 |
| versionの全媒体一致 | go | source、tag、GitHub Release、npm registry、provenanceが`0.4.3`で一致 |

**総合判定: release完了**

- operator: `TakehiroT`
- evidence compilation: `Claude Code`
- reviewer: PR #189、PR #190、CI、CodeQL、CodeRabbit、および本reportのPull Request
- 最終判断日時（UTC）: `2026-09-29T07:28Z`
- release tracking: PR #189、PR #190、本reportのPull Request、release run 36536073203

本reportをreviewしてmainへ反映し、同じfileでGitHub Release assetを置き換える。
main上のfileとRelease assetのSHA-256一致を最終確認とする。
