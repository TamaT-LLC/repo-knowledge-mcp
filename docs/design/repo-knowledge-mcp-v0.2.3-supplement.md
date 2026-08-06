# repo-knowledge-mcp 設計補遺 v0.2.3 — Write Path Freeze 最終確定

- Version: 0.2.3（v0.2 / v0.2.1 / v0.2.2 への追補。優先順位: **v0.2.3 > v0.2.2 > v0.2.1 > v0.2**）
- Date: 2026-08-06
- Status: 最終 freeze 条件 4 点を反映 — **Write Path Freeze: PASS**

## 0. v0.2.2 からの差し替え対応表

| v0.2.2 の節 | 本補遺での扱い |
|---|---|
| §4.2 SubmissionReceipt / replay 規則 | §1 で全面差し替え（stable_response / ephemeral handle 分離） |
| §4.3 FinalizeContext | §1.4（receipt-first 順序）、§4（match_set_digest）で改訂 |
| §2.2 dirty marker / ensureProjectionCurrent | §2（knowledge_file_state・直接編集検知）で拡張 |
| v0.2.1 §7.1 EventEnvelope / §9 JSONL 破損 | §3（CanonicalJsonlRecord への統一・復旧手順の固定）で差し替え |
| §1.2–1.4 manifest / recovery | §3.3（record 存在判定の厳密化）、§7（COMMITTED marker）、§8（precondition 再検証）で改訂 |
| §10 distillation_key | §5.3（distillation_input_digest に actor を含める）で改訂 |
| v0.2 §9.1 / v0.2.2 §5 の 0 candidate 処理 | §6 で完全性を確定 |
| v0.2.1 §7.2 / v0.2.2 §5.3 ThreadRemoved | §10（snapshot_id）で判定基準を確定 |
| v0.2 §5 技術スタック | §9（対応 OS の限定）を追加 |

---

## 1. Receipt と ephemeral handle の分離（Blocker 1）

### 1.1 問題

v0.2.2 は「response をそのまま receipt に保存」「token は hash のみ保存」「FinalizeContext は ephemeral」を同時に定めており、両立しない。response をそのまま保存すれば平文 finalize_token が正本 JSONL に残り、保存しなければ extract のレスポンス消失時に同じ token を返せず、返せたとしても再起動後は Context が消えていて使えない。

### 1.2 receipt は「安定部分」のみを保存する

```typescript
type SubmissionReceipt = {
  submission_id: string;
  job_id: string;
  phase: "extract" | "finalize";
  request_sha256: string;
  stable_response: ExtractStableResponse | FinalizeResponse;  // 一時 handle を含めない
  committed_at: string;
};

type ExtractStableResponse = {
  state: "merge_decision_required";
  candidates: Array<{ candidate_id: string; candidate: DistilledCandidate }>;
};
```

実際の extract 応答は stable 部分に一時 handle を**付加して**返す（handle は保存しない）:

```typescript
type ExtractRuntimeResponse = ExtractStableResponse & {
  finalize_handle: { finalize_token: string; lease_generation: number; expires_at: string };
  possible_matches: PossibleMatchSet[];   // 発行のたびに再生成（§4）
};
```

**candidate set の永続化場所は extract receipt の stable_response である**。これにより prepare resume（下表）はサーバー再起動後も candidate を再利用できる。job 投影には `awaiting_finalize` 状態を追加する（extract receipt が存在し finalize receipt が未存在の状態の畳み込み）。

### 1.3 replay 規則

| 状況 | 動作 |
|---|---|
| finalize の同一 submission replay | receipt の stable_response を完全再生 |
| extract の同一 submission replay・lease 有効 | stable_response を再利用し、**新しい** finalize token と最新 possible_matches を発行 |
| extract の同一 submission replay・lease 失効 | `RESUME_REQUIRED` |
| prepare 時に job が awaiting_finalize | extract receipt の candidate set を再利用し、新 lease・新 token・最新 possible_matches を返す（再抽出しない） |
| 同じ phase が別 submission_id で commit 済み・request_sha256 同一 | committed receipt を replay |
| 同じ phase が別 submission_id で commit 済み・request_sha256 相違 | `PHASE_ALREADY_COMMITTED` |

### 1.4 receipt 照合は lease / token 検証より先

```
1. submission_id で receipt 検索
2. request_sha256 一致 → 保存済み stable_response を返す（ここで終了）
3. receipt なし → lease / token 検証へ
```

この順序でないと、成功済み finalize を token 期限切れ後に再送した際、成功結果ではなく STALE_LEASE が返ってしまう。

