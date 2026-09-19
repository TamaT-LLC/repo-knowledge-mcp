# M1 golden quality gate

M1 の匿名化 fixture と記録済み prediction を使い、モデルやネットワークへ接続せず品質指標を再計算する。

## 実行方法

source checkout のルートで build し、M1 fixture だけを指定して実行する。

```console
npm run build
node dist/golden-cli.js test/fixtures/golden/m1-golden.json > /tmp/m1-golden.json
diff -u docs/testing/m1-golden-baseline.json /tmp/m1-golden.json
```

評価入力は [m1-golden.json](../../test/fixtures/golden/m1-golden.json)、初回計測値は [m1-golden-baseline.json](./m1-golden-baseline.json) に固定している。
出力は schema version、fixture ID、件数、各指標の numerator、denominator、value を含む JSON である。
`npm run golden` は現在、M1、M2 outcome ranking、M2 provider baseline の三つを連続実行する。
その stdout 全体を一つの JSON や M1 baseline として扱わないこと。

## 指標

- 抽出: precision、recall
- category: macro F1
- severity: must=3、should=2、consider=1 の重み付き accuracy
- merge: 同一グループ pair の precision、recall
- scope: glob 妥当率、期待ファイルへの match 率
- search: MRR、NDCG

fixture は 50 スレッド相当で、複数ルール、撤回、resolved だが不採用、編集、返信追加、未知 bot、外部 contributor、prompt injection、日本語の短い検索語、nested pagination をタグで追跡する。

初回 baseline の prediction は期待値を記録した evaluator 自体の基準値であり、実モデルの品質値ではない。
M1 は schema・fixture 件数・指標集合の再現性と、baseline からの意図しない差分を確認する。
現行の閾値付き gate は M2 fixture を対象とする `npm run quality:gate` で、threshold の `source` は `fixture_replay` である。
live measurement への更新方法は [provider golden baseline 測定 runbook](../operations/golden-baseline-runbook.md) を参照する。
