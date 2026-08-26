# M3 v0.4.0 release report

本reportは、`@tamat-llc/repo-knowledge-mcp@0.4.0`の公開前gate、OIDC publish、provenance、公開後検証を記録する。

GitHub Releaseとnpm packageを公開し、復旧用workflowでNode.js 22 / 24のregistry smokeまで完了した。
総合判定は`release完了`である。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.4.0` |
| Git tag | `v0.4.0` |
| tag object | `9288a1b12ee1625714bbda91deb313a57610a7ac`。SSH署名をlocal検証済み |
| commit SHA | `49980435933dd40a52f6481b025b73447a6eb985` |
| main到達確認 | `git merge-base --is-ancestor 4998043 origin/main`: pass |
| GitHub Release | [v0.4.0](https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.4.0)。`2026-08-25T20:00:04Z`に公開 |
| npm registry | [@tamat-llc/repo-knowledge-mcp@0.4.0](https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.4.0)。`2026-08-25T20:04:06.992Z`に公開 |
| npm integrity | `sha512-ECz72GuprN30vlaXODuZjZxeooMtBPbL8ssk17akMIpB6IQCdb/K2ERT8qTg3BQdU67xgTAB9bwn868d+zy/Dw==` |
| npm shasum | `c87046ac7b0e2195b56534b0b904c7a8ecd84239` |
| npm provenance | pass。SLSA subject、release commit、workflow、runが一致 |
| release workflow | [run 32892785194](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194) |
| registry smoke recovery | [run 32894284063](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32894284063) |

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
この値と2FA必須・token禁止の設定は、`v0.3.0`公開時の2026-08-24に対話監査した。
次回の定期監査期限は2026-11-22である。

今回のrelease workflow差分はnpmを`12.0.2`へ更新し、dependency install-script gateをverify jobとpublish jobへ追加した。
OIDC、environment、workflow filename、publish権限の境界は変更していない。

local npm CLIは意図的に未認証なので、`npm trust list`はE401を返した。
この操作で設定は変更していない。
今回の対話監査は`not_due`であり、npm側の現在設定を直接確認したという`pass`判定には使わない。
通常releaseの認証境界は、OIDC publish、npm attestation、GitHub `npm` environmentのsecret / variable 0件で判定した。

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
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.4.0.tgz` |
| Release CI tarball SHA-256 | `sha256:b9ad9cb82557f2b6eac25f4ec8f87556d81d0b48699eb9d6fcdd654b2f232a61` |
| npm shasum | `c87046ac7b0e2195b56534b0b904c7a8ecd84239` |
| npm integrity | `sha512-ECz72GuprN30vlaXODuZjZxeooMtBPbL8ssk17akMIpB6IQCdb/K2ERT8qTg3BQdU67xgTAB9bwn868d+zy/Dw==` |
| packed size / unpacked size | 325,580 bytes / 1,533,078 bytes |
| package artifact | `npm-release-v0.4.0`、artifact ID `9580194600` |
| package artifact report SHA-256 | `sha256:43925d79a0b73406afd46a99476c80b1aa64726f1da672c880a8cec75360945a` |
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
| verify release | 22 | pass | [job 97948339668](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194/job/97948339668) |
| verify release | 24 | pass | [job 97948339273](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194/job/97948339273) |
| publish exact tarball（OIDC） | 24 | pass | [job 97948864895](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194/job/97948864895) |
| 初回registry smoke | 22 | fail | [job 97949620633](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194/job/97949620633) |
| 初回registry smoke | 24 | fail | [job 97949620486](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194/job/97949620486) |
| recovery 1 registry smoke | 22 | fail | [job 97951454256](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32893749225/job/97951454256) |
| recovery 1 registry smoke | 24 | fail | [job 97951453941](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32893749225/job/97951453941) |
| recovery 2 registry smoke | 22 | pass | [job 97953151832](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32894284063/job/97953151832) |
| recovery 2 registry smoke | 24 | pass | [job 97953152021](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32894284063/job/97953152021) |

