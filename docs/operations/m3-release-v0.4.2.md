# M3 v0.4.2 release report

`@tamat-llc/repo-knowledge-mcp@0.4.2`はnpm registryへ公開済みである。
OIDC publish、provenance、Node.js 22 / 24のregistry smokeはすべてpassした。
総合判定は`release完了`である。

## 1. Release identity

release identityはmain上のcommit `037fc508`へ固定した。

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.4.2` |
| Git tag | `v0.4.2` |
| tag object | `99d6d1a531bd82aa166eab5bce956c50af3963ce` |
| tag署名 | RSA key `SHA256:1X9sHQvcez+SrxBmBj/gXNBeItAjPh+889/T/ZSxX8o`でlocal検証済み |
| commit SHA | `037fc5082fed2fb3d90a968a30a288f1f72b9534` |
| main到達確認 | `git merge-base --is-ancestor 037fc508 origin/main`: pass |
| GitHub Release | [v0.4.2](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.2)。`2026-09-20T07:51:26Z`に公開 |
| npm registry | [@tamat-llc/repo-knowledge-mcp@0.4.2](https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.2)。`2026-09-20T08:13:00.170Z`に公開 |
| npm integrity | `sha512-72kDfn4MRSOKJFi6/C2nqlB9VOsA7GTeT48E76547sTNybQJkYZnbnVI00r5OA5djCzij5AVeb+XPkstDsZdEw==` |
| npm shasum | `f8c4f3c6e83e40e5c454900e9a86bbe47b70ce1e` |
| npm provenance | pass。SLSA subject、release commit、workflow、runが一致 |
| release workflow | [run 35497990124](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124) |

`v0.4.2`は後方互換のpatch releaseである。
任意のTypeSafe Jevマージ判定、service分割、CLI coverage gate、依存関係と利用文書の更新を含む。

## 2. 公開前提

公開前提はすべてpassしている。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| npm organizationが`tamat-llc`である | pass | 公開済み`0.4.1`のregistry metadataと[v0.4.1 release report](./m3-release-v0.4.1.md) |
| 初回publisherがorganization内のpublish権限と2FAを持つ | n/a | bootstrapとstable publishは`v0.3.0`で完了済み |
| project licenseと`package.json`のlicenseが確定している | pass | `package.json`とGitHub repository metadataはMIT |
| 空でない通常ファイルの`LICENSE`がrelease commitに存在する | pass | `release:verify`のlicense gate |
| GitHub repositoryがpublicである | pass | `release:verify`のvisibility gate |
| inert bootstrap packageとstable OIDC publishingの境界が確定している | pass | `0.0.0-bootstrap.0`は公開・deprecate済み |
| bootstrap tarballのfile list、version、dist-tagがreview済みである | n/a | bootstrapを後続releaseで繰り返さない |
| 長期npm tokenをrepository secretに置いていない | pass | repositoryと`npm` environmentのsecret / variableは各0件 |
| 対象versionがregistryで未使用である | pass | `release:verify`の`registry_status: available` |
| working treeがcleanである | pass | cleanな一時worktreeでrelease identityを検証 |
| security reviewに未解決のcriticalまたはhigh findingがない | pass | CodeQL、secret scanning、high以上のDependabot alertは各0件 |

GitHub `npm` environmentは`v*`だけを許可し、required reviewerとself-review禁止を維持している。
前回のnpm package settings対話監査は2026-08-24で、次回期限は2026-11-22である。
今回の対話監査は`not_due`とする。

## 3. M2 release gate

既存のM2 gateは`go`を維持している。

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

release準備headでrunbookの全ローカルgateがpassした。
同一treeのrelease commitでは`release:verify`をcleanな一時worktreeで実行した。

| 項目 | 値 |
| --- | --- |
| OS | macOS 26.3.1 (25D771280a) |
| `node --version` | `v24.21.0` |
| `npm --version` | `11.19.0` |
| full gate実行commit | `ac80a6409fbf78d38f9ef0a36481ad038e7c19e8` |
| release commit | `037fc5082fed2fb3d90a968a30a288f1f72b9534` |
| tree一致 | 両commitとも`fe53b5799fb97bb47d7859c6601d044c73bf57f9` |
| 実行日時 | `2026-09-20T07:34Z`〜`07:41Z`（UTC） |

dependency auditとsignature auditの後にだけlifecycle scriptを実行した。

| command | exit | report / digest | 判定 |
| --- | ---: | --- | --- |
| `npm ci --ignore-scripts` | 0 | 113 packagesを展開、vulnerability 0件 | pass |
| `npm run install-scripts:check` | 0 | approved 1件、denied 1件 | pass |
| `npm audit --audit-level=high` | 0 | vulnerability 0件 | pass |
| `npm audit signatures` | 0 | signature 113件、attestation 43件 | pass |
| `npm rebuild` | 0 | rebuild成功 | pass |
| `npm run check` | 0 | docs 33 files、80 test files / 1,047 tests | pass |
| `npm run golden` | 0 | M1、M2 outcome ranking、provider baseline | pass |
| `npm run quality:gate` | 0 | 全10 metricsがthreshold以上 | pass |
| `npm run package:smoke` | 0 | 255 files、11 MCP tools、CLI / stdio / Node API | pass |
| `npm run --silent release:verify -- --tag v0.4.2 --commit 037fc5082fed2fb3d90a968a30a288f1f72b9534 --repository-visibility public` | 0 | schema 2、license MIT、registry available | pass |

Coverageはstatements 88.69%、branches 78.79%、functions 94.11%、lines 89.45%だった。

### Security review

公開境界と新しいJev送信経路をreview済みである。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL（Actions、JavaScript、TypeScript） | pass | [PR run 35497338020](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497338020)、[main run 35497431807](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497431807)、open alert 0件 |
| GitHub secret scanning | pass | open alert 0件 |
| Git historyのsecret scan | pass | GitHub secret scanningのopen alert 0件 |
| dependency audit | pass | vulnerability 0件 |
| registry signature audit | pass | signature 113件、attestation 43件 |
| package artifactのcredential scan | pass | private key、npm / GitHub token、AWS key、local-data pathの検査を通過 |
| data、command、path、admin boundary | pass | PR #172、#178、#179をreview |
| 残余リスク | pass | Jevは既定で無効。API keyと明示的なcloud consentがない場合は従来経路を維持する |

release検証では外部provider APIやTypeSafe APIへ実データを送信していない。

## 5. Pull Request CI

release準備PRとexact main commitのCIはNode.js 22 / 24でgreenである。

| 対象 | Node.js | check | golden | quality gate | package smoke | run URL |
| --- | --- | --- | --- | --- | --- | --- |
| PR #179 | 22 | pass | pass | pass | pass | [run 35497338727](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497338727) |
| PR #179 | 24 | pass | pass | pass | pass | [run 35497338727](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497338727) |
| main `037fc508` | 22 | pass | pass | pass | pass | [run 35497432150](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497432150) |
| main `037fc508` | 24 | pass | pass | pass | pass | [run 35497432150](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497432150) |

PR #179はCodeRabbitがpassし、指摘とreview threadは0件だった。

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
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.4.2.tgz` |
| Release CI tarball SHA-256 | `sha256:375c7b4e24ca995cb9d5c11a206bcdf5c4faea4c6a6fe5589235687d182bde26` |
| npm shasum | `f8c4f3c6e83e40e5c454900e9a86bbe47b70ce1e` |
| npm integrity | `sha512-72kDfn4MRSOKJFi6/C2nqlB9VOsA7GTeT48E76547sTNybQJkYZnbnVI00r5OA5djCzij5AVeb+XPkstDsZdEw==` |
| packed / unpacked size | 340,536 bytes / 1,602,797 bytes |
| package artifact | `npm-release-v0.4.2`、artifact ID `10601633674` |
| package artifact report SHA-256 | `sha256:f71a5964c8acffaea8a95f4d5d7809e676cb4b7c993adb6bed64a672a7135665` |
| bootstrap inventory | n/a。`v0.3.0`で完了済み |
| release gate report schema | `2` |
| allowlist判定 | pass。`dist-js-dts-plus-explicit-root-files-v3`、253 entries |
| credential / local-data scan | pass |
| stable root API | runtime `runDefaultRepoKnowledgeCli`、type `RunDefaultRepoKnowledgeCliOptions` |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

