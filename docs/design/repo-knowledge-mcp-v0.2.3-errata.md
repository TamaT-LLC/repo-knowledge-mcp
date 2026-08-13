# repo-knowledge-mcp 設計 Errata（v0.2.3 対応）

- **日付**：2026-08-06
- **位置づけ**：v0.2.3 への errata。
  write path の構造は変更しない。
  実装時の解釈差を閉じる確定事項である。
- **ステータス**：**Architecture Gate、Mutation Path Gate、Write Path Freeze はすべて PASS**。
  設計レビューは完了した。
  以降は kill-point テストと projection 整合テストから得た事実のみを errata として追記する。

## E-01：receipt replay の phase 別分岐

v0.2.3 §1.4 の「`request_sha256` 一致 → `stable_response` を返して終了」は、**finalize のみ**に適用する。
extract replay では、§1.3 のとおり「candidate set 再利用 + 最新 possible_matches + 新 finalize token」が必要になる。
実装順序は次のとおりである。

```typescript
const receipt = findReceipt(submissionId);
if (receipt) {
  assertSameRequestHash(receipt, requestHash);   // 不一致 → IDEMPOTENCY_KEY_REUSED
  if (receipt.phase === "finalize") return receipt.stable_response;
  return rehydrateExtractRuntimeResponse(receipt);
}
// receipt なし → lease / token 検証へ

// rehydrateExtractRuntimeResponse:
//   job が finalized 済み → JOB_ALREADY_FINALIZED（または finalize receipt を返す）
//   lease 有効           → candidate set 再利用 + 最新 possible_matches 再検索 + 新 token 発行
//   lease 失効           → RESUME_REQUIRED
```

あわせて、`ExtractStableResponse` を union 化する。
これにより、0 candidate の replay に finalize token が現れないようにする。

```typescript
type ExtractStableResponse =
  | { state: "merge_decision_required";
      candidates: Array<{ candidate_id: string; candidate: DistilledCandidate }> }
  | { state: "skipped";
      skip_reason: SkipReason;
      withdrawn_evidence_ids: string[];
      staled_knowledge_ids: string[] };
```

## E-02：request_sha256 の対象フィールド

「同じ phase であり、submission_id が異なり、request_sha256 が同じなら replay」とする条件を成立させる。
そのため、**submission_id と平文 token は hash 対象から除外**し、token にはその hash を含める。

```typescript
const requestSha256 = sha256(jcs({
  request_schema_version: 1,
  phase, job_id, lease_generation,
  thread_fingerprint, candidates,          // extract
  candidate_set_sha256, decisions,         // finalize
  lease_token_hash, finalize_token_hash,   // 平文は含めない
}));
```

除外するフィールドは、submission_id と平文 lease_token / finalize_token の二つだけである。
集合配列は、v0.2.3 §5.2 と E-04 の規則に従って事前に sort と dedupe を行う。

この定義では、RESUME 後に新しい token で再 finalize すると request_sha256 が変わるため、**新しい submission_id を使う**。
試行ごとに handle と submission が 1:1 で対応する設計であり、同じ id の使い回しは `IDEMPOTENCY_KEY_REUSED` で拒否される。

## E-03：finalize と元レビュー世代の bind

extract 後に別の ingest がコメント本文だけを編集した場合、comment ID は変わらない。
このため、evidence_comment_ids の部分集合検証を通過してしまう。
`FinalizeContext` に次のフィールドを追加する。

```typescript
type FinalizeContext = {
  token_hash: string; job_id: string; lease_generation: number;
  candidate_set_sha256: string; match_set_digest: string;
  possible_matches: PossibleMatchBinding[]; expires_at: string;
  // 追加
  source_snapshot_id: string;   // provenance のみ（等値判定の主条件にしない）
  content_fingerprint: string;
  distillation_key: string;
};
```

finalize 時は、repo lock 内かつ canonical write 前に、次の順序で検証する。

1. `ensureRecovered()` を実行する。
2. `ensureProjectionCurrent()` を実行する。
3. job が `awaiting_finalize` であることを確認する。
4. 現在の `content_fingerprint` との一致を確認する。
   不一致の場合は `DISTILLATION_SOURCE_CHANGED` を返す。
5. 現在の prompt / schema / trust policy から `distillation_key` を再計算し、一致を確認する。
   不一致の場合は `DISTILLATION_CONTEXT_CHANGED` を返す。
6. match set を再検索し、digest の一致を確認する。
   不一致の場合は `MERGE_CANDIDATES_CHANGED` を返す。

いずれの不一致でも書き込みは行わない。
`source_snapshot_id` は resolved 状態だけが変化した場合にも更新されうるため、判定には使わない。
等値判定には `content_fingerprint` と `distillation_key` を使う。

## E-04：locale に依存しない集合配列の sort 規則

RFC 8785 は配列順序を変更しないため、集合配列の sort はアプリ側で固定する。
localeCompare は ICU に依存するため使用せず、**unsigned UTF-16 code unit の昇順**に統一する。

```typescript
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// v0.2.2 §11 の fingerprint 正規化も置換
normalizedComments.sort((a, b) =>
  compareCodeUnits(a.createdAt, b.createdAt) || compareCodeUnits(a.id, b.id));
```

