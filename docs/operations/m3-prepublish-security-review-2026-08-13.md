# M3 公開前セキュリティレビュー（2026-08-13）

## 判定

現在の作業ツリーに対する修正後レビューは条件付き pass とする。

npm 公開は、修正 commit を GitHub 上の CodeQL で再検査し、未解決の critical / high finding が 0 件になるまで no-go とする。
M2 pilot の go 判定、Issue #70 の close、Pull Request CI、release gate も別途必要であり、このレビューだけでは公開を許可しない。

## 対象

- package source、CLI、MCP server、admin plane
- knowledge Markdown と YAML frontmatter の parse / serialize 経路
- GitHub review、provider、host-assisted の data transmission 経路
- repository registry、canonical storage、path / symlink boundary
- npm dependency、lifecycle script、registry signature、package artifact
- GitHub Actions の CI / release workflow と権限設定

対象 version は `0.3.0` である。
レビュー対象は 2026-08-13 時点の未 commit の作業ツリーであり、公開済み artifact ではない。

## 実行結果

| 検査 | 結果 | 根拠 |
| --- | --- | --- |
| CodeQL CLI | pass | CodeQL `2.26.3`、JavaScript / TypeScript `security-extended`、`remote_and_local` threat model で修正対象 4 rule / 8 findings が 0 件 |
| GitHub CodeQL default setup | configured | Actions、JavaScript、TypeScript、extended query suite、`remote_and_local` threat model |
| GitHub secret scanning | pass | open alert 0 件、push protection 有効 |
| Dependabot | pass | open alert 0 件、security updates 有効 |
| dependency audit | pass | `npm audit --audit-level=high` で vulnerability 0 件 |
| registry signature audit | pass | `npm audit signatures` で signature 173 件、attestation 55 件を検証し、invalid / missing 0 件 |
| test / static gate | pass | `npm run check`、742 tests、release tool tests 8 件が成功 |
| package artifact | pass | allowlist と credential pattern scan を release gate に組み込み、`LICENSE` を必須化 |
| 手動 boundary review | pass | data、command、path、provider、MCP / admin boundary を確認 |

ローカル CodeQL の残り 59 件は、path injection 51 件、file-system race 6 件、user-controlled bypass 2 件である。
これらは operator が指定する local storage root、同一 OS user の診断処理、評価専用 CLI に対応し、文書化済みの security boundary の外側またはテスト用途である。
GitHub 上では根拠コメントを付け、false positive、won't fix、used in tests として 59 件を triage 済みである。

## 修正した finding

### SEC-001: YAML frontmatter からの任意コード実行

重要度は critical である。
`gray-matter` は入力の `---javascript` language suffix により JavaScript engine を選択でき、knowledge Markdown を読み込むだけで任意コードを実行し得た。

`gray-matter` を production dependency と parse 経路から削除した。
frontmatter は完全一致する `---` delimiter だけを受け付け、`yaml.parseDocument` で parse する実装へ変更した。
JavaScript language suffix、実行 payload、未終端 frontmatter の regression test を追加した。

### SEC-002: registry smoke の resource exhaustion

重要度は high である。
registry 待機 interval を CLI 入力から指定でき、長時間 timer を生成できた。

retry interval を 10 秒の固定値に変更した。
attempts は 1 から 60 の範囲に制限し、programmatic request と CLI parse の両方で検証する。

### SEC-003: code example parser の polynomial ReDoS

重要度は high で、5 件を検出した。
quoted string、module specifier、末尾 punctuation の抽出に、多項式時間となり得る正規表現があった。

該当処理を一方向に走査する parser と `trimEnd` に置き換えた。
escaped delimiter は同じ quoted string の一部として走査し、正当な specifier を複数の token に分割しない regression test を追加した。
CodeQL の `js/polynomial-redos` は修正後に 0 件となった。

### SEC-004: repository registry の remote property injection

重要度は high である。
外部入力由来の repository ID を通常 object の動的 property として扱い、prototype property を誤って解決する可能性があった。

