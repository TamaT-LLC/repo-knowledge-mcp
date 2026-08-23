# M3 acceptance traceability matrix

M3 の個人利用要件を、自動テスト、CI、release workflow、運用判断へ対応付ける。

要件の正本は [repo-knowledge-mcp M3 個人利用要件](../design/repo-knowledge-mcp-v0.3-personal-use.md) とする。
本表は実装済みの検証と、公開時にだけ実行できる検証を分けて記録する。

## 検証レイヤー

| レイヤー | 実行場所 | コマンドまたは workflow | 保証範囲 |
| --- | --- | --- | --- |
| Local | 開発 checkout の現在の Node.js | `npm run check`、`npm run golden`、`npm run quality:gate`、`npm run package:smoke` | source、E2E、fixture、local tarball |
| Pull Request CI | GitHub-hosted Ubuntu の Node.js 22 / 24 | [CI workflow](../../.github/workflows/ci.yml) | Local と同じ四つの gate を対応 Node.js ごとに再実行 |
| Release CI | GitHub release tag の Node.js 22 / 24 | [release workflow](../../.github/workflows/release.yml) | tag と commit、公開 tarball、npm registry の exact version |
| Operational | 利用者のローカル環境 | 各 runbook の手順 | 14日pilotの運用証跡、修正後限定再評価、live quality、公開権限、review済み判定 |

Local tarball の成功は registry package の公開成功を意味しない。
M3 release は、Pull Request CI と Release CI の両方を通過し、公開後の registry smoke が成功した時点で成立する。

## 機能要件