対象には、少なくとも trustedActorIds、trustedLogins、sources、scope、possible match IDs、candidate IDs、evidence_comment_ids を含める。

## P-01：skip_reason ごとの evidence 撤回ポリシー

このポリシーは M1-C のドメインポリシーである。
v0.2.3 §6.1 の「0 candidate → 旧 evidence withdrawn」は、**definitive non-knowledge に限定**する。
「判断できない」状態まで撤回すると、モデルの一時的な判断不能によって有効ルールが stale 化する。

| skip_reason | 既存 evidence |
|---|---|
| typo / praise_or_chitchat / question_without_conclusion / pr_specific | withdrawn 可（撤回パス：receipt + skipped + withdrawal + stale 判定） |
| insufficient_context | 既存 evidence は**維持**し、manual review 対象としてマーク（receipt + skipped のみ、evidence 不変） |
| duplicate_noise | 重複先 knowledge ID が判明した場合のみ再対応付けし、対象不明なら維持 |

これにより、M1-C の着手前提条件は充足する。

## I-01：M1 の knowledge_file_state

mtime の実精度はプラットフォームに依存するため、path + size + mtime_ns による候補絞りは M1 では採用しない。
M1 では、**read 前に knowledge/*.md 全ファイルの SHA-256 を計算**する。
数百から数千ファイルの規模であれば、実用上の問題はない。
テスト 63「同一 byte size 編集の検出」も、この方式なら自明に通る。

スケール時には、stat tuple を強化し、dev / ino / ctime_ns の追加と定期 full verification へ移行する。
これは推奨 B にあたり、M2 以降で行う。

## 追加受け入れテスト

既存の 54 件に、次のテストを追加する。

55. extract receipt replay が stable response だけで終了せず、新 token と最新 possible_matches を返す。
56. 0 candidate の extract receipt が `state: skipped` として再生され、finalize token を含まない。
57. submission_id だけを変更した同一リクエストで request_sha256 が一致する。
58. 同一 submission_id で decisions を変更すると `IDEMPOTENCY_KEY_REUSED` になる。
59. extract 後に comment 本文を編集して再 ingest すると、旧 finalize が `DISTILLATION_SOURCE_CHANGED` になる。
60. extract 後に prompt または trust policy を変更すると、旧 finalize が `DISTILLATION_CONTEXT_CHANGED` になる。
61. locale 設定を変更しても、集合配列、comment 順、JCS digest が変化しない。
62. insufficient_context による再蒸留で、既存 active evidence が withdrawn にならない。
63. knowledge Markdown を同一 byte size で編集しても、projection 失効を検出する。

## 最終ステータスと着手順

- **Status**：実装開始承認
- **Architecture Gate**：PASS
- **Mutation Path Gate**：PASS
- **Write Path Freeze**：PASS
- **Errata E-01〜E-04**：反映済み
- **P-01 と I-01**：確定

### 着手順

- **M1-A**：即時可。
  kill-point テスト 25、26、44、53 を commit engine より先に作成する。
- **M1-B**：即時可。
- **M1-C**：P-01 が確定済みのため着手可。
- **M1-D**：E-01〜E-03 のテスト 55〜60 を先に作成してから着手する。

### 以降の設計変更

新規レビューループは行わない。
以降は、実装とテストで得た事実のみを errata として本文書へ追記する。
M1-A 完了時に、v0.2 本体、補遺 3 本、本 errata を v0.3 統合仕様書へ再編する。

## M1-A 完了時の実装 Errata

次の項目は設計変更ではなく、M1-A の実装と kill-point テストで確認した事実である。

### F-01：prepared を境界とする kill 後の収束

実プロセスを SIGKILL するテストにより、staged payload 完了後、manifest.tmp 完了後、prepared 完了後、file rename 後、append 後、COMMITTED.tmp 完了後、COMMITTED 完了後、projection 完了後を検証した。
prepared より前の kill は旧 canonical state に収束する。
prepared 以後の kill は recovery によって新 canonical state に収束する。

### F-02：append 済み record と staged payload の関係

同じ record_id と同じ line_sha256 の完全行が target JSONL に存在する場合は、append 適用済みとして収束する。
この場合は、append 後の kill で staged payload が失われていても再適用を必要としない。
target に record がなく staged payload もない場合は、UNRECOVERABLE_TRANSACTION で fail-closed になる。

### F-03：projection と直接編集の検知

reindex は knowledge Markdown と canonical JSONL を変更せず、index.sqlite だけを再構築する。
read 前に knowledge/*.md の全実バイト SHA-256 を計算するため、同一 byte size かつ同一 mtime の直接編集も検知する。

### F-04：repository registry の並行初回登録

異なる二つの repo を並行して初回登録しても、global .registry.lock と exact-byte CAS により repositories.json の両 entry が保持される。
repo rename 後も同じ 32 桁 storage-id を使用し、旧 owner/name は aliases に保持される。

### F-05：確定技術スタックの実装

SQLite 派生投影は better-sqlite3 と WAL を使用する。
knowledge Markdown は完全一致する `---` delimiter と strict YAML parser を使用し、language suffix、duplicate key、無効 schema を fail-closed で拒否する。