registry と canonical normalization は `Object.fromEntries` と null-prototype の空 object を使うよう変更した。
registry の ID lookup は own entry の列挙結果だけを参照し、非空 registry でも継承 property に到達しない。
`toString` と `__proto__` を ID / key に含む regression test を追加した。

### SEC-005: provider redirect 時の credential 転送

手動レビューで防御強化項目として検出した。
Anthropic endpoint が redirect を返した場合に、API key と request body が別 endpoint へ転送される余地をなくす必要があった。

provider request は redirect を拒否し、credential を含む endpoint URL も拒否する。
HTTPS endpoint の既存制約と合わせて test を追加した。

## Supply-chain と release workflow

CI と release workflow は `npm ci --ignore-scripts` の後に dependency audit と registry signature audit を実行し、その後だけ `npm rebuild` で lifecycle script を許可する。
README、smoke runbook、release report も同じ順序に統一し、ローカル検証が audit 前に lifecycle script を実行しないようにする。
GitHub Actions は full commit SHA で pin し、release publish job は npm environment と OIDC の `id-token: write` に限定する。
npm environment は tag `v*` だけを許可し、TakehiroT または Fuelda の reviewer approval を必要とし、self review を禁止する。
repository secret に長期 npm token を置かない構成とする。

## 残余リスク

### 外部送信前の secret scan

通常の provider / host-assisted 経路には、review 本文や diff に対する送信前 secret scanner がない。
両経路は既定で無効であり、独立した opt-in を必要とするが、機密 repository では無効のまま運用する。
この制約は [Security policy](../../SECURITY.md) に明記済みである。

### Local security boundary

同一 OS user として shell、storage、admin CLI にアクセスできる process は防御対象外である。
信頼できない MCP client や agent へ shell と admin CLI の権限を与えない。

### Direct Markdown edit

外部 editor は writer lock を取得しないため、短い canonical commit 区間との完全な atomic CAS は保証しない。
CLI、MCP ingest、reindex、recovery と直接編集を同時実行しない。

### Branch governance

`main` に branch protection / ruleset がないため、review と status check を経由しない直接 push を GitHub 設定上は拒否できない。
npm publish 自体は environment reviewer で保護されるが、release source の完全性を高めるため、公開前に branch ruleset を設定することを推奨する。

2026-08-14に、この指摘へのremediationとして`Protect main` ruleset（ID `20803864`）と`Require code owner review` ruleset（ID `20804041`）をactiveにした。
前者はPull Request、review thread解決、Node.js 22と24のCI、ActionsとJavaScript向けCodeQL、strict status checkを必須とし、削除とforce pushを禁止する。
後者は1件のCode Owner review、stale review取消、last push approvalを必須とする。
`TakehiroT`にはPull Request経由のbypassがあるが、Renovate Appを含むGitHub Appにはbypassを設定していない。

## GitHub 上の未解決 alert

2026-08-13 時点の GitHub CodeQL には、修正前の `main` に対する critical 1 件と high 7 件が open のまま残っている。
内訳は code injection 1 件、resource exhaustion 1 件、polynomial ReDoS 5 件、remote property injection 1 件である。
これらを「修正済み」として手動 dismiss せず、修正 commit の GitHub CodeQL が閉じることを release gate とする。

2026-08-14にCodeQLのopen alertが0件であることをGitHub APIで確認し、このrelease gateを通過した。

## 公開許可条件

次をすべて満たすまで npm publish、Git tag、GitHub Release を実行しない。

1. 本レビューの修正を commit し、Pull Request CI の Node.js 22 / 24 が成功する。
2. GitHub CodeQL が修正 commit を解析し、critical / high の open alert が 0 件になる。
3. GitHub secret scanning と Dependabot の open alert が 0 件である。
4. `npm audit --audit-level=high` と `npm audit signatures` が成功する。
5. `npm run check`、`npm run golden`、`npm run quality:gate`、`npm run package:smoke` が成功する。
6. M2 pilot が go で終了し、review 済み report と Issue #70 close がそろう。
7. release gate が version、commit、tag、license、repository visibility、registry availability を fail-closed で確認する。
8. 初回 publish 後に npm trusted publisher を設定し、provenance と exact-version registry smoke を確認する。
