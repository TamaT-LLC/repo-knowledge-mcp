# npm release runbook

本 runbook は、`repo-knowledge-mcp` を public npm package として公開するための準備、実行、検証、rollback を定義する。

通常の公開は GitHub Actions と npm trusted publishing を使い、長期 npm credential を repository secret に保存しない。

## 1. 公開契約

| 項目 | 契約 |
| --- | --- |
| package 名 | `repo-knowledge-mcp` |
| registry | `https://registry.npmjs.org/` |
| access | public |
| version | prerelease suffix のない SemVer |
| tag | package version に `v` を付けた値 |
| release branch | tag の commit が `origin/main` に含まれること |
| repository visibility | public |
| 対応 Node.js | 22、24 |
| publish runtime | Node.js 24、npm 11.5.1 以上 |
| 通常認証 | GitHub Actions OIDC による npm trusted publishing |
| provenance | `npm publish --provenance` で生成 |

2026-08-14 時点の公開準備状況は次のとおりである。

| 項目 | 状態 |
| --- | --- |
| npm registry | `repo-knowledge-mcp` は未公開で、`npm view` は E404 |
| local npm認証 | 未認証 |
| GitHub repository | public |
| package version | `0.3.0` |
| license | `package.json` はMIT、rootに`LICENSE`あり |
| GitHub `npm` environment | required reviewer、self-review禁止、`v*` tag deployment policyを設定済み |
| `main` protection | Pull Request、owner review、Node.js 22と24のCI、CodeQLを必須化済み |
| version tag protection | `v*`の更新と削除を禁止済み |
| release artifact | tag、GitHub Release、npm packageはいずれも未作成 |
| M2 release gate | pilot-002の14日運用gateと修正後のranking human評価を組み合わせてgo |

E404はpackage名の確保やpublish権限を保証しない。
初回公開前に、npm accountからpackage名、実際のowner、2FA、public accessを確認する。

## 2. trusted publishing の設定

初回 package 作成後、npm package settings の trusted publisher を次の値で設定する。

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

初回 package 作成後は npm CLI 11.19.0 以降の `npm trust` でも同じ設定を作成して監査できる。
実行する account が package owner または trusted publisher を管理できる maintainer であることを確認し、workflow filename には path ではなく basename だけを渡す。

```console
npm trust github repo-knowledge-mcp \
  --repository TamaT-LLC/repo-knowledge-mcp \
  --file release.yml \
  --environment npm \
  --allow-publish \
  --yes
npm trust list repo-knowledge-mcp --json
```

GitHub environment の required reviewer と deployment branch policy は GitHub plan で利用可能な場合に設定する。
設定 API が plan 制約で拒否された場合も空の `npm` environment を release 承認の代替として扱わず、repository の public 化または plan 変更後に protection rule を再設定してから公開する。

trusted publishing の要件は [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) を参照する。

provenance の検証方法は [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/) を参照する。

## 3. 初回公開の bootstrap

npm は既存 package に対して trusted publisher を設定するため、未作成 package の初回公開だけは OIDC 設定より先に実施する必要がある。

初回公開担当者は npm account の 2FA を有効にし、package 名、owner、license、version、tarball report を二者確認する。

初回公開には、対象packageのpublishに限定した有効期限の短いgranular access tokenをGitHub `npm` environment secretとして一時登録する。

通常の`release.yml`はtokenを参照せず、未作成packageの初回公開には使用できない。
M2 pilotのgo判定後、初回公開専用workflowをreviewし、GitHub-hosted runner上でexact tarballに`npm publish --access public --provenance`を実行する。
専用workflowは通常のrelease gate、GitHub `npm` environment、required reviewerを省略してはならない。

公開直後にtokenをnpmとGitHubの両方から失効または削除し、trusted publisherを前節の値で登録する。

初回公開のために長期tokenを作成したり、tokenをrepository、artifact、log、個人設定ファイルへ保存したりしてはならない。

