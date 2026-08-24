# M3 release report（テンプレート）

M3 v0.3 を公開するときに本ファイルを複製し、`m3-release-v<version>.md` として実測値を記録する。

source checkout の結果、Pull Request CI、Release CI、npm registry の結果を混同しない。
すべての digest、URL、実行 ID は再確認できる値を残す。

main上のrelease commitとtagを確定した後、GitHub releaseをdraftのまま作成し、§1〜§7を埋めたreportをreviewする。
公開前項目がgoになった後だけdraftをpublishし、Release CI完了後に§8〜§10を実測値で更新する。
最終reportはGitHub release assetとmain上の文書で同じSHA-256になるよう固定する。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package | `@tamat-llc/repo-knowledge-mcp` |
| version | `0.3.___` |
| Git tag | `v0.3.___` |
| commit SHA | `___` |
| main 到達確認 | `git merge-base --is-ancestor <commit> origin/main`: `___` |
| GitHub release URL | `___` |
| npm registry URL | `https://www.npmjs.com/package/@tamat-llc/repo-knowledge-mcp/v/0.3.___` |
| npm integrity | `sha512-___` |
| npm provenance | `___` |
| release workflow run | `___` |

package version、tag、GitHub release、npm registry version、report の値が一致していることを確認する。

## 2. 公開前提

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| npm organizationが`tamat-llc`である | pass / fail | `___` |
| 初回publisherがorganization内のpublish権限と2FAを持つ | pass / fail | `___` |
| project license と `package.json` の license が確定している | pass / fail | `___` |
| 空でない通常ファイルの `LICENSE` / `LICENSE.md` が release commit に存在する | pass / fail | `___` |
| GitHub repository が public である | pass / fail | `___` |
| inert bootstrap packageとstable OIDC publishingの境界が確定している | pass / fail | `___` |
| bootstrap tarballの閉じたfile list、version、dist-tagがreview済みである | pass / fail / n/a | `___` |
| 長期 npm token を repository secret に置いていない | pass / fail | `___` |
| 対象 version が registry で未使用である | pass / fail | `___` |
| working tree が clean である | pass / fail | `___` |
| security review に未解決の critical または high finding がない | pass / fail | `___` |

一項目でも fail または未確認なら GitHub release を publish しない。
未作成packageにはtrusted publisherを設定できないため、初回のname reservationだけはreview済みinert bootstrap packageを2FA付きaccountから公開する。
Stable packageは初回からOIDCで公開し、GitHub secretやtraditional publish tokenを使わない。
詳細手順は [npm release runbook](./npm-release-runbook.md) に従う。

## 3. M2 release gate

| 項目 | 値 |
| --- | --- |
| 14日pilot ID | `m2-cron-pilot-002` |
| 観測期間（UTC） | `2026-08-09` 〜 `2026-08-22` |
| 14日pilot report path / URL | `___` |
| 14日pilot report SHA-256 | `sha256:___` |
| 修正後限定再評価 ID | `m2-post-fix-revalidation-001` |
| 修正後限定再評価 report path / URL | `___` |
| 修正後限定再評価 report SHA-256 | `sha256:___` |
| ranking observation path / SHA-256 | `___` / `sha256:___` |
| human evaluation path / SHA-256 | `___` / `sha256:___` |
| human approval path / SHA-256 | `___` / `sha256:___` |
| maintainer reviewers | `___` |
| M2 decision | `go / no-go` |
| Issue #118 | `closed / open` |

14日運用gateと修正後ranking gateを組み合わせた`go`、共有されたranking評価artifact、review済みreport、Issue #118 closeがそろわなければM3 releaseはno-goとする。

## 4. Local verification

実行した Node.js と npm の version を固定して記録する。

| 項目 | 値 |
| --- | --- |
| OS | `___` |
| `node --version` | `___` |
| `npm --version` | `___` |
| 実行 commit | `___` |

| command | exit | report / digest | 判定 |
| --- | ---: | --- | --- |
| `npm ci --ignore-scripts` |  | `___` | pass / fail |
| `npm audit --audit-level=high` |  | `___` | pass / fail |
| `npm audit signatures` |  | `___` | pass / fail |
| `npm rebuild` |  | `___` | pass / fail |
| `npm run check` |  | `___` | pass / fail |
| `npm run golden` |  | `___` | pass / fail |
| `npm run quality:gate` |  | `___` | pass / fail |
| `npm run package:smoke` |  | `___` | pass / fail |

### Security review

公開方式の判定には[2026-08-24のM3 npm公開方式セキュリティレビュー](./m3-npm-release-security-review-2026-08-24.md)を使う。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL（Actions、JavaScript、TypeScript） | pass / fail | `___` |
| GitHub secret scanning | pass / fail | `___` |
| Git history の secret scan | pass / fail | `___` |
| dependency audit | pass / fail | `___` |
| registry signature audit | pass / fail | `___` |
| package artifact の credential scan | pass / fail | `___` |
| 手動レビューで確認した data、command、path、admin boundary | pass / fail | `___` |
| 残余リスクと受容者 | pass / fail | `___` |