---

## 2. knowledge_file_state — Markdown 直接編集の失効検知（Blocker 2）

### 2.1 問題

dirty marker を「未削除の committed manifest」に置いたが、人間の直接編集は manifest を作らない。active → rejected の直接変更・scope 変更・ファイル削除後も、get_rules が古い active ルールを返し続ける。ETag は**書き込み競合**の検知であり、**read projection の失効**検知ではない。

### 2.2 仕様（自動差分投影を採用）

```sql
CREATE TABLE knowledge_file_state (
  path TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL UNIQUE,
  byte_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
```

read path（v0.2.2 §2.2 を拡張）:

```typescript
await withRepoLock(repoId, async () => {
  await ensureRecovered();
  await detectKnowledgeFileChanges();       // path+size+mtime_ns で候補を絞り、候補のみ実バイト hash
  await updateChangedKnowledgeProjection();
  return readSnapshot();
});
```

検知対象: 新規 Markdown / 内容変更 / ファイル削除 / ファイル名変更（knowledge_id UNIQUE により path 変更として検出）/ frontmatter の id 変更 / duplicate knowledge ID / repo_id 不一致 / 無効な YAML・schema / 同一ファイル内の duplicate YAML key（strict モードの YAML パーサで検出する）。

変更検知後に parse できない場合は**古い SQLite 結果を返さず** `KNOWLEDGE_STORE_INVALID` で fail-closed（doctor が対象ファイルと理由を提示）。`fs.watch` は最適化としてのみ使用可、正本判定には使わない。

### 2.3 ファイル削除のセマンティクス

直接削除された knowledge は投影から除去され、以後 get_rules / search に現れない。関連 evidence イベントは残り、doctor が orphan として報告する。運用上の推奨は削除ではなく `status: rejected` への編集（履歴・監査が保たれる）。README に明記する。

---

## 3. Canonical JSONL Record Envelope と復旧手順（Blocker 3）

### 3.1 全 canonical JSONL レコードの統一形式

record identity がログごとにバラバラ（event_id / submission_id / 未確定）では、recovery の「record_id が存在するか」を汎用実装できない。すべてを次に統一する（v0.2.1 §7.1 の EventEnvelope はこの形式へ統合）:

```typescript
type CanonicalJsonlRecord<TPayload> = {
  schema_version: 1;
  record_id: string;          // evt_… / obs_… / rcpt_… / snap_…
  record_type: string;        // "SubmissionReceipt" / "EvidenceCreated" / …
  transaction_id: string;
  recorded_at: string;
  payload: TPayload;
};
```

### 3.2 append の実装契約

- `write()` が全 bytes を書くと仮定せず、bytesWritten が全長に達するまでループする
- `target_path` / `staged_path` は絶対パス禁止。repo root 配下の正規化済み relative path のみ（`..`・symlink escape 拒否）

### 3.3 recovery 手順（この順序で固定）

1. target JSONL の末尾を検証
2. 最終行が不完全なら最後の正常な改行位置まで truncate
3. 切り戻した bytes を `.corrupt` へ保存
4. **中間行**に parse error があれば fail-closed（末尾以外の破損は自動修復しない）
5. staged line の line_sha256 を検証（不一致 → 適用しない）
6. staged line を parse し record_id 一致を検証
7. target 内の record_id を **JSON として**検索（文字列 grep ではなく parse 済みレコードの record_id 比較）
8. 未存在なら append + fsync

存在済みの場合も ID だけで成功扱いにしない:

| 状態 | 判定 |
|---|---|
| 同じ record_id + 同じ line_sha256 | 適用済み |
| 同じ record_id + 異なる line_sha256 | `RECORD_ID_CONFLICT`（fail-closed） |

---

## 4. Finalize 時の match set 再検証（Blocker 4）

### 4.1 問題

FinalizeContext の revision / ETag / status 束縛は「既存候補の変更」しか検出できない。並行する Job A / B が同種 candidate をそれぞれ possible_matches 空で extract すると、A の finalize で kn_A が生まれても B は「different → kn_B 新規作成」を通過でき、重複ルールが生成される。

### 4.2 仕様

FinalizeContext に `match_set_digest` を追加し、**finalize 時に repo lock 内で候補検索を再実行**する:

