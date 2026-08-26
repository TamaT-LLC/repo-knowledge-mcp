# M3 v0.4.1 release report

本reportは、`@tamat-llc/repo-knowledge-mcp@0.4.1`の公開前gate、OIDC publish、provenance、公開後検証を記録する。

GitHub Releaseとnpm packageを公開し、Release CIでNode.js 22 / 24のregistry smokeまで完了した。
総合判定は`release完了`である。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.4.1` |
| Git tag | `v0.4.1` |
| tag object | `ca04561aaea3e8f21c6d8394fbcf1203dbb34658`。SSH署名をlocal検証済み |
| commit SHA | `53bed87d07999c84cbe565c224dd4ea28853e036` |
| main到達確認 | `git merge-base --is-ancestor 53bed87 origin/main`: pass |
| GitHub Release | [v0.4.1](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.1)。`2026-08-26T08:54:35Z`に公開 |
| npm registry | [@tamat-llc/repo-knowledge-mcp@0.4.1](https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.1)。`2026-08-26T08:59:11.416Z`に公開 |
| npm integrity | `sha512-gJzQ23yKfHQI8N4V/tDo546XOzI5E8qYl1qmp3qCZ2nj+GnrjL26/zl5uqsxMxXMmWvpaL1f/PiEeV1xz2RqXQ==` |
| npm shasum | `85b3e38e029d9ab7b9dbe8b22a96a393f4229055` |
| npm provenance | pass。SLSA subject、release commit、workflow、runが一致 |
| release workflow | [run 32950191790](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790) |

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
| M3-AC-008 | pass | 公開済みexact versionのNode.js 22 / 24 registry smoke |
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
| Release CI tarball SHA-256 | `sha256:6696b1904665895db9919b0dc0864bc3fd50ada0289c99a1a6b4ce09ee60bf43` |
| npm shasum | `85b3e38e029d9ab7b9dbe8b22a96a393f4229055` |
| npm integrity | `sha512-gJzQ23yKfHQI8N4V/tDo546XOzI5E8qYl1qmp3qCZ2nj+GnrjL26/zl5uqsxMxXMmWvpaL1f/PiEeV1xz2RqXQ==` |
| packed size / unpacked size | 326,196 bytes / 1,535,476 bytes |
| package artifact | `npm-release-v0.4.1`、artifact ID `9599956897` |
| package artifact report SHA-256 | `sha256:86f58facb974a626b1fb66ee645729997936a9ebe04e85921dbc979fd66c05be` |
| bootstrap inventory | n/a。`v0.3.0`で完了済み |
| release gate report schema | `2` |
| allowlist判定 | pass。`dist-js-dts-plus-explicit-root-files-v3`、223 entries |
| credential / local-data scan | pass |
| stable root API | runtime `runDefaultRepoKnowledgeCli`、type `RunDefaultRepoKnowledgeCliOptions` |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

Release CIが生成したtarballのintegrityとshasumはnpm registryの値と一致した。
公開物の正本はclean checkoutで生成した223 entriesのRelease CI artifactである。
local pre-release tarballとの差分は§9に記録する。

## 8. Release CIとregistry smoke

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pass | [job 98119640892](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790/job/98119640892) |
| verify release | 24 | pass | [job 98119640656](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790/job/98119640656) |
| publish exact tarball（OIDC） | 24 | pass | [job 98120097729](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790/job/98120097729) |
| registry smoke | 22 | pass | [job 98120855180](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790/job/98120855180) |
| registry smoke | 24 | pass | [job 98120855249](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790/job/98120855249) |

### npm公開後の認証境界

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| OIDC publishが対象package、repository、workflow、environmentから成功した | pass | publish jobとnpm provenanceが`release.yml`、`npm` environment、release tag、commitを示す |
| traditional npm credentialをworkflowで使用していない | pass | credential環境変数、effective npm config、project / user / global `.npmrc`のfail-closed検査を通過 |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass | repositoryとenvironmentのsecret / variableはいずれも0件 |
| npm provenanceがrelease workflowとcommitを示す | pass | SLSA subject、tag、resolved commit、workflow、runを照合 |
| npm package settingsの対話監査 | not_due | 前回2026-08-24、次回期限2026-11-22。release境界の異常、provenance不一致、credential検出なし |

`not_due`はnpm側のtoken禁止設定を今回直接確認したという意味ではない。
OIDC publishはtrusted publisherがpublish時に有効だったことを示すが、traditional token禁止設定までは証明しない。

### npm registry metadataとprovenance

| 項目 | 値 |
| --- | --- |
| version / `latest` | `0.4.1` / `0.4.1` |
| `bootstrap` dist-tag | `0.0.0-bootstrap.0` |
| 公開日時 | `2026-08-26T08:59:11.416Z` |
| file count / unpacked size | 223 / 1,535,476 bytes |
| SLSA subject | `pkg:npm/%40tamat-llc/repo-knowledge-mcp@0.4.1` |
| SLSA subject SHA-512 | `809cd0db7c8a7c7408f0de15fed0e8e78e973b323913ca98975aa6a77a826769e3f869eb8cbdbaff3979baab313315cc996be968bd5ffcf884795d71cf646a5d` |
| resolved Git commit | `53bed87d07999c84cbe565c224dd4ea28853e036` |
| workflow | `TamaT-LLC/repo-knowledge-mcp/.github/workflows/release.yml@refs/tags/v0.4.1` |
| builder | `https://github.com/actions/runner/github-hosted` |
| invocation | [run 32950191790 attempt 1](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32950191790/attempts/1) |
| attestations | npm publish attestationとSLSA provenanceの2件 |

