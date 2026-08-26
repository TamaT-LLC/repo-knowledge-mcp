# M3 v0.4.1 release report

本reportは、`@tamat-llc/repo-knowledge-mcp@0.4.1`の公開前gate、OIDC publish、provenance、公開後検証を記録する。

現時点では公開前gateが完了し、Git tagとdraft GitHub Releaseを作成済みである。
GitHub Release、npm package、registry smokeは未完了なので、総合判定は`release未完了`とする。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.4.1` |
| Git tag | `v0.4.1` |
| tag object | `ca04561aaea3e8f21c6d8394fbcf1203dbb34658`。SSH署名をlocal検証済み |
| commit SHA | `53bed87d07999c84cbe565c224dd4ea28853e036` |
| main到達確認 | `git merge-base --is-ancestor 53bed87 origin/main`: pass |
| GitHub Release | [draft release](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/untagged-f2c355c86363564e2a1d) |
| 公開後GitHub Release URL | `https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.1` |
| npm registry URL | `https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.1` |
| npm integrity | 公開後に記録 |
| npm provenance | 公開後に記録 |
| release workflow run | GitHub Release公開後に記録 |

`v0.4.1`はbackward-compatibleなpatch releaseである。
GitHubの検索結果がpage間で変化した場合のPull Request一覧retry、npm 12のregistry smoke互換性、traditional npm credentialのfail-closed検出を含む。

## 2. 公開前提

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| npm organizationが`tamat-llc`である | pass | 公開済み`0.4.0`のregistry metadataと[v0.4.0 release report](./m3-release-v0.4.0.md) |
| 初回publisherがorganization内のpublish権限と2FAを持つ | n/a | 初回bootstrapとstable publishは`v0.3.0`で完了済み |
| project licenseと`package.json`のlicenseが確定している | pass | `package.json`はMIT |
| 空でない通常ファイルの`LICENSE`がrelease commitに存在する | pass | `release:verify`のlicense gate |
| GitHub repositoryがpublicである | pass | `release:verify`のvisibility gate |
| inert bootstrap packageとstable OIDC publishingの境界が確定している | pass | `0.0.0-bootstrap.0`は公開・deprecate済み。stable releaseはOIDCで公開済み |
| bootstrap tarballのfile list、version、dist-tagがreview済みである | n/a | bootstrapを後続releaseで繰り返さない |
| 長期npm tokenをrepository secretに置いていない | pass | repositoryとGitHub `npm` environmentのsecret / variableはいずれも0件 |
| 対象versionがregistryで未使用である | pass | `release:verify`の`registry_status: available` |
| working treeがcleanである | pass | `git status --short --branch`に差分なし |
| security reviewに未解決のcriticalまたはhigh findingがない | pass | CodeQL、secret scanning、Dependabotのopen alertはいずれも0件 |

Trusted publisherの固定値はpackage、`TamaT-LLC/repo-knowledge-mcp`、`release.yml`、GitHub `npm` environment、`npm publish`権限、trust ID `c7c3ff7b-8cb5-4575-bcec-796f76ff7dcb`である。
この値と2FA必須・token禁止の設定は、`v0.3.0`公開時の2026-08-24に対話監査した。
次回の定期監査期限は2026-11-22である。

今回のrelease workflowは、`v0.4.0`公開後にnpm 12のmetadata envelopeと正常なdiagnostic stderrを許容し、publish jobのcredential環境変数、effective npm config、project / user / globalの`.npmrc`をfail-closedで検査するよう強化した。
OIDC、environment、workflow filename、publish権限の境界は変更していない。

今回の対話監査は`not_due`であり、npm側の現在設定を直接確認したという`pass`判定には使わない。
通常releaseの認証境界は、OIDC publish、npm attestation、GitHub credential 0件で判定する。

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

14日運用gateと修正後ranking gateを組み合わせた`go`、共有可能なhuman evaluationとapproval、review済みreportを`v0.4.1`でもM2 baselineとして使用する。

## 4. Local verification

| 項目 | 値 |
| --- | --- |
| OS | macOS 26.3.1 (25D771280a) |
| `node --version` | `v24.19.0` |
| `npm --version` | `11.17.0` |
| full gate実行commit | `0dc05e7929893d9608d82aea1e3f9081f8984bbb` |
| release commit | `53bed87d07999c84cbe565c224dd4ea28853e036` |
| tree一致 | 両commitとも`3859174d54f0c1a576febbe23be86d2e179ddd7c` |
| 実行日時 | `2026-08-26T08:41Z`〜`08:47Z`（UTC） |

Runbookの順序どおり、dependency auditとsignature auditの後にだけlifecycle scriptを実行した。
full gateはrelease準備PR headで実行し、同一treeのexact release commitでは`release:verify`とmain CIを実行した。

| command | exit | report / digest | 判定 |
| --- | ---: | --- | --- |
| `npm ci --ignore-scripts` | 0 | 112 packagesを展開、vulnerability 0件 | pass |
| `npm run install-scripts:check` | 0 | approved 1件、denied 1件 | pass |
| `npm audit --audit-level=high` | 0 | vulnerability 0件 | pass |
| `npm audit signatures` | 0 | signature 112件、attestation 42件 | pass |
| `npm rebuild` | 0 | rebuild成功 | pass |
| `npm run check` | 0 | docs 31 files、release tool 18 tests、76 files / 891 tests | pass |
| `npm run golden` | 0 | M1、M2 outcome ranking、provider baseline | pass |
| `npm run quality:gate` | 0 | 全10 metricsがthreshold以上 | pass |
| `npm run package:smoke` | 0 | 225 local files、11 MCP tools、CLI / stdio / readiness / workspace clean | pass |
| `npm run --silent release:verify -- --tag v0.4.1 --commit 53bed87 --repository-visibility public` | 0 | schema 2、license MIT、registry available | pass |

Coverageはstatements 84.47%、branches 74.64%、functions 91.99%、lines 85.29%だった。

### Security review

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL（Actions、JavaScript、TypeScript） | pass | PR run [32949325550](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32949325550)、main run [32949512080](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32949512080)、open alert 0件 |
| GitHub secret scanning | pass | open alert 0件 |
| Git historyのsecret scan | pass | GitHub secret scanningのopen alert 0件、push protection付きbaseline review |
| dependency audit | pass | vulnerability 0件 |
| registry signature audit | pass | signature 112件、attestation 42件 |
| package artifactのcredential scan | pass | private key、npm / GitHub token、AWS key、local-data pathの検査を通過 |
| data、command、path、admin boundaryの差分review | pass | PR #162、#163、#164、#166、#167をreview |
| 残余リスク | pass | GitHub検索結果が二回連続で変動する場合は明示的に失敗する。公開artifactはclean Release CIで生成する |

## 5. Pull Request CI

Release準備PR [#167](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/167)の最終headは`0dc05e7929893d9608d82aea1e3f9081f8984bbb`である。
このheadとrelease commitのtreeは、どちらも`3859174d54f0c1a576febbe23be86d2e179ddd7c`で一致する。

| Node.js | check | golden | quality gate | local-tarball package smoke | run URL |
| --- | --- | --- | --- | --- | --- |
| 22 | pass | pass | pass | pass | [CI run 32949328316](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32949328316) |
| 24 | pass | pass | pass | pass | [CI run 32949328316](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32949328316) |

Mainのexact release commitでも[CI run 32949513206](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32949513206)のNode.js 22 / 24がpassした。
PR #167のCodeQLとGreptileはpassし、Greptileはconfidence 5/5、具体的な指摘なし、未解決review threadは0件だった。
CodeRabbitはreview rate limitのため実質reviewを行わず、statusのみpassだった。

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
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.4.1.tgz` |
| local tarball SHA-256 | `sha256:975303a769a7a708d43728084c521196776f120498f81aa9fe74ba3c3c6002b3` |
| local npm shasum | `0becf5677207d7a437b43005b2b5fa9e1a695ad9` |
| local npm integrity | `sha512-oFFB9m9/002jJFX/lAu/Th41nCjEFzDDEmYOpOIJMIWKrKfUzIfoAABMikg1f3xfvuSS9wH+Dg0N0OHyR3o0BA==` |
| local packed size / unpacked size | 328,319 bytes / 1,544,918 bytes |
| package artifact report | Release CI完了後に記録 |
| bootstrap inventory | n/a。`v0.3.0`で完了済み |
| release gate report schema | `2` |
| allowlist判定 | pass。225 local entries、clean PR CIでは223 entries |
| credential / local-data scan | pass |
| stable root API | runtime `runDefaultRepoKnowledgeCli`、type `RunDefaultRepoKnowledgeCliOptions` |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

