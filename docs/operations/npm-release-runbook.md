# npm release runbook

本 runbook は、`@tamat-llc/repo-knowledge-mcp` を public npm package として公開するための準備、実行、検証、rollback を定義する。

通常の公開は GitHub Actions と npm trusted publishing を使い、長期 npm credential を repository secret に保存しない。

各 stable release の実測値と公開後の完了判定は`m3-release-v<version>.md`へ記録する。
完了済みの基準記録は[M3 v0.3.0 release report](./m3-release-v0.3.0.md)である。

公開境界の差分レビューは[2026-08-24のM3 npm公開方式セキュリティレビュー](./m3-npm-release-security-review-2026-08-24.md)を正本とする。

## 1. 公開契約

| 項目 | 契約 |
| --- | --- |
| package 名 | `@tamat-llc/repo-knowledge-mcp` |
| npm organization | `tamat-llc` |
| registry | `https://registry.npmjs.org/` |
| access | public |
| version | prerelease suffix のない SemVer |
| tag | package version に `v` を付けた値 |
| release branch | tag の commit が `origin/main` に含まれること |
| repository visibility | public |
| 対応 Node.js | 22、24 |
| publish runtime | Node.js 24、npm 11.5.1 以上 |
| 通常認証 | GitHub Actions OIDC による npm trusted publishing |
| provenance | trusted publishing と `npm publish --provenance` で生成 |

2026-08-26 時点の `v0.4.0` 公開準備状況は次のとおりである。

| 項目 | 状態 |
| --- | --- |
| npm registry | `@tamat-llc/repo-knowledge-mcp@0.3.0` を`latest`として公開済み |
| npm package owner | npm organization `tamat-llc`。GitHub Actions trusted publisherを設定済み |
| local npm認証 | stable releaseでは使用せず、GitHub Actions OIDCだけを使う |
| GitHub repository | public |
| package version | `0.4.0` |
| license | `package.json` はMIT、rootに`LICENSE`あり |
| GitHub `npm` environment | required reviewer、self-review禁止、`v*` tag deployment policyを設定済み |
| `main` protection | Pull Request、owner review、Node.js 22と24のCI、CodeQLを必須化済み |
| version tag protection | `v*`の更新と削除を禁止済み |
| release artifact | `v0.3.0`は完了済み。`v0.4.0`のtag、GitHub Release、npm packageは未作成 |
| M2 release gate | pilot-002の14日運用gateと修正後のranking human評価を組み合わせてgo。Issue `#118`はclosed |
| bootstrap設定 | `0.0.0-bootstrap.0`を公開、deprecate済み。stable releaseはOIDC trusted publishingを使用 |

初回 bootstrap は完了している。
以後の stable release では、trusted publisher、2FAとtoken禁止、public accessを公開前に再確認する。

## 2. trusted publishing の設定

初回 package 作成後、初回公開者はnpm package settingsのtrusted publisherを次の値で設定する。

| npm 設定項目 | 値 |
| --- | --- |
| provider | GitHub Actions |
| organization or user | `TamaT-LLC` |
| repository | `repo-knowledge-mcp` |
| workflow filename | `release.yml` |
| environment | `npm` |
| allowed actions | `npm publish` |

GitHub repositoryの`npm` environmentには、`TakehiroT`と`Fuelda`をrequired reviewerとして登録している。
Self-reviewを禁止し、deployment branch policyは`v*` tagだけを許可する。
Repository rulesetは`v*` tagの作成後の更新と削除を禁止する。

workflow は `id-token: write` を publish job だけに付与し、GitHub-hosted runner で実行する。

通常運用では `NODE_AUTH_TOKEN`、`NPM_TOKEN`、`.npmrc` の auth token を設定しない。

trusted publisher の動作確認後は、npm の publishing access を `Require two-factor authentication and disallow tokens` に設定する。

初回 package 作成後は npm CLI 12.0.2 以降の `npm trust` で同じ設定を作成して監査する。
実行する account が package owner または trusted publisher を管理できる maintainer であることを確認し、workflow filename には path ではなく basename だけを渡す。

```console
npm trust github @tamat-llc/repo-knowledge-mcp \
  --repository TamaT-LLC/repo-knowledge-mcp \
  --file release.yml \
  --environment npm \
  --allow-publish \
  --yes
npm trust list @tamat-llc/repo-knowledge-mcp --json
```

GitHub environment の required reviewer と deployment branch policy は GitHub plan で利用可能な場合に設定する。
設定 API が plan 制約で拒否された場合も空の `npm` environment を release 承認の代替として扱わず、repository の public 化または plan 変更後に protection rule を再設定してから公開する。

