# provider golden baseline 測定 runbook

匿名化 corpus を実 provider に送って golden baseline を実測し、M2 quality gate の
閾値（[m2-quality-thresholds.json](../../test/fixtures/golden/m2-quality-thresholds.json)）を
確定・更新するための手順書。設計上の背景は
[repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md) の §18（テスト方針）と §19 M2 を参照。

## 全体像

| 入力 / 出力    | ファイル                                            | 内容                                                                                                           |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 入力           | `test/fixtures/golden/m2-anonymized-corpus.json`    | 匿名化 50+ スレッド corpus と検索クエリ。期待ラベルはローカル評価専用で、provider へは送らない項目に依存しない |
| 入力（replay） | `test/fixtures/golden/m2-recorded-predictions.json` | 記録済み provider prediction。replay はネットワークに一切触れない                                              |
| 出力           | `test/fixtures/golden/m2-provider-baseline.json`    | prediction から組み立てた golden fixture + model/prompt/schema/policy provenance                               |
| 出力           | `test/fixtures/golden/m2-quality-thresholds.json`   | metric ごとの下限閾値（review 済み・version 付き）                                                             |

baseline artifact は「期待値のコピー」ではなく **provider prediction の記録**である。
metric report は artifact 内の記録済み prediction だけから決定的に再計算できるため、
同じ artifact からは常に同じ report が得られる。

## 前提条件と同意モデル

- 実測（`--live`）は operator がローカル端末で行う。**CI からは絶対に実行しない**。
  CLI は `CI` / `GITHUB_ACTIONS` 環境変数を検出すると
  `BASELINE_LIVE_CAPTURE_BLOCKED_IN_CI` で拒否する（fail-closed）
- 実測は匿名化 corpus 全文をログイン済み Claude Code が使う model へ送信する。送信には
  `--consent-cloud-transmission` フラグによる**明示 opt-in が必須**で、
  フラグなしの `--live` は `BASELINE_CLOUD_CONSENT_REQUIRED` で拒否される
- corpus は読み込み時に秘匿情報 scan を通過しなければならない。検出対象は
  provider API key（`sk-` prefix 全般: Anthropic / OpenAI 等）/ Google API key /
  GitHub token / Slack token / AWS access key / private key block /
  Authorization header / 代入形式の secret（`api_key = "..."` 等）/
  メールアドレス。過剰検出は fail-closed として許容する。
  検出時はエラーに **JSON パスとパターン種別のみ**が載り、値そのものは出力されない
- 生成された artifact も保存前に同じ scan を通る。raw secret・token・
  非匿名化レビュー内容が baseline artifact に混入した場合、保存自体が失敗する
- `claude auth login` 済みの対象サブスクリプションを使う。Provider API key は設定しない

## 1. replay での再現（ネットワーク不要・通常運用）

記録済み prediction から baseline artifact を byte 単位で再生成する。

```console
$ npm run golden:baseline:replay
```

内部的には次と同じ。

```console
$ node dist/golden-baseline-cli.js \
    --corpus test/fixtures/golden/m2-anonymized-corpus.json \
    --replay test/fixtures/golden/m2-recorded-predictions.json \
    --out test/fixtures/golden/m2-provider-baseline.json
```

- `measured_at` は recorded prediction の `recorded_at` を用いるため、
  出力は何度実行しても同一 byte になる（リポジトリへコミットする際は
  `npm run format` で Biome 整形を適用する。整形は表記のみで内容は不変）
- corpus と recorded prediction の `corpus_id` が一致しない場合は
  `BASELINE_CORPUS_MISMATCH` で失敗する

## 2. metric report の再計算と quality gate

抽出（precision / recall）・category（macro F1）・severity（weighted accuracy）・
merge（pairwise precision / recall）・scope（valid glob 率・期待ファイル一致率）・
検索（MRR / NDCG）の全指標を artifact から再計算し、閾値と比較する。

```console
$ node dist/golden-cli.js test/fixtures/golden/m2-provider-baseline.json \
    --thresholds test/fixtures/golden/m2-quality-thresholds.json
```

- exit 0: 全指標が下限以上（`quality_gate.ok: true`）
- exit 1: いずれかの指標が下限未満。report の `results[]` で該当 metric を特定する
- exit 2: artifact / thresholds の形式不正、または thresholds が別の測定に紐づく
  （`QUALITY_GATE_BASELINE_MISMATCH`）。thresholds の `baseline` は corpus だけでなく
  `measured_at` と、**artifact 全体**（provenance の全世代 + transmission mode +
  記録済み prediction fixture 本体）の JCS SHA-256 である `artifact_digest` で
  測定内容に束縛される。同じ corpus を別時刻・別 model で測り直した artifact も、
  review 後に prediction を 1 件でも差し替えた artifact も、旧 thresholds では
  gate を通過できない
- `--thresholds` なしで実行すると `{ baseline, report }` を出力する。`baseline`
  ブロックは thresholds へそのまま転記できる測定 identity（`artifact_digest` 含む）
