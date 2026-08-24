# M1 real pull request smoke gate

実 GitHub Pull Request 10 件を取り込み、冪等性、一覧、reindex、doctor を同じ CLI 境界で検証する。
入力は [m1-smoke-manifest.json](./m1-smoke-manifest.json)、結果は [m1-smoke-results.json](./m1-smoke-results.json) に保存する。

## 前提条件

- Node.js 22 または 24
- `gh auth status` が成功し、manifest のリポジトリを GraphQL で読めること
- ローカル filesystem 上で実行すること
- provider 送信を無効のまま実行すること

## 再現手順

検証対象 commit を checkout し、依存関係を固定して実行する。

```console
npm ci --ignore-scripts
npm run install-scripts:check
npm audit --audit-level=high
npm audit signatures
npm rebuild
gh auth status
npm run --silent smoke:m1 -- \
  --manifest docs/testing/m1-smoke-manifest.json \
  --commit "$(git rev-parse HEAD)" \
  > /tmp/m1-smoke-results.json
```

保存先を省略すると一時ディレクトリを作成し、終了時に削除する。
再実行間で同じ canonical store を確認するときだけ `--storage <local-path>` を追加する。

## 判定と結果形式

終了コード 0 かつトップレベルの `ok` が true なら pass とする。
JSON report は次を含む。

- 実行 commit、Node version、platform、開始・終了時刻
- PR ごとの snapshot ID と new、changed、unchanged、job、pending 件数
- 先頭 PR の再 ingest で new、changed、jobs_created がすべて 0 になる冪等性判定
- list、reindex、doctor の要約と個別 status

report は件数と診断だけを保持し、review 本文や prompt に相当する raw content を含めない。
失敗時は `diagnostic` を確認し、同じ commit と manifest で再実行する。
結果を更新するときは `/tmp/m1-smoke-results.json` を確認してから、リポジトリ内の結果ファイルを置き換える。