初回公開専用workflowまたは通常workflowへの一時変更をmainへ入れた場合は、公開直後のPull Requestでtoken参照を削除する。
Secretの値をcommitしてはならない。

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
9. GitHub repositoryがpublicで、npm owner、license、GitHub `npm` environmentが確認済みである。
   初回公開ではbootstrap認証をreviewし、二回目以降はtrusted publisherを確認する。
10. 公開対象 commit の security review が完了し、CodeQL、secret scanning、依存関係監査に未解決の critical または high finding がない。

version、tag、commit、working tree、Node.js、npm、registry の重複、repository visibility、`package.json` の明示 license、空でない通常ファイルの `LICENSE` / `LICENSE.md` は `release:verify` が fail-closed で検査する。

```console
npm ci --ignore-scripts
npm audit --audit-level=high
npm audit signatures
npm rebuild
npm run check
npm run golden
npm run quality:gate
npm run package:smoke
npm run --silent release:verify -- --tag v0.3.0 --commit <full-commit-sha> --repository-visibility public
```

この順序を入れ替えてはならない。
lifecycle script を実行する `npm rebuild` は dependency と registry signature の検証後にだけ実行する。

## 5. 公開手順

次の手順はtrusted publisher設定後の通常公開に使用する。
未作成packageの初回公開は、前節の前提条件と第3節のbootstrap手順を満たした専用workflowから実行する。

1. main の検証済み commit に annotated tag を作成して push する。
2. 同じ tag を指定した draft GitHub release に、review 済み release report を添付する。
3. draft を publish して `Release npm package` workflow を開始する。
4. `verify release` と `registry smoke` の Node.js 22 と 24、および `publish exact tarball` が成功するまで release 完了としない。

workflow の verify job は exact tag を checkout し、source check、golden、quality gate、package smoke を Node.js 22 と 24 で再実行する。

verify job と publish job は lifecycle script を無効にして依存関係を展開し、`npm audit --audit-level=high` と `npm audit signatures` を通過してから `npm rebuild` で検証済み dependency の lifecycle script を実行する。
既知の high または critical vulnerability、改ざんまたは署名欠落を検出した release は publish job へ進めない。

publish job は `npm pack --dry-run --json` と実 tarball の manifest、integrity、shasum が一致することを検査する。

allowlist 外の file、`.repo-knowledge/`、fixture、local store、database、credential 形式を含む tarball は公開前に拒否する。

clean temporary project へ exact tarball を install し、guided setup help、review help、`get_rules` readiness、stdio MCP server を検証する。

この smoke の対象 workspace に `.repo-knowledge/` が作成されないことも検査する。

publish 後は registry 反映を待ち、exact version の `npm exec` と同じ package smoke を新しい npm cache で実行する。

## 6. 公開後の確認

workflow の artifact から `package-artifact-report.json` を取得し、release report の name、version、commit、tarball integrity と照合する。

手元で再確認する場合も `latest` を使わず exact version を指定する。

```console
npx --yes --package=repo-knowledge-mcp@0.3.0 -- repo-knowledge --help
npm run --silent registry:smoke -- --name repo-knowledge-mcp --version 0.3.0
```

npm package page の provenance が対象 GitHub repository、workflow、commit を指していることを確認する。

## 7. 失敗時と rollback

npm の公開済み version と Git tag は再利用しない。

公開前に失敗した場合は原因を修正し、新しい commit と version で release をやり直す。

publish 後の registry smoke が失敗した場合は、package page と exact version を確認し、GitHub release に障害状態を明記する。

利用させてはいけない version は、2FA 付きの対話認証で次のように deprecate する。

```console
npm deprecate repo-knowledge-mcp@0.3.0 "Do not use: see GitHub release notes"
```

必要なら直前の正常 version へ `latest` dist-tag を戻す。

```console
npm dist-tag add repo-knowledge-mcp@<previous-version> latest
```

trusted publishing の OIDC token は publish 操作に限定されるため、deprecate と dist-tag の変更には npm account の 2FA 付き対話認証を使う。

その後、原因を修正した patch version を新しい tag から公開し、registry smoke と provenance を再確認する。

unpublish は依存利用者を破壊し得るため、npm policy と security incident response が明示的に要求する場合だけ検討する。
