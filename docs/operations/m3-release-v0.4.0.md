# M3 v0.4.0 release report

本reportは、`@tamat-llc/repo-knowledge-mcp@0.4.0`の公開前gate、OIDC publish、provenance、公開後検証を記録する。

現時点では公開前gateが完了し、Git tagとdraft GitHub Releaseを作成済みである。
GitHub Release、npm package、registry smokeは未完了なので、総合判定は`release未完了`とする。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.4.0` |
| Git tag | `v0.4.0` |
| tag object | `9288a1b12ee1625714bbda91deb313a57610a7ac`。SSH署名をlocal検証済み |
| commit SHA | `49980435933dd40a52f6481b025b73447a6eb985` |
| main到達確認 | `git merge-base --is-ancestor 4998043 origin/main`: pass |
| GitHub Release | [draft release](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/untagged-4a8c576639e6b8f464b3) |
| 公開後GitHub Release URL | `https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.0` |
| npm registry URL | `https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.0` |
| npm integrity | 公開後に記録 |
| npm provenance | 公開後に記録 |
| release workflow run | GitHub Release公開後に記録 |

`v0.4.0`はpre-1.0のbreaking minor releaseである。
CLI commandとMCP protocolは互換性を維持するが、`v0.3.0`のpackage rootから旧symbolをimportするNode.js consumerは`./experimental`へ移行する必要がある。

## 2. 公開前提

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| npm organizationが`tamat-llc`である | pass | 公開済み`0.3.0`のregistry metadataと[v0.3.0 release report](./m3-release-v0.3.0.md) |
| 初回publisherがorganization内のpublish権限と2FAを持つ | n/a | 初回bootstrapとstable publishは`v0.3.0`で完了済み |
| project licenseと`package.json`のlicenseが確定している | pass | `package.json`はMIT |
| 空でない通常ファイルの`LICENSE`がrelease commitに存在する | pass | `release:verify`のlicense gate |
| GitHub repositoryがpublicである | pass | `release:verify`のvisibility gate |
| inert bootstrap packageとstable OIDC publishingの境界が確定している | pass | `0.0.0-bootstrap.0`は公開・deprecate済み。stable `0.3.0`はOIDCで公開済み |
| bootstrap tarballのfile list、version、dist-tagがreview済みである | n/a | bootstrapを後続releaseで繰り返さない |
| 長期npm tokenをrepository secretに置いていない | pass | GitHub `npm` environmentのsecret 0件、variable 0件 |
| 対象versionがregistryで未使用である | pass | `release:verify`の`registry_status: available` |
| working treeがcleanである | pass | `git status --short --branch`に差分なし |
| security reviewに未解決のcriticalまたはhigh findingがない | pass | CodeQL、secret scanning、Dependabotのopen alertはいずれも0件 |

Trusted publisherの固定値はpackage、`TamaT-LLC/repo-knowledge-mcp`、`release.yml`、GitHub `npm` environment、`npm publish`権限、trust ID `c7c3ff7b-8cb5-4575-bcec-796f76ff7dcb`である。
この値と2FA必須・token禁止の設定は`v0.3.0`公開時に確認した。

今回のrelease workflow差分はnpmを`12.0.2`へ更新し、dependency install-script gateをverify jobとpublish jobへ追加した。
OIDC、environment、workflow filename、publish権限の境界は変更していない。

local npm CLIは意図的に未認証なので、`npm trust list`はE401を返した。
この操作で設定は変更していない。
最終判定ではOIDC publishの成功、provenance、npm package settingsを再確認する。

## 3. M2 release gate

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
| human evaluator / approver | `TakehiroT` |
| M2 decision | `go` |
| Issue #70 / #118 | いずれもclosed |

14日運用gateと修正後ranking gateを組み合わせた`go`、共有可能なhuman evaluationとapproval、review済みreportを`v0.4.0`でもM2 baselineとして使用する。

## 4. Local verification

| 項目 | 値 |
| --- | --- |
| OS | macOS 26.3.1 (25D771280a) |
| `node --version` | `v24.19.0` |
| `npm --version` | `12.0.2` |
| 実行commit | `49980435933dd40a52f6481b025b73447a6eb985` |
| 実行日時 | `2026-08-25T19:49Z`〜`19:51Z`（UTC） |

Runbookの順序どおり、dependency auditとsignature auditの後にだけlifecycle scriptを実行した。

| command | exit | report / digest | 判定 |
| --- | ---: | --- | --- |
| `npm ci --ignore-scripts` | 0 | 112 packagesを展開 | pass |
| `npm run install-scripts:check` | 0 | approved 1件、denied 1件 | pass |
| `npm audit --audit-level=high` | 0 | vulnerability 0件 | pass |
| `npm audit signatures` | 0 | signature 112件、attestation 42件 | pass |
| `npm rebuild` | 0 | rebuild成功 | pass |
| `npm run check` | 0 | docs 30 files、release tool 17 tests、76 files / 888 tests | pass |
| `npm run golden` | 0 | M1、M2 outcome ranking、provider baseline | pass |
| `npm run quality:gate` | 0 | 全10 metricsがthreshold以上 | pass |
| `npm run package:smoke` | 0 | 225 files、11 MCP tools、CLI / stdio / readiness / workspace clean | pass |
| `npm run --silent release:verify -- --tag v0.4.0 --commit 4998043 --repository-visibility public` | 0 | schema 2、license MIT、registry available | pass |

Coverageはstatements 84.49%、branches 74.64%、functions 91.98%、lines 85.30%だった。

### Security review

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL（Actions、JavaScript、TypeScript） | pass | main run [32891541083](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32891541083)、open alert 0件 |
| GitHub secret scanning | pass | open alert 0件 |
| Git historyのsecret scan | pass | GitHub secret scanningのopen alert 0件、push protection付きbaseline review |
| dependency audit | pass | vulnerability 0件 |
| registry signature audit | pass | signature 112件、attestation 42件 |
| package artifactのcredential scan | pass | package artifact gateのcredential patternとlocal-data path検査を通過 |
| data、command、path、admin boundaryの差分review | pass | PR #147のsensitive payload境界、PR #151のNode API境界、PR #160のrelease準備をreview |
| 残余リスク | pass | experimental APIは互換性保証外。CLI / MCP利用者にはbreaking changeなし |

## 5. Pull Request CI

Release準備PR [#160](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/160)の最終headは`38c36d30681ce6de06197d12efe90e7abe30d57d`である。
このheadとrelease commitのtreeは、どちらも`81009821ac65d8f514d74c8c676aa01a3c564ec7`で一致する。

| Node.js | check | golden | quality gate | local-tarball package smoke | run URL |
| --- | --- | --- | --- | --- | --- |
| 22 | pass | pass | pass | pass | [CI run 32891281257](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32891281257) |
| 24 | pass | pass | pass | pass | [CI run 32891281257](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32891281257) |

Mainのexact release commitでも[CI run 32891541573](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32891541573)のNode.js 22 / 24がpassした。
PR #160のCodeQL、Greptile、CodeRabbitはpassし、最終commitの未解決review threadは0件だった。

## 6. M3 acceptance

判定根拠は[M3 acceptance matrix](../testing/m3-acceptance-matrix.md)に固定する。

| ID | 結果 | 実行または根拠 |
| --- | --- | --- |
| M3-AC-001 | pass | setup service、CLI runtime、local package smoke |
| M3-AC-002 | pass | provider拒否E2Eで外部送信0件 |
| M3-AC-003 | pass | readiness MCP E2Eとpackage smokeで`learning` |
| M3-AC-004 | pass | readiness MCP E2Eで`ready`の正常な検索不一致 |
| M3-AC-005 | pass | trusted-human policy matrixとsubmit / finalize service |
| M3-AC-006 | pass | AI、未知bot、外部contributor、mixed trust、`must`のdeny matrix |
| M3-AC-007 | pass | review CLI real TTY E2E |
| M3-AC-008 | pending | 公開後のNode.js 22 / 24 registry smokeで確定する |
| M3-AC-009 | pass | M2→M3 upgrade E2E |
| M3-AC-010 | pass | CLI runtime、package smoke、upgrade E2Eのworkspace clean |
| M3-AC-011 | pass | setup / review real TTY E2EとJSON stdout purity |

### Readiness記録

| 状態 | 観測した結果 | 次の操作が具体的か |
| --- | --- | --- |
| `setup_required` | 未登録workspaceにsetup案内を返す | yes |
| `learning` | pending jobがありactive rule未作成 | yes |
| `ready` + match | active ruleを返す | yes |
| `ready` + normal mismatch | 正常な空`rules`を返す | yes |
| `empty` | 履歴もjobもないrepositoryを説明する | yes |

### Privacyとtrust記録

| 経路 | 結果 | 根拠 |
| --- | --- | --- |
| setupでproviderとhost-assistedを拒否し、外部送信が0件 | pass | CLI runtime E2E |
| host-assistedを明示opt-inし、diff hunkを含めず一件だけ送信 | pass | host-assisted distillation service test |
| sensitive contentをprovider / host-assisted境界の手前で拒否 | pass | sensitive content testとhost-assisted distillation service test |
| eligible trusted-human non-`must` candidateがactive | pass | trusted-human policy matrix |
| AI、未知bot、外部contributor、mixed trust、`must`がinboxに残る | pass | trusted-human policy matrix |
| unresolved inboxが既存active ruleを妨げない | pass | review inbox service test |
| batch reviewのapprove、reject、skip、edit、再開 | pass | review CLI real TTY E2E |
| workspaceに`.repo-knowledge/`が存在しない | pass | local package smokeとupgrade E2E |

実測検証では外部provider APIとAPI keyを使用していない。

## 7. Package artifact

| 項目 | 値 |
| --- | --- |
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.4.0.tgz` |
| local tarball SHA-256 | `sha256:aea7147dd0f2a4d287011a11ca8e8a684ff420c3839d0b0b66dc421233e1a53c` |
| local npm shasum | `adbc8ecbfa32ab40a6200f0df98c6c1845486e40` |
| local npm integrity | `sha512-/6Od41VwMGC+VbOSjm8uvDev+aG6SD0g9NmB4cMctooIXfNoNDI2DfHfdB9+EnVr9mkPCxhxZgp2o4Ska33jJQ==` |
| local packed size / unpacked size | 327,684 bytes / 1,542,520 bytes |
| package artifact report | Release CI完了後に記録 |
| bootstrap inventory | n/a。`v0.3.0`で完了済み |
| release gate report schema | `2` |
| allowlist判定 | pass。225 entries |
| credential / local-data scan | pass |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

