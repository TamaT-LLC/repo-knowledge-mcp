# M3 v0.4.5 release report

`@tamat-llc/repo-knowledge-mcp@0.4.5` は公開準備中である。
公開前の検証と、公開後にだけ確認できる結果を分けて記録する。

## 1. Release identity

| 項目 | 値 |
| --- | --- |
| package / version | `@tamat-llc/repo-knowledge-mcp` / `0.4.5` |
| source base | `8327fa1`（main、2026-11-02） |
| planned tag | `v0.4.5` |
| release commit / main 到達確認 | 準備 PR の merge 後に確定 |
| GitHub Release / npm / provenance | 未公開 |

今回の patch は既存の CLI、MCP、stable root API の互換性を維持する。

- [#208](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/208): GitHub の server time を基準に、列挙中に更新された PR を次回へ送り、同期 checkpoint を進める。GitHub の並び順と更新日時のずれを許容する。
- [#209](https://github.com/TamaT-LLC/repo-knowledge-mcp/pull/209): macOS の launchd と Linux の cron による定期同期、処理件数上限、最終成功日時と連続失敗回数の表示を追加する。
- MCP SDK、execa、zod と開発依存を更新する。release workflow と npm 認証方式は変更しない。

## 2. 公開前提

2026-11-02 の GitHub API で repository visibility は public、license は MIT、root の LICENSE は通常ファイルであることを確認した。
exact `0.4.5` は npm registry で E404、現行 latest は `0.4.4` である。
Repository と npm environment の Actions secrets / variables はそれぞれ0件。
GitHub の secret scanning open alerts、CodeQL の open high / critical alerts、Dependabot の open high / critical alerts はそれぞれ0件だった。

`npm` environment は `TakehiroT` / `Fuelda` の承認を要求し、self-review を禁止している。
main は Node.js 22 / 24 と CodeQL の成功、未解決 thread の解消を要求する。
別の ruleset が code-owner approval と last-push approval を要求する。
既存の owner bypass は今回の依頼だけで承認されたとは扱わず、保護設定を変更しない。

npm package settings の前回対話監査は2026-08-24、次回期限は2026-11-22。
設定変更や認証異常は観測しておらず、日付上は `not_due` である。
現在の token 禁止設定を今回直接監査したという意味ではない。

## 3. M2 release gate

[14日 pilot report](./m2-cron-pilot-report-m2-cron-pilot-002.md) と [限定再評価 report](./m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md) は v0.4.4 から変更していない。
[Issue #118](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/118) は closed である。

今回の変更は同期対象の列挙と OS スケジューラの追加に及ぶため、古い pilot の成功を新機能の実運用評価と同一視しない。
全 suite、同期の cursor / failure / contention / bounded-run test、scheduler test と package smoke で影響する契約を再検証する。
canonical transaction、writer-lock、ranking、trust / approval policy は変更していない。
新しい14日 pilot と人間による ranking 評価は実施していない。
ユーザーは2026-11-02に patch release を依頼した。review と GitHub の保護条件は別途満たす。

## 4. Local verification と security

macOS、Node.js `v24.22.1`、npm `12.0.2` で検証する。
Lifecycle script を無効にして install し、install-script decision、脆弱性監査、署名監査が成功した後に rebuild を実施した。

| command | 結果 |
| --- | --- |
| `npm ci --ignore-scripts` | pass、113 packages |
| `npm run install-scripts:check` | pass、1 approved / 1 denied |
| `npm audit --audit-level=high` | pass、0 vulnerabilities |
| `npm audit signatures` | pass、113 signatures / 43 attestations |
| `npm rebuild` | pass |
| `npm run check` | pass、82 files / 1149 tests、lines 90.0% / branches 80.16% |
| `npm run golden` | pass |
| `npm run quality:gate` | pass |
| `npm run package:smoke` | pass、261 files / 11 tools / server version 0.4.5 |
| CodeRabbit（v0.4.4 からの source 差分） | 実行中 |

差分の security review は subprocess の `shell: false`、cron の shell quoting / percent escaping、plist の XML escaping、repository 名検証、storage path、同期 lock の境界を対象にした。
自動送信、trust、approval policy は変更しない。
scheduler は明示的な install でのみ動作し、Linux の crontab は自動編集しない。
GitHub secret scanning の open alert 0件は確認済みだが、独立した全 git history の追加 secret scan は未実施である。

## 5. Pull Request CI

準備 PR の exact head で Node.js 22 / 24 と CodeQL を確認する。現在は PR 作成前。
source base `8327fa1` の [CI](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/41435821002) と [CodeQL](https://github.com/TamaT-LLC/repo-knowledge-mcp/actions/runs/41435820809) は成功済み。
main の full CI を手動起動・再実行しない。

## 6. M3 acceptance

[M3 acceptance matrix](../testing/m3-acceptance-matrix.md) の M3-AC-001〜011 を full suite と package smoke で回帰検証する。
setup / doctor、privacy / trust、host-assisted、review inbox、CLI / MCP の E2E は `npm run check` に含まれる。
OS スケジューラは system adapter を差し替えた test で検証し、この release 作業で利用者の実 scheduler は変更しない。

## 7. Package artifact

local package smoke の結果は公開物そのものの証明ではない。
公開 tarball の allowlist、credential scan、integrity と registry との一致は Release CI の artifact を使って記録する。
CLI bin は `repo-knowledge` / `repo-knowledge-mcp`、MCP tools は11件である。

## 8. Release CI と registry smoke

Node.js 22 / 24 の verify release、OIDC publish、provenance と exact-version registry smoke は未実施。
公開後に workflow URL、artifact digest、npm integrity、provenance の repository / workflow / tag / commit を記録する。

## 9. Incident と差分

公開前の失敗、再実行、保護条件の例外が生じた場合はここへ追記する。
現在、保護条件の変更・bypass、main CI の手動起動は行っていない。

## 10. Go / no-go

総合判定は未完了。local gate、PR CI、review、release identity、npm environment approval、OIDC publish と registry smoke の完了後に更新する。
公開済み version / tag の再利用は行わず、問題時は [npm release runbook](./npm-release-runbook.md) の rollback 手順に従う。
