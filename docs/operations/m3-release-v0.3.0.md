# M3 release report v0.3.0（公開前レビュー）

本reportは、`@tamat-llc/repo-knowledge-mcp@0.3.0`の公開前gateと、公開後に残る検証を分離して記録する。
2026-08-24T10:32:48Z時点で§1〜§7のうち公開前に実行できる検証は完了し、§8のstable publish、provenance、Node.js 22 / 24 registry smokeは未実行である。
公開前項目がreviewされるまで、ローカルtagをremoteへpushせず、GitHub Releaseも公開しない。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.3.0` |
| Git tag | `v0.3.0`（SSH署名付きannotated tag、公開前はlocal only） |
| release source commit SHA | `de9ddf035416ff4c50e873d757acc2aee3778c4b` |
| main到達確認 | `git merge-base --is-ancestor de9ddf035416ff4c50e873d757acc2aee3778c4b origin/main`: pass |
| GitHub release URL | `https://github.com/TamaT-LLC/repo-knowledge-mcp/releases/tag/v0.3.0`（予定） |
| npm registry URL | `https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.3.0`（予定） |
| local artifact integrity | `sha512-VD5n3Ox9b8ejyv7MtBxccAE2DbWStRkN6zIXYIvpu4mRcHoR+0bP+/obhNuMEJOmYudGweHE/z8kq42pjxOF5w==` |
| local artifact shasum | `8fd243c8de77b5248dcc4dd0fcde2be02b060299` |
| npm provenance | pending。Release workflowのOIDC publish後に確定する |
| release workflow run | pending |

`package.json`、予定tag、reportは`0.3.0`で一致している。
`release:verify`はstable `0.3.0`がregistryで未使用であることを確認した。