## 8. Release CIとregistry smoke

Release CIは全5ジョブがpassした。

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pass | [job 106044484301](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124/job/106044484301) |
| verify release | 24 | pass | [job 106044484185](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124/job/106044484185) |
| publish exact tarball（OIDC） | 24 | pass | [job 106044656383](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124/job/106044656383) |
| registry smoke | 22 | pass | [job 106046953666](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124/job/106046953666) |
| registry smoke | 24 | pass | [job 106046953793](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124/job/106046953793) |

### npm公開後の認証境界

OIDC publishとprovenanceは公開後の実測でpassした。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| OIDC publishが対象package、repository、workflow、environmentから成功した | pass | publish jobとnpm provenanceがrelease tag、commit、`release.yml`を示す |
| traditional npm credentialをworkflowで使用していない | pass | credential環境変数、effective npm config、project / user / global `.npmrc`のfail-closed検査を通過 |
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
| version / `latest` | `0.4.2` / `0.4.2` |
| `bootstrap` dist-tag | `0.0.0-bootstrap.0` |
| 公開日時 | `2026-09-20T08:13:00.170Z` |
| file count / unpacked size | 253 / 1,602,797 bytes |
| SLSA subject | `pkg:npm/%40tamat-llc/repo-knowledge-mcp@0.4.2` |
| SLSA subject SHA-512 | `ef69037e7e0c45238a2458bafc2da7aa507d54eb00ec64de4f8f04efae78eec4cdc9b4099186676e7548d34af9380e5d8c2ce28f901579bf973e4b2d0ec65d13` |
| resolved Git commit | `037fc5082fed2fb3d90a968a30a288f1f72b9534` |
| workflow | `TamaT-LLC/repo-knowledge-mcp/.github/workflows/release.yml@refs/tags/v0.4.2` |
| builder | `https://github.com/actions/runner/github-hosted` |
| invocation | [run 35497990124 attempt 1](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/35497990124/attempts/1) |
| attestations | npm publish attestationとSLSA provenanceの2件 |