## 5. Pull Request CI

| Node.js | check | golden | quality gate | local-tarball package smoke | run URL |
| --- | --- | --- | --- | --- | --- |
| 22 | pass / fail | pass / fail | pass / fail | pass / fail | `___` |
| 24 | pass / fail | pass / fail | pass / fail | pass / fail | `___` |

Pull Request CI の package smoke は registry package の証明ではない。

## 6. M3 acceptance

判定根拠は [M3 acceptance matrix](../testing/m3-acceptance-matrix.md) の対応先を使う。

| ID | 結果 | 実行または根拠 |
| --- | --- | --- |
| M3-AC-001 | pass / fail | `___` |
| M3-AC-002 | pass / fail | `___` |
| M3-AC-003 | pass / fail | `___` |
| M3-AC-004 | pass / fail | `___` |
| M3-AC-005 | pass / fail | `___` |
| M3-AC-006 | pass / fail | `___` |
| M3-AC-007 | pass / fail | `___` |
| M3-AC-008 | pass / fail | `___` |
| M3-AC-009 | pass / fail | `___` |
| M3-AC-010 | pass / fail | `___` |
| M3-AC-011 | pass / fail | `___` |

### Readiness 記録

| 状態 | 観測した結果 | 次の操作が具体的か |
| --- | --- | --- |
| `setup_required` | `___` | yes / no |
| `learning` | `___` | yes / no |
| `ready` + match | `___` | yes / no |
| `ready` + normal mismatch | `___` | yes / no |
| `empty` | `___` | yes / no |

### Privacy と trust 記録

| 経路 | 結果 | 根拠 |
| --- | --- | --- |
| setup で provider と host-assisted を拒否し、外部送信が 0 件 | pass / fail | `___` |
| host-assisted を明示 opt-in し、diff hunk を含めず一件だけ送信 | pass / fail | `___` |
| eligible trusted-human non-`must` candidate が active | pass / fail | `___` |
| AI、未知 bot、外部 contributor、mixed trust、`must` が inbox に残る | pass / fail | `___` |
| unresolved inbox が既存 active rule を妨げない | pass / fail | `___` |
| batch review の approve、reject、skip、edit、再開 | pass / fail | `___` |
| workspace に `.repo-knowledge/` が存在しない | pass / fail | `___` |

## 7. Package artifact

| 項目 | 値 |
| --- | --- |
| tarball filename | `tamat-llc-repo-knowledge-mcp-0.3.___.tgz` |
| tarball SHA-256 | `sha256:___` |
| package artifact report | `___` |
| bootstrap inventory / SHA-256 | `___` / `sha256:___` / n/a |
| release gate report schema | `2` |
| allowlist 判定 | pass / fail |
| credential / local-data scan | pass / fail |
| CLI bin | `repo-knowledge` / `repo-knowledge-mcp` |
| MCP tool count | `11` |

## 8. Release CI と registry smoke

| job | Node.js | 結果 | run URL |
| --- | --- | --- | --- |
| verify release | 22 | pass / fail | `___` |
| verify release | 24 | pass / fail | `___` |
| publish exact tarball（OIDC） | 24 | pass / fail | `___` |
| registry smoke | 22 | pass / fail | `___` |
| registry smoke | 24 | pass / fail | `___` |

registry smoke では `npx -y @tamat-llc/repo-knowledge-mcp@<exact-version>` 相当のexact packageからCLIとstdio MCPを起動したことを記録する。

### npm公開後の認証固定

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| `npm trust list`が`@tamat-llc/repo-knowledge-mcp`、`TamaT-LLC/repo-knowledge-mcp`、`release.yml`、`npm` environment、publish権限を示す | pass / fail | `___` |
| npm publishing accessが2FA必須かつtoken禁止である | pass / fail | `___` |
| GitHub `npm` environmentにnpm credentialのsecretとvariableがない | pass / fail | `___` |
| npm provenanceがrelease workflowとcommitを示す | pass / fail | `___` |

## 9. Incident と差分

| ID | 事象 | 影響 | 対応 | follow-up Issue |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

公開前 gate の retry、公開後 smoke の失敗、手動補正をすべて記録する。

## 10. Go / no-go

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| M2 pilot gate | go / no-go | §3 |
| Local verification | go / no-go | §4 |
| Pull Request CI Node.js 22 / 24 | go / no-go | §5 |
| M3-AC-001〜011 | go / no-go | §6 |
| package artifact | go / no-go | §7 |
| npm publish と registry smoke Node.js 22 / 24 | go / no-go | §8 |
| trusted publisher とtraditional token禁止 | go / no-go | §8 |
| version の全媒体一致 | go / no-go | §1 |

**総合判定: M3 release 完了 / 未完了**

- 判断者: `___`
- reviewer: `___`
- 判断日時（UTC）: `___`
- Issue #93: `closed / open`