## 2. 公開前提

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| npm organizationが`tamat-llc`である | pass | `npm org ls tamat-llc takemaru --json`は`takemaru: owner`を返した |
| 初回publisherがorganization内のpublish権限と2FAを持つ | pass | `npm whoami`は`takemaru`、developers teamは対象packageへ`read-write`、WebAuthn付きpublishが成功した |
| project licenseと`package.json`のlicenseが確定している | pass | GitHub licenseはMIT、`package.json`は`MIT` |
| 空でない通常ファイルの`LICENSE`がrelease source commitに存在する | pass | `release:verify` schema 2が`license_file: LICENSE`を返した |
| GitHub repositoryがpublicである | pass | GitHub APIの`visibility`は`PUBLIC` |
| inert bootstrap packageとstable OIDC publishingの境界が確定している | pass | [npm公開方式セキュリティレビュー](./m3-npm-release-security-review-2026-08-24.md)、PR [#125](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/125) |
| bootstrap tarballの閉じたfile list、version、dist-tagがreview済みである | pass | `LICENSE`、`package.json`、`README.md`の3 entriesだけを含み、`0.0.0-bootstrap.0`を`bootstrap` tagへ公開した |
| 長期npm tokenをrepository secretに置いていない | pass | GitHub `npm` environmentのsecret 0件、variable 0件 |
| 対象versionがregistryで未使用である | pass | `release:verify`の`registry_status: available` |
| working treeがcleanである | pass | `git status --short --branch`に差分なし |
| security reviewに未解決のcriticalまたはhigh findingがない | pass | CodeQL、secret scanning、Dependabotのopen alertはいずれも0件 |

Bootstrap packageは2026-08-24T02:09:09Zにpublic registryへ公開した。
Exact bootstrap versionは「Bootstrap placeholder only」としてdeprecate済みである。
Stable公開時の`--tag latest`までは、npmが初回versionへ自動付与した`latest`もbootstrap versionを指す。

Trusted publisherは次の値で固定した。

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| repository | `TamaT-LLC/repo-knowledge-mcp` |
| workflow file | `release.yml` |
| GitHub environment | `npm` |
| permission | `npm publish` |
| trust ID | `c7c3ff7b-8cb5-4575-bcec-796f76ff7dcb` |
| npm publishing access | 2FA必須、bypass 2FA token禁止（`mfa=publish`） |

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
| M2 decision | `go`。14日運用gateと修正後ranking gateを組み合わせた判定 |
| Issue #70 / #118 | いずれもclosed |

14日pilot単体reportのranking判定はfail-closedの`no-go`だった。
その後、修正対象を限定し、共有可能なhuman evaluationとapprovalを追加した再評価reportで総合`go`を確定した。

## 4. Local verification

| 項目 | 値 |
| --- | --- |
| OS | macOS 26.3.1 (25D771280a) |
| `node --version` | `v24.19.0` |
| `npm --version` | `11.17.0` |
| 実行commit | `de9ddf035416ff4c50e873d757acc2aee3778c4b` |
| 実行日時 | 2026-08-24 UTC |

Runbookの順序どおり、dependency auditとsignature auditの後にだけlifecycle scriptを実行した。

| command | exit | report / digest | 判定 |
| --- | ---: | --- | --- |
| `npm ci --ignore-scripts` | 0 | 92 packagesを展開 | pass |
| `npm audit --audit-level=high` | 0 | vulnerability 0件 | pass |
| `npm audit signatures` | 0 | signature 92件、attestation 33件 | pass |
| `npm rebuild` | 0 | rebuild成功。npm 11.17は未承認install script 2件を警告した | pass |
| `npm run check` | 0 | docs 29 files、release tool 11 tests、74 files / 773 tests | pass |
| `npm run golden` | 0 | M1、M2 outcome ranking、provider baseline | pass |
| `npm run quality:gate` | 0 | 全10 metricsがthreshold以上 | pass |
| `npm run package:smoke` | 0 | 221 files、11 MCP tools、CLI / stdio / readiness / workspace clean | pass |
| `npm run --silent release:verify -- --tag v0.3.0 --commit de9ddf035416ff4c50e873d757acc2aee3778c4b --repository-visibility public` | 0 | schema 2、license MIT、registry available | pass |

### Security review

公開方式の判定には[2026-08-24のM3 npm公開方式セキュリティレビュー](./m3-npm-release-security-review-2026-08-24.md)を使う。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL（Actions、JavaScript、TypeScript） | pass | run [32716716895](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32716716895)、open alert 0件 |
| GitHub secret scanning | pass | open alert 0件 |
| Git historyのsecret scan | pass | GitHub secret scanningのopen alert 0件、push protection有効のbaseline review |
| dependency audit | pass | vulnerability 0件 |
| registry signature audit | pass | signature 92件、attestation 33件 |
| package artifactのcredential scan | pass | artifact gateの5 credential patternsとlocal-data path検査を通過 |
| 手動レビューしたdata、command、path、admin boundary | pass | 2026-08-13 baselineと2026-08-24 npm公開境界review |
| 残余リスクと受容者 | pass | 外部送信は既定無効のまま維持し、TakehiroTが個人利用範囲で受容 |

## 5. Pull Request CI

PR [#136](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/136)の最終head `69c8deffb1dcacd641cf6ce3995c2aad32c55490`をreviewした。
このheadとrelease source `de9ddf035416ff4c50e873d757acc2aee3778c4b`のtreeは一致する。

| Node.js | check | golden | quality gate | local-tarball package smoke | run URL |
| --- | --- | --- | --- | --- | --- |
| 22 | pass | pass | pass | pass | [CI run 32716720372](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32716720372) |
| 24 | pass | pass | pass | pass | [CI run 32716720372](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/32716720372) |

CodeQLはActionsとJavaScript / TypeScriptがpassした。
Greptileは最終commitをreviewし、confidence 5/5、blocking issueなし、未解決review thread 0件だった。

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
| M3-AC-007 | pass | review CLI real PTY E2E |
| M3-AC-008 | pending | stable registry公開後のRelease CI Node.js 22 / 24で確定する |
| M3-AC-009 | pass | M2→M3 upgrade E2E |
| M3-AC-010 | pass | CLI runtime、package smoke、upgrade E2Eのworkspace clean |
| M3-AC-011 | pass | setup / review real PTY E2EとJSON stdout purity |

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
| eligible trusted-human non-`must` candidateがactive | pass | trusted-human policy matrix |
| AI、未知bot、外部contributor、mixed trust、`must`がinboxに残る | pass | trusted-human policy matrix |
| unresolved inboxが既存active ruleを妨げない | pass | review inbox service test |
| batch reviewのapprove、reject、skip、edit、再開 | pass | review CLI real PTY E2E |
| workspaceに`.repo-knowledge/`が存在しない | pass | local package smokeとupgrade E2E |

実測検証ではAnthropic APIやAPI keyを使用していない。

## 7. Package artifact

| 項目 | 値 |
| --- | --- |
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.3.0.tgz` |
| tarball SHA-256 | `sha256:1d0094d92e906237f5efd97a2d2bf66cbe7a2f0d096dc67024b7fe841eb0d9a5` |
| package artifact report | local `package-artifact-report.json` / `sha256:39b0121d3dc91701ca25aef74dad84d8ddb8acf7155ccccd06c030264ed13200`。Release CIで同schemaのartifactを保存する |
| bootstrap inventory | `npm-bootstrap/npm-bootstrap-package.json` / `sha256:ba3f608730833e6bd26530776ef27d16847c15ab470ec82d7159d5d4d1be1518` |
| bootstrap tarball | `sha256:ff59971156257bd63f72e034e2cc41ff42b9c3b968e41739ed84602890135014` |
| release gate report schema | `2` |
| allowlist判定 | pass。221 entries |
| credential / local-data scan | pass |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

## 8. Release CIとregistry smoke

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pending | pending |
| verify release | 24 | pending | pending |
| publish exact tarball（OIDC） | 24 | pending | pending |
| registry smoke | 22 | pending | pending |
| registry smoke | 24 | pending | pending |

### npm公開後の認証固定

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| trusted publisherがpackage、repository、`release.yml`、`npm` environment、publish権限を示す | pass | `npm trust list`とnpm package settings |
| npm publishing accessが2FA必須かつtoken禁止である | pass | `npm access set mfa=publish`成功後、traditional操作がEOTPを要求 |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass | GitHub APIでいずれも0件 |
| npm provenanceがrelease workflowとcommitを示す | pending | stable OIDC publish後に確認する |

## 9. Incidentと差分

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
| PRE-001 | 初回`npm whoami`がE401 | bootstrap公開前に停止 | npm公式WebAuthn loginで`takemaru`を確認 | なし |
| PRE-002 | bootstrap公開直後、匿名registryが数分間E404 | metadata照合とdeprecateを保留 | public statusとorg表示を確認し、registry HTTP 200後にexact digestを照合 | なし |
| PRE-003 | 最初の`release:verify`が未作成tagを拒否 | release gateはfail-closedで停止 | local signed annotated tagを作成し、再実行でpass | なし |
| PRE-004 | 既定GPG設定ではtag署名に失敗 | remote tagへの影響なし | depgraphと同じ既存SSH keyを明示して署名tagを再作成 | なし |
| PRE-005 | 初回report PRのNode.js 24で、内部1秒watchdogがCI競合を失敗と判定 | stable公開を停止 | PR [#136](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/136)でtest-local watchdogを3秒にし、Node.js 22 / 24とGreptileを通してmerge | なし |
| PRE-006 | 初回artifact作成後にPR #126、#127、#129〜#136をmainへ取り込んだ | 旧commit、tag、artifactを公開対象にできない | remote未公開のlocal tagを`de9ddf0`へ付け直し、全gateとartifactを再生成 | なし |
| PRE-007 | docs-only report worktreeから`release:verify`を実行した | HEADとmain到達条件をfail-closedで拒否 | exact source `de9ddf0`のclean worktreeで再実行し、schema 2のpassを確認 | なし |

## 10. Go / no-go

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go | §3 |
| Local verification | go | §4 |
| Pull Request CI Node.js 22 / 24 | go | §5 |
| M3-AC-001〜011 | conditional go | AC-008だけを公開後確認へ保留 |
| package artifact | go | §7 |
| npm publishとregistry smoke Node.js 22 / 24 | no-go | §8がpending |
| trusted publisherとtraditional token禁止 | go | §2、§8 |
| versionの全媒体一致 | conditional go | source、tag、reportは一致。GitHub Releaseとstable registryはpending |

**総合判定: M3 release未完了（公開前gate go）**

- operator / 判断者: `TakehiroT`
- evidence compilation: `Codex`
- reviewer: 本reportのPull Requestで確定する
- 公開前判断日時（UTC）: `2026-08-24T10:32:48Z`
- Issue #93: `open`

本reportのreview後にだけtagとGitHub Releaseを公開する。
Release CIとregistry smokeが成功した後、§1、§8〜§10を実測値で更新し、main上の最終reportとGitHub Release assetのSHA-256を一致させる。