trusted publishing の要件は [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) を参照する。

provenance の検証方法は [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/) を参照する。

## 3. 初回公開の bootstrap（完了済み）

npm は既存 package に対して trusted publisher を設定するため、未作成 package の初回公開だけは OIDC 設定より先に実施する必要がある。

初回公開担当者は npm account の 2FA を有効にし、`tamat-llc` organization内のpublish権限を確認する。
bootstrapでは実行コードを含む`0.3.0`を直接公開せず、`0.0.0-bootstrap.0`の無害なplaceholderでpackage名だけを確保する。
placeholderに含めるのは`package.json`、`README.md`、`LICENSE`だけであり、`bin`、lifecycle script、dependencyは定義しない。

最初にbootstrap tarballとSHA-256付きinventoryを生成し、閉じたfile listとmetadataをreviewする。
出力directoryがすでに存在する場合、生成器は上書きせずに失敗する。

```console
npm run bootstrap:pack
jq . npm-bootstrap/npm-bootstrap-package.json
tar -tzf npm-bootstrap/tamat-llc-repo-knowledge-mcp-0.0.0-bootstrap.0.tgz
```

次に、2FA付きのorganization member accountで対話認証する。
`npm whoami`の値はaccount名であり、scope ownerの`tamat-llc`とは別の値になる。

```console
npm login
npm whoami
npm access list packages tamat-llc:developers
```

`@tamat-llc/repo-knowledge-mcp`へのwrite権限を確認した後、固定したnpm CLIでplaceholderだけを`bootstrap` dist-tagへ公開する。

```console
npx --yes npm@12.0.2 publish \
  ./npm-bootstrap/tamat-llc-repo-knowledge-mcp-0.0.0-bootstrap.0.tgz \
  --access public \
  --tag bootstrap
npm view @tamat-llc/repo-knowledge-mcp@0.0.0-bootstrap.0 \
  name version dist-tags repository.url --json
```

npm registryが初回versionへ`latest`を自動付与しても、bootstrap versionをunpublishしない。
exact bootstrap versionを直ちにdeprecateし、stable `0.3.0`の公開時にrelease workflowの`--tag latest`でdist-tagを移す。

```console
npx --yes npm@12.0.2 deprecate \
  '@tamat-llc/repo-knowledge-mcp@0.0.0-bootstrap.0' \
  'Bootstrap placeholder only; install a supported stable version after it is published.'
```

placeholderの公開直後にtrusted publisherを設定する。

```console
npx --yes npm@12.0.2 trust github @tamat-llc/repo-knowledge-mcp \
  --repository TamaT-LLC/repo-knowledge-mcp \
  --file release.yml \
  --environment npm \
  --allow-publish \
  --yes
npx --yes npm@12.0.2 trust list @tamat-llc/repo-knowledge-mcp --json
```

その後、npm package settingsでtraditional token publicationを禁止する。
GitHub `npm` environmentには`NPM_TOKEN`、`NODE_AUTH_TOKEN`、bootstrap用のsecretやvariableを登録しない。
bootstrapとtrusted publisher設定後、stable `0.3.0`を通常のrelease workflowから公開した。
この手順を後続のstable releaseで繰り返さない。

## 4. release 前提条件

次の条件をすべて満たすまで tag と GitHub release を公開しない。

1. package version と予定 tag が一致している。
2. 対象 commit が main に merge 済みで、working tree が clean である。
3. 同じ exact version が npm registry に存在しない。
4. Node.js 22 と 24 の CI が成功している。
5. `npm run check`、`npm run golden`、`npm run quality:gate`、`npm run package:smoke` が成功している。
6. M3 releaseでは、pilot-002の14日運用gateと修正後限定再評価のranking gateを組み合わせたM2 go判定、および共有されたobservation、human evaluation、human approvalがreview済みである。
7. Issue `#118`がclosedであり、closeしたPull Request、M2 report、共有artifactの判定が一致している。
8. M3 acceptance reportがreview済みである。
9. GitHub repositoryがpublicで、npm organization、license、GitHub `npm` environmentが確認済みである。
   初回公開ではinert bootstrap package、organization memberのpublish権限、trusted publisherをreviewし、二回目以降はtrusted publisherを再確認する。
10. 公開対象 commit の security review が完了し、CodeQL、secret scanning、依存関係監査に未解決の critical または high finding がない。

version、tag、commit、working tree、Node.js、npm、registry の重複、repository visibility、`package.json` の明示 license、空でない通常ファイルの `LICENSE` / `LICENSE.md` は `release:verify` が fail-closed で検査する。