- 同じコマンドは `npm run golden` の 3 本目としても実行され、CI でも
  （記録済み prediction のみで）毎回検証される

## 2.1 offline quality gate（CI / release gate）

CI と release 前検証は、上記の指標比較に **fixture drift 検出**を加えた
統合 gate を実行する。live network も provider credential も一切不要で、
記録済み prediction だけから決定的に完走する。

```console
$ npm run quality:gate
```

内部的には次と同じ（引数はすべて省略可能で、既定はコミット済み fixture）。

```console
$ node dist/quality-gate-cli.js \
    --artifact test/fixtures/golden/m2-provider-baseline.json \
    --thresholds test/fixtures/golden/m2-quality-thresholds.json \
    --corpus test/fixtures/golden/m2-anonymized-corpus.json \
    --recorded test/fixtures/golden/m2-recorded-predictions.json \
    --prompt prompts/distill.md
```

gate は次を 1 コマンドで検証し、結果を必ず**機械可読 JSON report**として
stdout に出力する（`report_kind: "m2_quality_gate_report"`）。

| 検証                                                                                                               | 失敗時の failure code                                   | exit |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---- |
| thresholds / artifact のスキーマ妥当性                                                                             | `THRESHOLDS_INVALID` / `ARTIFACT_INVALID`               | 2    |
| thresholds が review 済み測定に束縛されているか                                                                    | `BASELINE_MISMATCH`（不一致 field 一覧付き）            | 2    |
| corpus + recorded prediction + 現行 prompt/schema/policy 世代から artifact を replay 再現できるか（fixture drift） | `FIXTURE_DRIFT` / `REPLAY_FAILED`                       | 2    |
| 全指標が存在するか                                                                                                 | `METRIC_MISSING`                                        | 2    |
| 全指標が下限以上か                                                                                                 | `METRIC_BELOW_MINIMUM`（metric / minimum / value 付き） | 1    |
| 入力ファイルが読めるか                                                                                             | `INPUT_UNREADABLE`                                      | 2    |

- exit 0: `status: "pass"`。全指標が下限以上で、drift も世代不一致もない
- exit 1: `status: "metric_failure"`。指標低下のみ（integrity は健全）
- exit 2: `status: "integrity_failure"`。入力・束縛・drift の問題
- 同じ入力からは Node 22 / 24 で **同一 byte の report と同一 exit code** が
  得られる（CI は両バージョンで `npm run golden` と `npm run quality:gate` を実行する）
- prompt（`prompts/distill.md`）や output schema・trust policy・ranking policy の
  世代がコード側で変わると、replay された artifact の provenance digest が
  変わるため `FIXTURE_DRIFT` として検出される。意図した変更なら
  手順 1 の replay で artifact を再生成し、手順 4 で thresholds を再 review する

## 3. 実 provider での実測（operator のみ・明示 opt-in）

```console
$ claude auth status --json
$ node dist/golden-baseline-cli.js \
    --corpus test/fixtures/golden/m2-anonymized-corpus.json \
    --live --model <実測に使う model id> \
    --consent-cloud-transmission \
    --out /tmp/m2-live-baseline.json
```

- `measured_at` は実行時刻になる
- artifact の `provenance` に provider / model / prompt（version + digest）/
  output schema（version + digest）/ trust policy digest / ranking policy
  （version + digest）/ 検索導出 version が記録され、世代を一意に追跡できる
- `transmission` に `mode: "live"` と `cloud_consent: true` が記録される
- 複数回実測して metric の分散（誤差）を確認する場合は `--out` を変えて
  実行し、それぞれに手順 2 の report 再計算を行う

実測結果を後から再現可能な記録として残す場合は、provider の応答を
`m2-recorded-predictions.json` と同じ schema（`responses[thread_id].output`）へ
転記した recorded prediction ファイルを作り、手順 1 の replay で artifact が
再生成できることを確認してからコミットする。

## 4. 閾値の確定・更新手順（version 付き）

1. 手順 3 の実測を **複数回**（最低 2 回）行い、metric ごとの値と誤差幅を記録する
2. metric ごとに `minimum = 実測値の最小値 − margin` を決める。margin は
   誤差幅と corpus サイズ（1 誤り当たりの metric 変動量）を根拠に選ぶ
3. `m2-quality-thresholds.json` を更新する:
   - `metrics.<name>.measured` / `margin` / `minimum` / `rationale`（変更理由）
   - `baseline`（artifact_kind / corpus_id / corpus_digest / measured_at /
     artifact_digest）を review 対象 artifact の値に一致させる。値は
     `node dist/golden-cli.js <artifact>` の出力冒頭 `baseline` ブロックを
     そのまま転記する（不一致は gate 実行時に
     `QUALITY_GATE_BASELINE_MISMATCH` で拒否される）
   - `source` を `live_measurement` に変更する
   - `thresholds_version` を bump する（例: `m2-thresholds-v2`）
   - `reviewed.at` / `reviewed.by` を review 実施者で更新する