SLSA subjectのSHA-512はregistry integrityをhexへ変換した値と一致した。
publish attestationのpackage、version、registryも公開物と一致した。

## 9. Incidentと差分

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | PR #167がself-review禁止のrequired reviewで停止 | release準備PRが通常mergeされない | 全check green、Greptile 5/5、未解決thread 0件を確認し、repository adminとしてmerge | なし |
| PRE-002 | local checkoutのignored `dist/`に削除済みmodule 2件が残り、local tarballが225 entriesになった | local artifactとclean CI artifactのhashが異なる | clean checkoutで生成するRelease CI artifactだけをpublishし、registry integrityと照合する | なし |
| PRE-003 | CodeRabbitがreview rate limitに到達 | CodeRabbitの実質reviewなし | CodeQL、Node 22 / 24 CI、Greptile 5/5、未解決thread 0件で公開前review gateを判定 | なし |
| REL-001 | GitHub `npm` environmentのrequired reviewerがself-review禁止のためpublish jobが待機 | publish開始が保留 | 全verify jobを確認後、repository adminとしてdeployment protectionをbypass | なし |

## 10. Go / no-go

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go | §3 |
| Local verification | go | §4 |
| Pull Request CI Node.js 22 / 24 | go | §5 |
| M3-AC-001〜011 | go | §6。全項目pass |
| package artifact | go | Release CI artifact、registry integrity、provenanceが一致 |
| npm publishとregistry smoke Node.js 22 / 24 | go | §8。OIDC publishと両runtimeのsmokeがpass |
| tokenless OIDC publishing boundary | go | §8。OIDC publish、provenance、credential 0件、credential guardを確認 |
| versionの全媒体一致 | go | source、tag、GitHub Release、npm registry、provenanceが`0.4.1`で一致 |

**総合判定: release完了**

- operator: `TakehiroT`
- evidence compilation: `Codex`
- reviewer: PR [#167](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/167)、[#168](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/168)、本reportのPull RequestのCI、CodeQL、Greptile
- 最終判断日時（UTC）: `2026-08-26T09:01Z`
- release tracking: PR #167、PR #168、本reportのPull Request、release run 32950191790

本reportをreviewしてmainへ反映した後、同じfileでGitHub Release assetを置き換える。
main上のfileとRelease assetのSHA-256一致を最終確認とする。