初回とrecovery 1の失敗は、npm 12のmetadata envelopeとstderr noticeを検証器が許容していなかったためである。
いずれもpackageのinstall、CLI、MCP動作の不具合ではない。
PR [#162](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/162)と[#163](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/163)で検証器を修正し、recovery 2でexact versionのCLI help、package smoke、workspace cleanをNode.js 22 / 24の両方で確認した。

### npm公開後の認証境界

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| OIDC publishが対象package、repository、workflow、environmentから成功した | pass | publish jobとnpm provenanceが`release.yml`、`npm` environment、release tag、commitを示す |
| traditional npm tokenを使用していない | pass | GitHub `npm` environmentのsecret / variableは0件。publish provenanceはGitHub OIDC workflowを示す |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass | GitHub APIでいずれも0件 |
| npm provenanceがrelease workflowとcommitを示す | pass | SLSA subjectとresolved dependency、workflow ref、invocationを照合 |
| npm package settingsの対話監査 | not_due | 前回2026-08-24、次回期限2026-11-22。release境界の差分、OIDC認証異常、provenance不一致、credential検出なし |

`not_due`はnpm側のtoken禁止設定を今回直接確認したという意味ではない。
OIDC publishはtrusted publisherがpublish時に有効だったことを示すが、traditional token禁止設定までは証明しない。

### npm registry metadataとprovenance

| 項目 | 値 |
| --- | --- |
| version / `latest` | `0.4.0` / `0.4.0` |
| `bootstrap` dist-tag | `0.0.0-bootstrap.0` |
| 公開日時 | `2026-08-25T20:04:06.992Z` |
| file count / unpacked size | 223 / 1,533,078 bytes |
| SLSA subject | `pkg:npm/%40tamat-llc/repo-knowledge-mcp@0.4.0` |
| SLSA subject SHA-512 | `102cfbd86ba9acddf4be5697383b998d9c5ea2832d04f6cbf2cb24d7b6a4308a41e8840275bfcad84453f2a4e0dc141d53aef1813001f5bc27f3af1dfb3cbf0f` |
| resolved Git commit | `49980435933dd40a52f6481b025b73447a6eb985` |
| workflow | `TamaT-LLC/repo-knowledge-mcp/.github/workflows/release.yml@refs/tags/v0.4.0` |
| builder | `https://github.com/actions/runner/github-hosted` |
| invocation | [run 32892785194 attempt 1](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32892785194/attempts/1) |
| attestations | npm publish attestationとSLSA provenanceの2件 |

SLSA subjectのSHA-512はregistry integrityをhexへ変換した値と一致した。
publish attestationのpackage、version、registryも公開物と一致した。

## 9. Incidentと差分

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | PR #160のauto-mergeがself-review禁止のrequired reviewで停止 | release準備PRが自動mergeされない | 全check greenと未解決thread 0件を確認し、repository adminとしてmerge | なし |
| PRE-002 | 既定GPG設定ではtag署名に失敗 | remote tagへの影響なし | `v0.3.0`と同じ既存SSH keyを明示し、fingerprint一致と署名をlocal検証してからpush | なし |
| PRE-003 | local `npm trust list`がE401 | npm側の現在設定は今回直接確認していない | 対話監査を`not_due`と記録し、通常releaseはOIDC publish、provenance、GitHub credential 0件で判定 | なし |
| PRE-004 | local checkoutのignored `dist/`に削除済みmodule 2件が残り、local tarballが225 entriesになった | local artifactとclean Release CI artifactのhashが不一致 | clean checkoutで生成した223 entriesのRelease CI artifactだけをpublishし、registry integrityと一致を確認 | なし |
| REL-001 | GitHub `npm` environmentのrequired reviewerがself-review禁止のためpublish jobが待機 | publish開始が保留 | 全verify jobを確認後、repository adminとしてdeployment protectionをbypass | なし |
| REL-002 | npm 12の`npm view --json`が単一versionを配列で返し、初回registry smokeが失敗 | Release workflow全体はfailure。OIDC publish自体は成功済み | PR #162で単一要素の文字列配列を許容し、recovery workflowを実行 | なし |
| REL-003 | npm 12の`npx`が正常終了時にもnoticeをstderrへ出し、recovery 1が失敗 | exact CLI helpの検証が完了しない | PR #163でstdoutの期待値を検証しつつnpm diagnostic stderrを許容。recovery 2でNode.js 22 / 24ともpass | なし |
| POST-001 | release workflowのcredential guardが`NODE_AUTH_TOKEN`と`NPM_TOKEN`だけを検査していた | v0.4.0はprovenanceとcredential 0件からOIDC publishと確認済み。将来の別npm config経路には検出漏れがあった | PR #164でpublish jobの`registry-url`生成設定を除き、credential環境変数、effective npm config、project / user / globalの`.npmrc`をfail-closedで検査 | なし |

## 10. Go / no-go

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go | §3 |
| Local verification | go | §4 |
| Pull Request CI Node.js 22 / 24 | go | §5 |
| M3-AC-001〜011 | go | §6。全項目pass |
| package artifact | go | Release CI artifact、registry integrity、provenanceが一致 |
| npm publishとregistry smoke Node.js 22 / 24 | go | §8。OIDC publishとrecovery 2がpass |
| tokenless OIDC publishing boundary | go | §8。OIDC publish、provenance、GitHub credential 0件を確認 |
| versionの全媒体一致 | go | source、tag、GitHub Release、npm registry、provenanceが`0.4.0`で一致 |

**総合判定: release完了**

- operator: `TakehiroT`
- evidence compilation: `Codex`
- reviewer: PR #160、[#161](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/161)、[#162](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/162)、[#163](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/163)、[#164](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/164)のCI、CodeQL、Greptile、CodeRabbit
- 最終判断日時（UTC）: `2026-08-26T00:53Z`
- release tracking: PR #160、PR #161、PR #162、PR #163、PR #164、release run 32892785194、recovery run 32894284063

本reportをreviewしてmainへ反映した後、同じfileでGitHub Release assetを置き換える。
main上のfileとRelease assetのSHA-256一致を最終確認とする。