4. `npm run golden` と `npm run check` が成功することを確認してコミットする

現行の `m2-thresholds-v1` は **fixture ベース**（`source: "fixture_replay"`、
記録済み fixture prediction の replay 実測値 − margin）であり、実 provider の
live 実測で置き換える際は必ずこの手順で version を進めること。

## 4.1 閾値・baseline 更新の運用規約（必須）

`m2-quality-thresholds.json` / `m2-provider-baseline.json` /
`m2-recorded-predictions.json` / `m2-anonymized-corpus.json` に触れる変更は、
すべて次の規約に従う。gate の閾値と baseline は「二人目の目を通さずに
動かせない」ことを不変条件とする。

1. **理由の明文化**: 変更する metric ごとに `rationale` を更新し、
   「なぜ下限を動かすのか」「margin の根拠（誤差幅・corpus サイズ）」を書く。
   `rationale` の更新なしに `minimum` だけ動かす変更は review で差し戻す
2. **version bump**: 閾値の意味が変わる変更（`minimum` / `baseline` /
   `source` の変更、corpus 差し替え）では `thresholds_version` を必ず進める。
   同一 version のまま内容だけ変える変更は禁止
3. **reviewer 確認**: `reviewed.by` / `reviewed.at` を実際に review した
   maintainer で更新する。**変更の作成者自身のみを reviewer とする自己承認は
   不可**で、PR は作成者以外の maintainer が approve してからマージする
4. **PR 単位の分離**: 閾値・baseline の更新は挙動変更と同じ PR に混ぜず、
   単独 PR にする（gate の緩和が機能変更に紛れて通ることを防ぐ）
5. **機械検証**: マージ前にローカルで `npm run golden` と
   `npm run quality:gate` と `npm run check` がすべて成功していること。
   binding（`artifact_digest`）は gate が機械的に強制するため、
   「thresholds だけ更新して baseline を置き忘れる」ような不整合は
   `QUALITY_GATE_BASELINE_MISMATCH` / `FIXTURE_DRIFT` として CI で落ちる
6. **緩和の扱い**: `minimum` の引き下げ（gate 緩和）は原則禁止。緩和が
   必要な場合は、理由（corpus 変更・指標定義の変更など）と代替の
   安全策を PR 本文に明記し、maintainer 2 名の合意を得る

quality gate の通過は
[trusted-human auto activation runbook](./trusted-human-auto-activation-runbook.md)
の前提条件でもある。gate を緩めることは auto activation の安全前提を
緩めることを意味するため、上記規約は例外なく適用する。

## 失敗時の診断

| エラー                                 | 原因                                                                                                                    | 対処                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BASELINE_CLOUD_CONSENT_REQUIRED`      | `--live` に opt-in フラグなし                                                                                           | 送信内容を確認のうえ `--consent-cloud-transmission` を付ける                             |
| `BASELINE_LIVE_CAPTURE_BLOCKED_IN_CI`  | CI 環境で `--live`                                                                                                      | 実測はローカルでのみ行う。CI では replay を使う                                          |
| `BASELINE_SENSITIVE_CONTENT`           | corpus か prediction に秘匿情報                                                                                         | 報告された JSON パスの内容を匿名化してから再実行する                                     |
| `BASELINE_CORPUS_MISMATCH`             | corpus と recorded の世代不一致                                                                                         | 対になる corpus / recorded ファイルを揃える                                              |
| `QUALITY_GATE_BASELINE_MISMATCH`       | thresholds が別の測定に紐づく（別時刻・別 model・別 prompt/schema/policy 世代、または review 後の prediction 差し替え） | 手順 4 で thresholds を対象 artifact に対して再 review し、`baseline` ブロックを更新する |
| `BASELINE_RECORDED_PREDICTION_MISSING` | recorded に未収載スレッド                                                                                               | corpus 変更後に recorded prediction を取り直す                                           |
| `AUTHENTICATION_MISSING`               | Claude Code に利用可能なサブスクリプション login がない                                                                | `claude auth login` を実行して subscription sign-in を選ぶ                               |

## corpus を変更する場合

corpus とその期待ラベル・recorded prediction は
`scripts/generate-m2-baseline-corpus.mjs` から決定的に生成される。
入力は同スクリプト内の固定 spec・定数と lockfile で固定した Biome formatter
だけで、時計・乱数・環境変数・network には依存しない。出力先は次の
2 ファイルに固定されている。

- `test/fixtures/golden/m2-anonymized-corpus.json`
- `test/fixtures/golden/m2-recorded-predictions.json`

```console
$ npm run golden:corpus:generate
$ npm run golden:corpus:check
$ npm run golden:baseline:replay
$ npm run format
$ npm run golden:corpus:check
$ npm run golden
```

corpus を変更したら `corpus_id` を日付付きで進め、thresholds の `baseline` 節と
`thresholds_version` も併せて更新する（手順 4）。`npm run check` も生成済みの
2 ファイルが generator と byte-for-byte で一致することを検証する。