## 8. Release CIとregistry smoke

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pending | GitHub Release公開後に記録 |
| verify release | 24 | pending | GitHub Release公開後に記録 |
| publish exact tarball（OIDC） | 24 | pending | GitHub Release公開後に記録 |
| registry smoke | 22 | pending | GitHub Release公開後に記録 |
| registry smoke | 24 | pending | GitHub Release公開後に記録 |

### npm公開後の認証固定

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| trusted publisherがpackage、repository、`release.yml`、`npm` environment、publish権限を示す | pending | OIDC publish後に再確認 |
| npm publishing accessが2FA必須かつtoken禁止である | pending | npm package settingsで再確認 |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass | GitHub APIでいずれも0件 |
| npm provenanceがrelease workflowとcommitを示す | pending | 公開後に再確認 |

## 9. Incidentと差分

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | PR #160のauto-mergeがself-review禁止のrequired reviewで停止 | release準備PRが自動mergeされない | 全check greenと未解決thread 0件を確認し、repository adminとしてmerge | なし |
| PRE-002 | 既定GPG設定ではtag署名に失敗 | remote tagへの影響なし | `v0.3.0`と同じ既存SSH keyを明示し、fingerprint一致と署名をlocal検証してからpush | なし |
| PRE-003 | local `npm trust list`がE401 | local CLIからtrusted publisherを再表示できない | 認証状態を変更せず、`v0.3.0`のtrust ID、GitHub environment、最終OIDC publishで検証 | なし |

## 10. Go / no-go

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go | §3 |
| Local verification | go | §4 |
| Pull Request CI Node.js 22 / 24 | go | §5 |
| M3-AC-001〜011 | pending | M3-AC-008を公開後に確定する |
| package artifact | pre-release go | local artifactはpass、Release CI reportはpending |
| npm publishとregistry smoke Node.js 22 / 24 | pending | §8 |
| trusted publisherとtraditional token禁止 | pending | baselineはpass、公開後に再確認 |
| versionの全媒体一致 | pending | sourceとtagは一致。GitHub Releaseとnpm registryは未公開 |

**総合判定: release未完了（公開前gateはgo）**

- operator: `TakehiroT`
- evidence compilation: `Codex`
- reviewer: PR #160と[#161](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/161)のCI、CodeQL、Greptile、CodeRabbit
- 最終判断日時（UTC）: 公開後に記録
- release tracking: PR #160、PR #161

本reportの§1〜§7をreviewしてmainへ反映し、同じfileをdraft GitHub Releaseへ添付した後にだけReleaseを公開する。
Release CI完了後は§8〜§10を実測値で更新し、main上のfileとGitHub Release assetのSHA-256を一致させる。
