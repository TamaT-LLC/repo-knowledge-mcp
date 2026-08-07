# M1 golden quality gate

M1 の匿名化 fixture と記録済み prediction を使い、モデルやネットワークへ接続せず品質指標を再計算する。

## 実行方法

リポジトリルートで次を実行する。

```console
npm run --silent golden > /tmp/m1-golden.json
diff -u docs/testing/m1-golden-baseline.json /tmp/m1-golden.json
```

評価入力は [m1-golden.json](../../test/fixtures/golden/m1-golden.json)、初回計測値は [m1-golden-baseline.json](./m1-golden-baseline.json) に固定している。
出力は schema version、fixture ID、件数、各指標の numerator、denominator、value を含む JSON である。

## 指標

- 抽出: precision、recall
- category: macro F1
- severity: must=3、should=2、consider=1 の重み付き accuracy
- merge: 同一グループ pair の precision、recall
- scope: glob 妥当率、期待ファイルへの match 率
- search: MRR、NDCG

fixture は 50 スレッド相当で、複数ルール、撤回、resolved だが不採用、編集、返信追加、未知 bot、外部 contributor、prompt injection、日本語の短い検索語、nested pagination をタグで追跡する。

初回 baseline の prediction は期待値を記録した evaluator 自体の基準値であり、実モデルの品質値ではない。
実 provider で同じ匿名化 corpus を計測した後に quality gate の閾値を決定する。
閾値が確定するまでは、schema・fixture 件数・指標集合の再現性と、baseline からの意図しない差分をゲートとする。