local checkoutのignored `dist/`には`v0.4.0`時点から削除済みmodule 2件が残るため、local artifactは225 entriesである。
公開物の正本はclean checkoutのRelease CIで生成する。

## 8. Release CIとregistry smoke

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pending | GitHub Release公開後に記録 |
| verify release | 24 | pending | GitHub Release公開後に記録 |
| publish exact tarball（OIDC） | 24 | pending | GitHub Release公開後に記録 |
| registry smoke | 22 | pending | GitHub Release公開後に記録 |
| registry smoke | 24 | pending | GitHub Release公開後に記録 |

### npm公開後の認証境界

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| OIDC publishが対象package、repository、workflow、environmentから成功した | pending | 公開後に記録 |
| traditional npm credentialをworkflowで使用していない | pending | credential環境変数、effective npm config、`.npmrc`の検査結果を公開後に記録 |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass | repositoryとenvironmentのsecret / variableはいずれも0件 |
| npm provenanceがrelease workflowとcommitを示す | pending | 公開後に記録 |
| npm package settingsの対話監査 | not_due | 前回2026-08-24、次回期限2026-11-22。今回の事前契機なし |

## 9. Incidentと差分

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | PR #167がself-review禁止のrequired reviewで停止 | release準備PRが通常mergeされない | 全check green、Greptile 5/5、未解決thread 0件を確認し、repository adminとしてmerge | なし |
| PRE-002 | local checkoutのignored `dist/`に削除済みmodule 2件が残り、local tarballが225 entriesになった | local artifactとclean CI artifactのhashが異なる | clean checkoutで生成するRelease CI artifactだけをpublishし、registry integrityと照合する | なし |
| PRE-003 | CodeRabbitがreview rate limitに到達 | CodeRabbitの実質reviewなし | CodeQL、Node 22 / 24 CI、Greptile 5/5、未解決thread 0件で公開前review gateを判定 | なし |

## 10. Go / no-go

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go | §3 |
| Local verification | go | §4 |
| Pull Request CI Node.js 22 / 24 | go | §5 |
| M3-AC-001〜011 | pending | M3-AC-008を公開後に確定する |
| package artifact | pre-release go | local gateとclean PR CIはpass、Release CI reportはpending |
| npm publishとregistry smoke Node.js 22 / 24 | pending | §8 |
| tokenless OIDC publishing boundary | pending | baselineとcredential 0件はpass、公開後にOIDC / provenanceを確認 |
| versionの全媒体一致 | pending | sourceとtagは一致。GitHub Releaseとnpm registryは未公開 |

**総合判定: release未完了（公開前gateはgo）**

- operator: `TakehiroT`
- evidence compilation: `Codex`
- reviewer: PR #167のCI、CodeQL、Greptile、および本reportのPull Request
- 最終判断日時（UTC）: 公開後に記録
- release tracking: PR #167、本reportのPull Request、draft release `376992396`

本reportの§1〜§7をreviewしてmainへ反映し、同じfileをdraft GitHub Releaseへ添付した後にだけReleaseを公開する。
Release CI完了後は§8〜§10を実測値で更新し、main上のfileとGitHub Release assetのSHA-256を一致させる。
