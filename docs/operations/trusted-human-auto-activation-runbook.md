# trusted-human auto activation runbook

`trust.autoActivateTrustedHuman` を個人用ローカルストアで有効化するときの手順を定める。

設計上の背景は、[M3 個人利用要件](../design/repo-knowledge-mcp-v0.3-personal-use.md)の M3-FR-004 と M3-FR-005、および [repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md)の Mutation Path §2.3 を参照する。

この設定は利用者ごとの trust policy であり、チーム共通の承認状態を表さない。

## 適用対象

本 runbook は、[#89](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/89)の finalize-time policy を含み、M3-AC-005 と M3-AC-006 が通過したリリースに適用する。

それより前のリリースでは、`autoActivateTrustedHuman` を `false` のまま維持する。

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
- thread 正規化時の `initialKnowledgeStatus` は常に `proposed` とする。
  自動 active 化は、最終 candidate の severity と最新 thread 全体がそろう finalize 時にだけ判定する
- `trustedHumanAutoActivationEligibility` がない場合は、opt-in が `true` でも新しい candidate を `proposed` にする
- committed baseline artifact の `trust_policy_digest` は既定 trust policy
  から計算されているため、既定値を勝手に変えるとオフライン quality gate が
  `FIXTURE_DRIFT` で失敗する（意図しない既定変更の検知網）

## 有効化を検討してよくなる前提条件（すべて必須）

1. **M3 safety implementation**: #89 の変更を含むリリースであり、severity `must` が proposed のまま review inbox に残ることを policy test と product E2E で確認済みであること
2. **quality gate の継続通過**: `npm run quality:gate` が exit 0
   （`status: "pass"`）であり、直近の CI（Node 22 / 24 の両方）でも
   gate が通過し続けていること。gate が失敗している間は検討自体を凍結する
3. **live 実測に基づく閾値**: thresholds の `source` が
   `live_measurement` へ更新済みであること（fixture replay ベースの
   `m2-thresholds-v1` のままでは有効化を検討しない）。更新は
   [golden baseline runbook](./golden-baseline-runbook.md) の
   手順 4 と運用規約 4.1 に従う
4. **人間による precision 確認**: 実 PR 由来の proposed ルール
   （最低直近 10 PR 分）を人間が確認し、trusted human 由来 candidate の
   precision が運用上十分と判断できること（設計 §2.3 の opt-in 条件）
5. **M2 運用実績**: cron 同期での 2 週間運用（設計 §19 M2 完了条件）を
   経ており、ランキング・抽出品質に未解決の回帰報告がないこと。
   2週間運用後に検索関連度だけを修正した場合は、14日運用gateが`go`の運用reportと、
   ranking gateが`go`のreview済み[修正後限定再評価report](./m2-post-fix-revalidation-report-m2-post-fix-revalidation-001.md)を組み合わせ、総合M2判定も`go`であることを確認する

## eligibility 記録

**activation eligibility** は、operator が確認した M2 pilot report、live baseline、quality gate report をローカル config に結び付ける監査記録である。

`m2Pilot.reportDigest`、`qualityGate.baselineArtifactDigest`、`qualityGate.reportDigest` には、各ファイルの exact bytes から計算した `sha256:<64桁のhex>` を記録する。

runtime は digest の形式、pilot の `go`、baseline の `live_measurement`、gate の `pass` を検証する。

さらに、`qualityGate.trustPolicyDigest` を現在の trust config と candidate の distillation provenance の両方に照合する。

report と baseline のファイル本体は operator の管理下にあり、runtime は config に記録された digest からファイルの真正性を証明しない。

この境界は、個人用ローカル config を編集できる operator 自身を攻撃者として扱わない設計に対応する。

## 有効化の手順

1. gate の report JSON、確認した PR 一覧、M2 pilot report を確認する。
2. 各 report と baseline の exact-byte SHA-256 digest を計算する。
3. `trustedLogins` と `trustedActorIds` を確認し、未知 bot、外部 contributor、同一人物の未解決 alias が含まれていないことを確認する。
4. operator 自身の config に、確認済み artifact から作成した eligibility と opt-in を設定する。

   ```json
   {
     "trust": {
       "autoActivateTrustedHuman": true
     },
     "trustedHumanAutoActivationEligibility": {
       "schemaVersion": 1,
       "m2Pilot": {
         "completedAt": "2026-08-23T00:20:00.000Z",
         "decision": "go",
         "reportDigest": "sha256:<pilot-reportのdigest>"
       },
       "qualityGate": {
         "baselineArtifactDigest": "sha256:<live-baselineのdigest>",
         "reportDigest": "sha256:<gate-reportのdigest>",
         "source": "live_measurement",
         "status": "pass",
         "thresholdsVersion": "<review済みthresholds version>",
         "trustPolicyDigest": "sha256:<現在のtrust policy digest>"
       }
     }
   }
   ```

5. MCP server を再起動し、新しい config を読み込ませる。
6. auto active の対象が、originator と thread 内の全 comment が trusted human であり、severity が `must` ではない candidate に限定されることを確認する。
7. AI reviewer、未知 bot、外部 contributor、mixed trust、severity `must` の candidate が review inbox に残ることを確認する。
8. 有効化した日時、operator、参照した gate と pilot report を個人の運用記録に残す。

## 監視とロールバック

- 有効化後 2 週間は、自動 active になったルールを週次で棚卸しし、
  誤 active（false positive）を記録する
- 次のいずれかが起きたら **即座に `false` へ戻し**、MCP server を再起動する。
  この操作は新しい candidate の自動 active 化だけを停止し、既存ルールの status を変更しない:
  - quality gate が指標低下（exit 1）で失敗した
  - 自動 active されたルールに false positive が見つかった
  - trust policy / prompt / schema 世代の変更で gate が
    `FIXTURE_DRIFT` になった（再 review が完了するまで無効化する）
- ロールバック後に再度有効化する場合は、本 runbook の手順を最初からやり直す
- gate、baseline、pilot report、trust policy のいずれかを更新した場合は、古い eligibility を再利用せず、新しい digest で記録を作り直す

## よくある誤り

| 誤り                                                | 正しい扱い                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| gate が失敗しているが「一時的だから」と有効化を続行 | gate 失敗中は有効化を停止する。gate 修復が先                                                                                |
| README、既定 config、setup 出力に `true` を記載     | これらの例示はすべて `false`。`true` は本 runbook に従って operator の config にだけ設定する                              |
| 閾値を下げて gate を通してから有効化                | gate 緩和は [運用規約 4.1](./golden-baseline-runbook.md) の合意手続きが必須。auto activation の前提を弱める変更として扱う |
| 有効化を CI や自動化で行う                          | 有効化は人間の明示操作のみ。自動化してはならない                                                                          |
| 個人利用だから trusted reviewer を確認しない        | 個人利用でも trust policy は必要。setup が提示した候補を operator が確認する                                              |
