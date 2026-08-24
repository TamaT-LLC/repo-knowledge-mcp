# M3 npm公開方式セキュリティレビュー（2026-08-24）

## 判定

`@tamat-llc/repo-knowledge-mcp`へのscope変更と初回公開方式の差分レビューは条件付きpassとする。

Pull Request #125の最終headでNode.js 22と24のCI、CodeQL、review threadがすべてgreenになるまでmergeしない。
Merge後もinert bootstrap package、trusted publisher、traditional token禁止を実測できるまでは`v0.3.0`を公開しない。

## レビュー範囲

本レビューは、[2026-08-13のM3公開前セキュリティレビュー](./m3-prepublish-security-review-2026-08-13.md)をbaselineとし、2026-08-24に変更したnpm公開境界だけを対象にする。
Runtime、canonical storage、GitHub review取得、provider、host-assisted MCPの実装は変更していないため、これらにはbaselineの判定を適用する。

差分レビューの対象は次のとおりである。

- npm package名と`publishConfig`
- inert bootstrap package生成器とrelease tool test
- GitHub Actionsのrelease publish job
- stable packageのartifact gate、registry smoke、release gate
- README、M3要件、acceptance matrix、release report、release runbook

## 公開境界

npm organizationは`tamat-llc`、公開package名は`@tamat-llc/repo-knowledge-mcp`とする。
初回publisher accountは、organization内のpublish権限と2FAを対話セッションで確認したaccountに限定する。

未作成packageにはtrusted publisherを設定できないため、`0.0.0-bootstrap.0`でpackage名だけを確保する。
Bootstrap tarballは`package.json`、`README.md`、`LICENSE`の3ファイルだけを含み、実行コード、lifecycle script、dependencyを持たない。

Stable `0.3.0`はGitHub-hosted runnerからOIDCで公開する。
Release workflowは`NPM_TOKEN`と`NODE_AUTH_TOKEN`を拒否し、GitHub `npm` environmentへtraditional npm credentialを登録しない。

## 脅威と対策

| 脅威 | 対策 | 検証 |
| --- | --- | --- |
| bootstrap credentialがrepository、log、artifactへ残る | bootstrapをGitHub Actionsから分離し、2FA付きaccountで対話的に実行する | workflowとstatic testがnpm secret参照を拒否 |
| bootstrap packageへ実行コードやdependencyが混入する | manifestとtarball closureを3ファイルへ固定する | release tool testと実tarball listing |
| 出力先pathを外部入力で変更される | bootstrap CLIは引数を受け付けず、repository直下の`npm-bootstrap/`へ固定する | CodeQL finding 3件の修正後analysis |
| typo packageや別scopeを公開する | artifact gate、release gate、registry smokeが`@tamat-llc/repo-knowledge-mcp`だけを許可する | release tool testとpackage smoke |
| bootstrap placeholderをsupported releaseとして実行する | `bin`を定義せず、`bootstrap` dist-tagへ公開し、exact versionをdeprecateする | bootstrap inventoryと公開後のregistry確認 |
| stable publishへtraditional tokenが混入する | publish jobはOIDCの`id-token: write`だけを取得し、traditional credentialを実行前に拒否する | workflow static testとGitHub environment secret監査 |
| trusted publisherが別repositoryやworkflowを許可する | repository、`release.yml`、`npm` environment、`npm publish`権限を固定する | `npm trust list`の公開前確認 |
| sourceと公開tarballがずれる | dry-runと実tarballのfile list、integrity、shasumを照合し、exact tarballだけをpublishする | package artifact gateとregistry smoke |

## 2026-08-24の検証結果

| 検査 | 結果 | 根拠 |
| --- | --- | --- |
| format、lint、typecheck | pass | `npm run format:check`、`npm run lint`、`npm run typecheck` |
| release tool test | pass | 11 tests |
| full test suite | pass | 74 files、772 tests |
| bootstrap artifact | pass | `LICENSE`、`package.json`、`README.md`の3 entries |
| stable package smoke | pass | 183 files、11 MCP tools、workspace非汚染 |
| golden evaluation | pass | M1、M2 outcome ranking、provider baseline |
| quality gate | pass | 全metricがthreshold以上 |
| dependency audit | pass | vulnerability 0件 |
| registry signature audit | pass | signature 173件、attestation 55件 |
| CodeQL remediation | pass | 任意output pathを削除後、run `32680768680`のActionsとJavaScript / TypeScriptが成功し、open alert 0件 |

## 残余作業

ローカルnpm CLIは未認証であり、`@tamat-llc/repo-knowledge-mcp`も未作成である。
この状態はpackage名、organization membership、publish権限を確保した証明にはならない。

初回公開者は[release runbook](./npm-release-runbook.md)に従い、同じ明示セッションで次を完了する。

1. `npm whoami`、2FA、`tamat-llc` organizationのwrite権限を確認する。
2. review済みbootstrap tarballだけを`bootstrap` dist-tagへ公開し、deprecateする。
3. `release.yml`とGitHub `npm` environmentへtrusted publisherを固定する。
4. npm publishing accessでtraditional tokenを禁止する。
5. OIDCからstable `0.3.0`を公開し、Node.js 22と24のregistry smokeとprovenanceを確認する。

上記のいずれかを確認できない場合、M3 releaseはno-goとする。