```typescript
// extract 時（発行のたび）
const possibleMatches = union(ftsTopMatches(candidate), previousKnowledgeIdsForThread(threadId));
const matchSetDigest = sha256(jcs(possibleMatches.map(m =>
  ({ knowledge_id: m.id, revision: m.revision, etag: m.etag, status: m.status }))));

// finalize 時（repo lock 内・canonical write 前）
const currentDigest = digestMatchSet(await findPossibleMatches(candidate));
if (currentDigest !== ctx.match_set_digest) {
  return { code: "MERGE_CANDIDATES_CHANGED",
           possible_matches: currentMatches,
           finalize_token: newlyIssuedToken };   // canonical write は一切行わない
}
```

digest 不一致時はホスト側に same / overlaps / different の再判定を求める（新 token・新 digest で再 finalize）。

### 4.3 merge 候補検索の範囲

通常検索（active 固定）と異なり、merge 用候補検索は **active + proposed + 当該 thread の previous evidence 由来の stale** を含める。rejected / deprecated は除外。proposed を検索対象に含めないと、複数 AI レビューから同じ proposed ルールが量産される。

### 4.4 exact duplicate の collapse

同一 candidate set 内で正規化 rule が完全一致する candidate は commit 前に統合する（意味的重複の判定まではサーバーに求めない。exact 一致のみ）。

---

## 5. canonicalJson / hash 仕様の固定（High）

### 5.1 仕様

TS / Rust 間・再起動後の digest 決定性のため、次を永続仕様とする:

```
canonical_json_version: jcs-rfc8785-v1   # RFC 8785 JSON Canonicalization Scheme
encoding: UTF-8
hash: SHA-256
hex: lowercase
表記: `sha256:${hex}`
```

### 5.2 集合配列の事前正規化

JCS は配列順序を変えないため、**意味的に集合である配列は JCS 適用前に sort + dedupe** する: trustedActorIds / trustedLogins / sources / scope（OR 集合）/ possible match IDs / candidate IDs / evidence_comment_ids。会話順など順序に意味がある配列（normalized_comments 等）は保持する。

### 5.3 distillation_input_digest — actor を含める

comment 本文が同一でも actor login / authorAssociation の変化は trust 判定を変えうる。distillation_key の content 成分を content_fingerprint から次の input digest に置き換える（content_fingerprint 自体は thread 変化検知・evidence 用として従来どおり）:

```typescript
const distillationInputDigest = sha256(jcs({
  thread_id, path,
  normalized_comments,        // §11（v0.2.2）の正規化・ソート済み
  normalized_actors,          // actor_id / login / actor_kind / provider / trust / authorAssociation
  repository_context,         // 言語構成等、プロンプトへ渡す repo 情報
}));

const distillationKey = sha256(jcs({
  distillation_input_digest: distillationInputDigest,
  prompt_digest, output_schema_digest, trust_policy_digest,
}));
```

---

## 6. 0 candidate の完全性と finalize 検証（High）

### 6.1 0 candidate は「skip + 撤回処理」を単一 transaction で行う

candidates が 0 件の extract は finalize 不要だが、単なる job skipped ではない。**同一 canonical transaction** で次をすべて行う:

1. extract receipt 追加
2. DistillationJobSkipped 追加
3. 当該 thread の旧 active evidence を withdrawn
4. evidence_count 再計算（投影）
5. 必要なら knowledge を stale へ遷移
6. SQLite 投影更新

これを欠くと、撤回されたレビュー由来のルールが active のまま残る。

### 6.2 finalize の完全性検証

- 部分的な decisions を受け入れない: **submitted candidate_id 集合 == extract 時 candidate_id 集合** を必須とする
- `same` / `overlaps` → target_id 必須、`different` → target_id 禁止
- target_id は possible_matches に含まれること
- candidate_id の重複禁止、decision の不足・余分の禁止
- evidence_comment_ids は対象 thread の**現在の complete snapshot** に存在する comment ID の部分集合であることをサーバーが検証
- **originator / actors / sources / trust はモデル出力を信用せず、サーバーが comment ID から導出する**

---

## 7. COMMITTED marker — committed 遷移の耐久化（High）

manifest.json の state 書き換え自体が破損しうるため、**manifest は prepared 後 immutable** とし、commit 完了は marker ファイルで表す:

```
transactions/txn_<ULID>/
├── manifest.json       # prepared 後は変更しない
├── COMMITTED           # commit 完了 marker
└── staged/
```

```json
{ "schema_version": 1, "transaction_id": "txn_01…", "manifest_sha256": "sha256:…", "committed_at": "…" }
```

手順: `COMMITTED.tmp` へ書く → fsync → `COMMITTED` へ rename → transaction directory を fsync。