| 要件 | 検証根拠 | 判定 |
| --- | --- | --- |
| M3-FR-001 個人用ローカルストア | [CLI runtime test](../../test/cli-runtime.test.ts)、[package smoke](../../scripts/package-smoke.mjs)、[M2→M3 upgrade E2E](../../test/m3-upgrade-e2e.test.ts) | automated + package gate |
| M3-FR-002 Guided setup | [setup service test](../../test/setup-service.test.ts)、[setup CLI PTY E2E](../../test/setup-cli-pty-e2e.test.ts)、[CLI runtime test](../../test/cli-runtime.test.ts)、[package smoke](../../scripts/package-smoke.mjs) | automated real-PTY E2E + package gate |
| M3-FR-003 Repository readiness | [readiness MCP E2E](../../test/readiness-mcp-e2e.test.ts)、[knowledge read service test](../../test/knowledge-read-service.test.ts) | automated process E2E |
| M3-FR-004 信頼対象の選択 | [setup service test](../../test/setup-service.test.ts)、[GitHub snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |
| M3-FR-005 安全な自動 active 化 | [trusted-human policy matrix](../../test/trusted-human-auto-activation-policy.test.ts)、[submit/finalize service test](../../test/submit-finalize-service.test.ts)、[trusted-human auto activation runbook](../operations/trusted-human-auto-activation-runbook.md) | automated + operational eligibility |
| M3-FR-006 Review inbox | [review inbox service test](../../test/review-inbox-service.test.ts) | automated |
| M3-FR-007 Batch review | [review CLI PTY E2E](../../test/review-cli-pty-e2e.test.ts)、[admin plane service test](../../test/admin-plane-service.test.ts) | automated real-PTY E2E |
| M3-FR-008 npm 配布 | [artifact gate](../../scripts/package-artifact-gate.mjs)、[package smoke](../../scripts/package-smoke.mjs)、[release gate](../../scripts/release-gate.mjs) の version・commit・visibility・license fail-closed 検査、[registry smoke](../../scripts/registry-smoke.mjs)、[npm release runbook](../operations/npm-release-runbook.md) | automated + Release CI |

## 非機能要件

| 要件 | 検証根拠 | 判定 |
| --- | --- | --- |
| M3-NFR-001 Privacy | [CLI runtime test](../../test/cli-runtime.test.ts) の送信拒否 E2E、[provider distillation test](../../test/provider-distillation-service.test.ts) の deny matrix、[host-assisted distillation test](../../test/host-assisted-distillation-service.test.ts) の明示 opt-in と diff 既定除外 | automated |
| M3-NFR-002 後方互換性 | [M2→M3 upgrade E2E](../../test/m3-upgrade-e2e.test.ts)、[MCP stdio E2E](../../test/mcp-stdio-e2e.test.ts) | automated process E2E |
| M3-NFR-003 空状態の説明 | [readiness MCP E2E](../../test/readiness-mcp-e2e.test.ts) | automated process E2E |
| M3-NFR-004 対応環境 | [CI workflow](../../.github/workflows/ci.yml) と [release workflow](../../.github/workflows/release.yml) の Node.js 22 / 24 matrix | CI + Release CI |
| M3-NFR-005 対話状態の可視性 | [terminal progress test](../../test/terminal-progress.test.ts)、[setup CLI PTY E2E](../../test/setup-cli-pty-e2e.test.ts)、[review CLI PTY E2E](../../test/review-cli-pty-e2e.test.ts) | automated unit + real-PTY E2E |

## 受け入れ条件

| ID | 受け入れ条件 | 検証根拠 | release 判定 |
| --- | --- | --- | --- |
| M3-AC-001 | 空の環境から repository を解決し、安全な config と private storage を作る | [setup service test](../../test/setup-service.test.ts)、[CLI runtime test](../../test/cli-runtime.test.ts)、[package smoke](../../scripts/package-smoke.mjs) | 実装済み |
| M3-AC-002 | 外部送信を拒否した setup は provider を呼ばず、raw review と job を保存する | [CLI runtime test](../../test/cli-runtime.test.ts)、[provider distillation test](../../test/provider-distillation-service.test.ts) | 実装済み |
| M3-AC-003 | pending job がある active rule 未作成 repository は `learning` と次の操作を返す | [readiness MCP E2E](../../test/readiness-mcp-e2e.test.ts)、[package smoke](../../scripts/package-smoke.mjs) | 実装済み |
| M3-AC-004 | active rule があって検索不一致なら `ready` と空の `rules` を返す | [readiness MCP E2E](../../test/readiness-mcp-e2e.test.ts) | 実装済み |
| M3-AC-005 | 明示 opt-in と gate 条件を満たす trusted-human non-`must` 候補だけを active 化する | [trusted-human policy matrix](../../test/trusted-human-auto-activation-policy.test.ts)、[submit/finalize service test](../../test/submit-finalize-service.test.ts) | 実装済み、運用 opt-in は pilot 後 |
| M3-AC-006 | AI、未知 bot、外部 contributor、mixed trust、`must` は proposed のままにする | [trusted-human policy matrix](../../test/trusted-human-auto-activation-policy.test.ts) | 実装済み |
| M3-AC-007 | 一つの TTY session で approve、reject、skip、edit、再開を行う | [review CLI PTY E2E](../../test/review-cli-pty-e2e.test.ts) | 実装済み |
| M3-AC-008 | Node.js 22 / 24 で exact registry package の CLI と stdio MCP を起動する | [release workflow](../../.github/workflows/release.yml) の `registry-smoke`、[registry smoke](../../scripts/registry-smoke.mjs) | v0.3 公開後に確定 |
| M3-AC-009 | M2 config、registry、knowledge の byte を変更せず既存 rule を読む | [M2→M3 upgrade E2E](../../test/m3-upgrade-e2e.test.ts) | 実装済み |
| M3-AC-010 | E2E 後も対象 workspace に `.repo-knowledge/` を作らない | [CLI runtime test](../../test/cli-runtime.test.ts)、[package smoke](../../scripts/package-smoke.mjs)、[M2→M3 upgrade E2E](../../test/m3-upgrade-e2e.test.ts) | 実装済み |
| M3-AC-011 | setup / review の長時間 phase と経過時間を実 TTY で表示し、終了時に描画を解放し、`setup --json` の stdout を JSON 1 document に保つ | [terminal progress test](../../test/terminal-progress.test.ts)、[setup CLI PTY E2E](../../test/setup-cli-pty-e2e.test.ts)、[review CLI PTY E2E](../../test/review-cli-pty-e2e.test.ts) | 実装済み |

## Cross-cutting product flow

- [readiness MCP E2E](../../test/readiness-mcp-e2e.test.ts) は `setup_required`、`learning`、`ready`、`empty` と正常な検索不一致を実 child process で検証する。
- [review inbox service test](../../test/review-inbox-service.test.ts) は unresolved inbox の読み取り前後で canonical state、projection、既存 active rule の検索結果が変わらないことを検証する。
- [CLI runtime test](../../test/cli-runtime.test.ts) は外部送信をすべて拒否した guided setup で、provider が呼ばれず raw review と distillation job がローカルへ残ることを検証する。
- [setup CLI PTY E2E](../../test/setup-cli-pty-e2e.test.ts) は prompt 前の activity 停止、二秒超の elapsed 表示、人間向け完了 summary、失敗時 cleanup、`--json` の ANSI なし単一 document を実 terminal で検証する。
- [submit/finalize service test](../../test/submit-finalize-service.test.ts) は host-assisted の明示 opt-in 後に、eligible な trusted-human rule を個別 TTY 承認なしで active 化できることを検証する。
- [package smoke](../../scripts/package-smoke.mjs) は checkout 外の clean temporary project に packed package だけを install し、guided setup、CLI help、全 11 MCP tool、`sync_repo`、`stats`、`get_rules`、stdio 純度、workspace 非汚染を検証する。

## M3 release の未自動化 gate

次の項目は source test だけでは完了にできない。

1. [pilot-002最終report](../operations/m2-cron-pilot-report-m2-cron-pilot-002.md)の14日運用gateと、[修正後限定再評価report](../operations/m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md)のranking gateをreviewし、組み合わせたM2判定を`go`としてIssue `#118`をcloseする。
2. npm package owner、license、GitHub repository の public visibility、npm trusted publisher を確定する。
3. `package.json` の version、`v<version>` tag、GitHub release、npm registry の exact version を一致させる。
4. Release CI の Node.js 22 / 24 `verify` と `registry-smoke` を成功させる。
5. [M3 release report template](../operations/m3-release-report-template.md) を実測値で埋め、reviewer の判定を残す。

これらが完了するまでは、M3 の実装 gate が green でも v0.3 release と Issue #93 を完了扱いにしない。