```console
RELEASE_VERSION=0.4.0
RELEASE_COMMIT="$(git rev-parse HEAD)"
npm ci --ignore-scripts
npm run install-scripts:check
npm audit --audit-level=high
npm audit signatures
npm rebuild
npm run check
npm run golden
npm run quality:gate
npm run package:smoke
npm run --silent release:verify -- \
  --tag "v${RELEASE_VERSION}" \
  --commit "${RELEASE_COMMIT}" \
  --repository-visibility public
```

この順序を入れ替えてはならない。
lifecycle script を実行する `npm rebuild` は dependency と registry signature の検証後にだけ実行する。
`package.json` の `allowScripts` は、review 済みの `better-sqlite3` を exact version で許可し、任意依存の `fsevents` を明示的に拒否する。
dependency 更新で install script の対象が変わった場合は、script と package 内容を再確認して decision を更新し、`install-scripts:check` を通す。

## 5. 公開手順

次の手順は初回bootstrapとtrusted publisher設定後の通常公開に共通して使用する。
初回もGitHub secretやtraditional tokenを使わない。

1. main の検証済み commit に annotated tag を作成して push する。
2. 同じ tag を指定した draft GitHub release に、review 済み release report を添付する。
3. draft を publish して `Release npm package` workflow を開始する。
   すべてのstable releaseはOIDC trusted publishingだけを使う。
4. `verify release` と `registry smoke` の Node.js 22 と 24、および `publish exact tarball` が成功するまで release 完了としない。

workflow の verify job は exact tag を checkout し、source check、golden、quality gate、package smoke を Node.js 22 と 24 で再実行する。

CI、verify job、publish job は npm 12 を固定し、lifecycle script を無効にして依存関係を展開する。
install script の全対象に明示的な許可または拒否があること、`npm audit --audit-level=high`、`npm audit signatures` を順に通過してから、`npm rebuild` で許可済み dependency の lifecycle script だけを実行する。
既知の high または critical vulnerability、改ざんまたは署名欠落を検出した release は publish job へ進めない。

publish job は `npm pack --dry-run --json` と実 tarball の manifest、integrity、shasum が一致することを検査する。

publish jobはinert bootstrap versionのpackage名、version、repositoryもregistryから再確認し、不一致ならOIDC publishへ進まない。

allowlist 外の file、`.repo-knowledge/`、fixture、local store、database、credential 形式を含む tarball は公開前に拒否する。

clean temporary project へ exact tarball を install し、guided setup help、review help、`get_rules` readiness、stdio MCP server を検証する。

この smoke の対象 workspace に `.repo-knowledge/` が作成されないことも検査する。

publish 後は registry 反映を待ち、exact version の `npm exec` と同じ package smoke を新しい npm cache で実行する。

## 6. 公開後の確認

workflow の artifact から `package-artifact-report.json` を取得し、release report の name、version、commit、tarball integrity と照合する。

手元で再確認する場合も `latest` を使わず exact version を指定する。

```console
RELEASE_VERSION=0.4.0
npx --yes --package="@tamat-llc/repo-knowledge-mcp@${RELEASE_VERSION}" -- repo-knowledge --help
npm run --silent registry:smoke -- \
  --name @tamat-llc/repo-knowledge-mcp \
  --version "${RELEASE_VERSION}"
```

npm package page の provenance が対象 GitHub repository、workflow、commit を指していることを確認する。

## 7. 失敗時と rollback

npm の公開済み version と Git tag は再利用しない。

公開前に失敗した場合は原因を修正し、新しい commit と version で release をやり直す。

publish 後の registry smoke が失敗した場合は、package page と exact version を確認し、GitHub release に障害状態を明記する。

利用させてはいけない version は、2FA 付きの対話認証で次のように deprecate する。

```console
: "${BAD_VERSION:?set BAD_VERSION to the exact version to deprecate}"
npm deprecate "@tamat-llc/repo-knowledge-mcp@${BAD_VERSION}" "Do not use: see GitHub release notes"
```

必要なら直前の正常 version へ `latest` dist-tag を戻す。

```console
: "${PREVIOUS_VERSION:?set PREVIOUS_VERSION to the exact version to restore}"
npm dist-tag add "@tamat-llc/repo-knowledge-mcp@${PREVIOUS_VERSION}" latest
```

trusted publishing の OIDC token は publish 操作に限定されるため、deprecate と dist-tag の変更には npm account の 2FA 付き対話認証を使う。

その後、原因を修正した patch version を新しい tag から公開し、registry smoke と provenance を再確認する。

unpublish は依存利用者を破壊し得るため、npm policy と security incident response が明示的に要求する場合だけ検討する。
