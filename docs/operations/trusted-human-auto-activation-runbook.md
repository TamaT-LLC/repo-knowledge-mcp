# trusted-human auto activation runbook

`trust.autoActivateTrustedHuman` を個人用ローカルストアで有効化するときの手順を定める。

設計上の背景は、[M3 個人利用要件](../design/repo-knowledge-mcp-v0.3-personal-use.md)の M3-FR-004 と M3-FR-005、および [repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md)の Mutation Path §2.3 を参照する。

この設定は利用者ごとの trust policy であり、チーム共通の承認状態を表さない。

## 不変条件（コード側）

- `trust.autoActivateTrustedHuman` の**出荷既定値は `false`** であり、
  本 runbook を含むいかなる運用手順もこの既定値を変更しない。
  既定値は `TrustConfigSchema`（`src/domain-schemas.ts`）で定義され、
  `test/config.test.ts` と `test/quality-gate-runner.test.ts` が
  `false` のまま維持されることをテストで固定している
- 有効化は **operator が自分の config で行う明示 opt-in のみ**。
  リポジトリ・パッケージ・テンプレートのどこにも
  `autoActivateTrustedHuman: true` を既定として置いてはならない
- 個人利用では、別の maintainer による承認を必須としない。
  operator は、自分が選択した trusted human と自動 active 化されたルールに責任を持つ
- committed baseline artifact の `trust_policy_digest` は既定 trust policy
  から計算されているため、既定値を勝手に変えるとオフライン quality gate が
  `FIXTURE_DRIFT` で失敗する（意図しない既定変更の検知網）

## 有効化を検討してよくなる前提条件（すべて必須）

1. **quality gate の継続通過**: `npm run quality:gate` が exit 0
   （`status: "pass"`）であり、直近の CI（Node 22 / 24 の両方）でも
   gate が通過し続けていること。gate が失敗している間は検討自体を凍結する
2. **live 実測に基づく閾値**: thresholds の `source` が
   `live_measurement` へ更新済みであること（fixture replay ベースの
   `m2-thresholds-v1` のままでは有効化を検討しない）。更新は
   [golden baseline runbook](./golden-baseline-runbook.md) の
   手順 4 と運用規約 4.1 に従う
3. **人間による precision 確認**: 実 PR 由来の proposed ルール
   （最低直近 10 PR 分）を人間が確認し、trusted human 由来 candidate の
   precision が運用上十分と判断できること（設計 §2.3 の opt-in 条件）
4. **M2 運用実績**: cron 同期での 2 週間運用（設計 §19 M2 完了条件）を
   経ており、ランキング・抽出品質に未解決の回帰報告がないこと

## 有効化の手順

1. gate の report JSON、確認した PR 一覧、M2 pilot report を確認する
2. `trustedLogins` と `trustedActorIds` を確認し、未知 bot、外部 contributor、同一人物の未解決 alias が含まれていないことを確認する
3. 有効化する operator 自身の config にのみ次を設定する:

   ```json
   { "trust": { "autoActivateTrustedHuman": true } }
   ```

4. 有効化後も auto active の対象が、originator と thread 内の全 comment が trusted human であり、severity が `must` ではない candidate に限定されることを確認する
5. AI reviewer、未知 bot、外部 contributor、mixed trust、severity `must` の candidate が review inbox に残ることを確認する
6. 有効化した日時、operator、参照した gate と pilot report を個人の運用記録に残す

## 監視とロールバック

- 有効化後 2 週間は、自動 active になったルールを週次で棚卸しし、
  誤 active（false positive）を記録する
- 次のいずれかが起きたら **即座に `false` へ戻す**（設定 1 行の変更のみで
  戻り、既存ルールの status は変更されない）:
  - quality gate が指標低下（exit 1）で失敗した
  - 自動 active されたルールに false positive が見つかった
  - trust policy / prompt / schema 世代の変更で gate が
    `FIXTURE_DRIFT` になった（再 review が完了するまで無効化する）
- ロールバック後に再度有効化する場合は、本 runbook の手順を最初からやり直す

## よくある誤り

| 誤り                                                | 正しい扱い                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| gate が失敗しているが「一時的だから」と有効化を続行 | gate 失敗中は有効化を停止する。gate 修復が先                                                                                |
| リポジトリの設定例・README に `true` を記載         | 既定・例示はすべて `false`。opt-in は operator の config のみ                                                             |
| 閾値を下げて gate を通してから有効化                | gate 緩和は [運用規約 4.1](./golden-baseline-runbook.md) の合意手続きが必須。auto activation の前提を弱める変更として扱う |
| 有効化を CI や自動化で行う                          | 有効化は人間の明示操作のみ。自動化してはならない                                                                          |
| 個人利用だから trusted reviewer を確認しない        | 個人利用でも trust policy は必要。setup が提示した候補を operator が確認する                                              |