SLSA subjectのSHA-512はregistry integrityを16進数へ変換した値と一致した。
publish attestationのpackage、version、registryも公開物と一致した。

## 9. Incidentと差分

公開前に発生した操作上の失敗は、公開物へ影響していない。

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | PR #179がself-review禁止のrequired reviewで停止 | 通常mergeが拒否された | 全CI green、CodeRabbit指摘0件を確認してadmin merge | なし |
| PRE-002 | 最初の署名tag作成で署名方式が未指定だった | tagは作成されなかった | 過去releaseと同じSSH RSA鍵を明示して作成し、署名をlocal検証 | なし |
| PRE-003 | release gateへ未対応の`--cwd`を渡した | 検証開始前に引数エラーで終了した | cleanな一時worktreeを作業ディレクトリにして再実行しpass | なし |
| PRE-004 | GitHubのtag署名表示が`unknown_key` | GitHub UIは署名者を識別できない | localで署名の完全性とRSA fingerprintを検証。commit SHAとtag protectionも確認 | なし |
| PRE-005 | local checkoutのignored `dist/`に削除済みmodule 2件が残っていた | local tarballが255 entriesとなり、clean CI artifactとhashが異なった | clean checkoutのRelease CI artifactだけを公開し、registry tarballとのbyte一致を確認 | なし |
| REL-001 | `npm` environmentのself-review禁止によりpublish jobが待機 | OIDC publishの開始が約18分保留された | ownerの明示承認後、一時的にself-review禁止を解除してdeploymentを承認。直後にrequired reviewer、self-review禁止、`v*` policyを復元 | なし |

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
| versionの全媒体一致 | go | source、tag、GitHub Release、npm registry、provenanceが`0.4.2`で一致 |

**総合判定: release完了**

- operator: `TakehiroT`
- evidence compilation: `Codex`
- reviewer: PR #178、PR #179、CI、CodeQL、CodeRabbit、および本reportのPull Request
- 最終判断日時（UTC）: `2026-09-20T08:21Z`
- release tracking: PR #178、PR #179、PR #180、本reportのPull Request、release run 35497990124

本reportをreviewしてmainへ反映し、同じfileでGitHub Release assetを置き換える。
main上のfileとRelease assetのSHA-256一致を最終確認とする。