hash 検証の義務化: staged file の実 hash == new_sha256 / staged append line の実 hash == line_sha256 / COMMITTED の manifest_sha256 == manifest 実 bytes を**適用前に必ず**検証する。target ファイルへの rename 後は **target の親ディレクトリも fsync** する。

---

## 8. CAS の保証範囲 — commit 区間中の外部編集（High）

外部エディタは repo lock を取得しないため、「precondition 検証 → stage → 人間が編集 → rename」の TOCTOU 窓は lock だけでは閉じられない。次を仕様・README に明記する:

- ETag は「更新**開始前**に存在した編集」を確実に検知する
- canonical transaction の commit 区間中に行われた外部直接編集は、完全な atomic CAS の保証対象外
- 直接編集は transaction 実行中を避ける（commit 区間は短い）
- **file precondition は stage 完了後・適用直前にも再検証**し（stage 作成 → 最終 precondition 再検証 → prepared 永続化 → 即座に適用）、競合窓を最小化する

---

## 9. 対応 OS の限定（High）

本設計は chmod 600/700・directory fsync・PID ベース lock・atomic rename・POSIX 的 append・symlink containment に依存する。M1 の保証範囲:

```
Supported OS: macOS / Linux
Supported storage: ローカルファイルシステム
保証対象外: NFS / SMB / Dropbox / iCloud 等の同期領域
```

```json
{ "os": ["darwin", "linux"] }
```

Windows 対応は lock・rename・権限・耐久性の個別テストを整備した M2 以降。

---

## 10. Complete snapshot の識別子（High）

ThreadRemoved 判定には「同一 PR の 2 つの完全 snapshot」の識別が必要:

```typescript
type PullRequestSnapshot = {
  snapshot_id: string;          // snap_<ULID>
  repo_id: string;
  pr_number: number;
  complete: true;               // partial / エラー時は snapshot record 自体を作らない
  thread_ids: string[];
  review_summary_ids: string[];
  observed_at: string;
};
```

各 thread / comment observation にも snapshot_id を持たせる。removed threads = previous complete snapshot の thread_ids − current complete snapshot の thread_ids。GraphQL partial response・pagination 途中失敗では complete snapshot record を作らない（判定が構造的に安全になる）。

---

## 11. 追加受け入れテスト（既存 38 件に追加）

39. extract receipt に平文 finalize token が保存されない
40. extract 成功後にプロセスを再起動し、prepare resume から新 token で finalize できる
41. finalize receipt replay は token 期限切れ後も同じ結果を返す
42. Markdown を直接 active → rejected へ変更すると、次の get_rules で古い active 結果を返さない
43. Markdown に duplicate ID または無効 YAML がある場合、古い SQLite を返さず fail-closed になる
44. JSONL の途中で部分 append して kill した後、末尾修復 → 完全行再 append で復旧する
45. 同じ record_id で異なる line hash が存在する場合、RECORD_ID_CONFLICT になる
46. staged append の line hash が不一致なら適用しない
47. extract 後、別 job が同種ルールを新規作成した場合、finalize が MERGE_CANDIDATES_CHANGED になる
48. candidates が 0 件の再蒸留で旧 evidence が withdrawn になる
49. finalize の decision 不足・重複・余分な candidate ID を拒否する
50. evidence_comment_ids に対象 thread 外の ID がある場合に拒否する
51. JSON object の key 順を変えても JCS digest が同一になる
52. set 扱いの config 配列順を変えても trust policy digest が同一になる
53. prepared manifest 完成後、COMMITTED marker 作成途中で kill しても回復する
54. GraphQL 取得順・actor login 表記変化・authorAssociation 変化について期待どおり distillation key が変化する

## 12. 実装ステータス

```
Status: 実装開始承認
Architecture Gate: PASS
Mutation Path Gate: PASS
Write Path Freeze: PASS（本補遺 4 条件の反映をもって確定）

実装解禁の順序:
  即時: domain schema / directory layout / Markdown reader（§2 の検知含む）/
        JSONL parser（§3 エンベロープ）/ SQLite projector（knowledge_file_state 含む）/
        GraphQL client（§10 snapshot）/ trust normalization / lock / staging
  §3・§7 反映後: canonical commit engine / recovery engine
  §1・§4 反映後: submit extract / finalize commit
```

以降の設計変更は、実装中に発見された事実に基づく errata として本補遺群へ追記し、M1-A 完了時点で v0.2 本体 + 補遺 3 本を単一の v0.3 統合仕様書へ再編する。
