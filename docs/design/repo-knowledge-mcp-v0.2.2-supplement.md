# repo-knowledge-mcp 設計補遺 v0.2.2 — Write Path 最終補正（freeze）

- Version: 0.2.2（v0.2 + v0.2.1 への追補。矛盾時は **v0.2.2 > v0.2.1 > v0.2** の順で優先）
- Date: 2026-08-06
- Status: **write path freeze**。本補遺の反映をもって canonical writer / recovery engine / submit finalize commit の実装に着手可

## 0. v0.2.1 からの差し替え対応表

| v0.2.1 の節 | 本補遺での扱い |
|---|---|
| §1.2–1.4 transaction manifest / recovery | §1 で全面差し替え（staged append payload・fail-closed） |
| §1.3 コミットプロトコル | §1.3 + §2（read isolation）で改訂 |
| §1.4 projection_meta / index_dirty | §2.2（dirty marker は committed manifest が第一）で改訂 |
| §3.2–3.3 submit / lease | §4（submission_id・receipt・token binding）で強化 |
| §4.2 KnowledgeEvidence | §6（originator / actors / sources[]）で改訂 |
| §4.3 撤回 | §5（再対応付け union・collapse・ThreadRemoved）で具体化 |
| §4.5 distillation_key | §10（digest 方式）で差し替え |
| §5.2 ETag | §7（実バイト列 hash）で差し替え |
| §5.2 evidence 追加の CAS 経路 | §8（Markdown 非依存化）で差し替え |
| §2.5 脅威モデル / §2.2 approve --yes | §9 で表現修正・M1 方針確定 |
| §4.1 fingerprint | §11（決定性・per-comment diffHunk）で改訂 |
| §8.2 SQL 例 | `k.repo = ?` → `k.repo_id = ?`（§3.4） |
| v0.2 §6.2 / v0.2.1 §0 の frontmatter | §8.2 の canonical フィールド確定リストで最終化 |

---

## 1. Staged Append Payload — トランザクションの再生可能性（Blocker 1・最優先）

### 1.1 問題

v0.2.1 の manifest は `event_appends` に `payload_sha256` しか持たない。「prepared → md rename → event append 前にクラッシュ」で、append すべきイベント**本文**が失われ、hash からは復元できない。また対象ログが 3 種の enum に固定されており、raw/*.jsonl・KnowledgeRevisionProposal・submissions（§4）等の正本書き込みを表現できない。

### 1.2 transaction ディレクトリと汎用 manifest

```
transactions/
└── txn_<ULID>/
    ├── manifest.json
    └── staged/
        ├── files/            # 0001.new, 0002.new …（rename 対象の完成形）
        └── appends/          # 0001.jsonl …（append する完成済み JSONL 1 行、改行含む）
```

```typescript
type CanonicalTransaction = {
  schema_version: 1;
  transaction_id: string;
  state: "prepared" | "committed";
  preconditions: Array<{ path: string; expected_sha256: string | null }>;
  file_writes: Array<{
    target_path: string;
    staged_path: string;
    new_sha256: string;
    ordinal: number;
  }>;
  append_records: Array<{
    target_path: string;        // 任意の正本 JSONL（enum 固定をやめる）
    record_id: string;          // evt_… / obs_… / rcpt_…
    staged_path: string;        // ← 再生の正本。payload 実バイト列を必ず残す
    line_sha256: string;        // 改行を含む実バイト列の hash
    ordinal: number;
  }>;
  created_at: string;
  committed_at?: string;
};
```

### 1.3 prepared へ進める条件（この順で全完了後にのみ prepared）

1. 全 file_writes の staged file 作成・fsync
2. 全 append_records の staged JSONL 行作成・fsync
3. manifest.tmp 作成・fsync
4. manifest.json へ atomic rename
5. `transactions/txn_<ULID>/` ディレクトリを fsync

以降のコミットは v0.2.1 §1.3 の 5–10（rename → append → committed → SQLite → checkpoint → cleanup）。

### 1.4 recovery 判定

**file_writes**（3 状態）:

| target の現状 | 処理 |
|---|---|
| hash == new_sha256 | 適用済み（スキップ） |
| hash == expected_sha256 | staged file から適用 |
| それ以外 | `RECOVERY_CONFLICT` |

**append_records**:

| 状態 | 処理 |
|---|---|
| record_id が target JSONL に存在 | 適用済み |
| 存在しない | staged_path の実バイト列を append |
| staged_path も存在しない | `UNRECOVERABLE_TRANSACTION` |

### 1.5 fail-closed

`RECOVERY_CONFLICT` / `UNRECOVERABLE_TRANSACTION` が残る repo は、**doctor と復旧用 CLI 以外のすべての read / write を拒否**する（MCP ツールはエラーで復旧手順を案内）。中途半端な状態で通常運転を続けない。

---

## 2. Read Isolation（Blocker 2）

### 2.1 問題

writer が「md rename 済み・events 未 append・SQLite 未更新」の間に get_rules / get_knowledge / search_knowledge が走ると、新旧混在の snapshot を観測できる。

### 2.2 M1 の仕様

ローカルツールで commit 区間が短く、LLM 呼び出しはロック外のため、**read も同じ repo lock を取得**する。

```typescript
await withRepoLock(repoId, async () => {
  await ensureRecovered();          // 未完了 txn があれば §1.4 を先に実行
  await ensureProjectionCurrent();  // committed & checkpoint 未反映なら投影更新
  return readSnapshot();
});
```

確定事項:

- canonical read は未完了 transaction が存在しない状態でのみ行う
- read tool も commit 区間と同じ repo lock を取得する
- committed manifest が SQLite checkpoint へ未反映なら、read 前に projection を更新する
- projection 更新に失敗した場合、**古い SQLite 結果を返さない**（エラーを返す）
- **dirty marker の第一情報源は「未削除の committed manifest」**とする（SQLite 内の index_dirty は補助。SQLite 自体が破損・書き込み不能のケースを覆えないため）
- manifest の削除 / アーカイブは、SQLite transaction と checkpoint の**両方**が完了した後に限定する

---

## 3. Registry のグローバルロックと repo_id 一貫性（Blocker 3）

### 3.1 問題

repo ごとの .write.lock では repositories.json への同時初回登録（A: izanagi 登録 ∥ B: fern 登録）を保護できず、read-modify-write の競合で片方の登録が失われる。

### 3.2 仕様

```
~/.repo-knowledge/
├── .registry.lock          # registry 専用グローバルロック
├── repositories.json
└── repos/<storage-id>/
```

- registry の作成・rename 検知・alias 更新 → `.registry.lock` + **exact-byte CAS**（読んだ時点のファイル bytes hash を precondition に、atomic rename で書き戻す）
- repo 内部の更新 → `repos/<storage-id>/.write.lock`
- **原則として両ロックを同時に保持しない**。保存先は repo ID から決定論的に導けるため、registry 更新と repo 書き込みは別の冪等処理に分ける
- 同時取得が避けられない場合のロック順は `1. .registry.lock → 2. repo .write.lock` に固定。逆順は禁止

### 3.3 storage-id

```typescript
const storageId = sha256(repoNodeId).slice(0, 32);  // 16 hex は不足。32 hex 以上または full SHA-256
```

### 3.4 SQLite / 検索の repo_id 化

knowledge / evidence / raw_comments / distill_jobs の結合・フィルタは mutable な `repo` 名ではなく **`repo_id`** を使う。v0.2.1 §8.2 の例は次に差し替え:

```sql
WHERE knowledge_fts MATCH ?
  AND k.repo_id = ? AND k.status = 'active'
```

`repo` 名は表示用として保持する。

---

## 4. Submit の冪等性と token binding（Blocker 4）

### 4.1 問題

lease fencing は「古い worker の commit」を防ぐが、「**finalize commit 成功 → MCP レスポンス消失 → クライアントが同一 finalize を再試行**」を扱えない。単に STALE_LEASE や job already done を返すと、クライアントは 1 回目の成否を判別できず、再実行すれば evidence / proposal が二重作成されうる。

### 4.2 submission_id と receipt

各 submit に必須の冪等キーを追加する:

```typescript
submit_distillation({ phase: "extract",  submission_id, job_id, lease_token, lease_generation, thread_fingerprint, candidates });
submit_distillation({ phase: "finalize", submission_id, job_id, lease_token, lease_generation, finalize_token, decisions });
```

```typescript
type SubmissionReceipt = {
  submission_id: string;
  job_id: string;
  phase: "extract" | "finalize";
  request_sha256: string;
  response: unknown;            // 返却した structuredContent をそのまま保存
  committed_at: string;
};
```

処理規則:

| 条件 | 応答 |
|---|---|
| 同じ submission_id + 同じ request_sha256 | 保存済み response をそのまま返す（replay） |
| 同じ submission_id + 異なる request_sha256 | `IDEMPOTENCY_KEY_REUSED` |
| 同じ phase が別 submission_id で commit 済み | 保存済み結果を返す、または `PHASE_ALREADY_COMMITTED` |

**receipt の保存先は `events/submissions.jsonl`（正本）とし、finalize が生む evidence / proposal / job イベントと同一の canonical transaction の append_records に含める。** これにより「commit 成功 → receipt 保存前クラッシュ → 再試行で二重作成」の隙間が構造的に消える（§1 の汎用 append_records がこれを可能にする）。extract の receipt も同様に、FTS 検索結果を含む response とともに同一 txn で記録する。

### 4.3 FinalizeContext と検証

```typescript
type FinalizeContext = {
  token_hash: string;               // token は暗号学的乱数。保存は hash のみ
  job_id: string;
  lease_generation: number;
  candidate_set_sha256: string;
  possible_matches: Array<{ knowledge_id: string; revision: number; etag: string; status: string }>;
  expires_at: string;
};
```

finalize 時の検証（すべて必須）:

1. `target_id` が possible_matches に存在する
2. candidate 集合が extract 時から不変（candidate_set_sha256 一致）
3. 対象 knowledge の revision / ETag / status が extract 時から不変 — 変化していれば `MERGE_TARGET_CHANGED` を返し possible_matches を再生成
4. lease_generation が現在値と一致（不一致 → `STALE_LEASE`）
5. token が期限内
6. token が未使用、または同一 submission の再試行（receipt replay）

FinalizeContext は**プロセスメモリ上の ephemeral 状態**でよい（expires_at 付き）。サーバー再起動で失われた場合、finalize は `UNKNOWN_FINALIZE_TOKEN` を返し再 prepare を促す — その時点で何も commit されていないため安全。永続が必要なのは receipt のみ。

### 4.4 token 生成

`lease_token` / `finalize_token` は予測可能な ULID ではなく**暗号学的乱数**（`crypto.randomBytes(32)` 相当）で生成し、保存時は hash 化する。opaque・有効期限付きの handle として扱う。

---

## 5. Evidence の再対応付け・collapse・ThreadRemoved（High）

### 5.1 再蒸留時の候補集合

「以前の candidate との対応が消えた」を判定するには、旧 evidence が結び付いていた knowledge を**FTS 順位に関係なく必ず** merge 候補へ含める:

```typescript
possibleMatches = union(
  ftsTopMatches(candidate),
  previousKnowledgeIdsForThread(threadId),   // 常に含める
);
```

全 candidate の finalize 後:

- 旧 active evidence の knowledge_id が新 candidate の same 判定で再確認された → 旧 evidence を `superseded` にし新世代 evidence を active 化
- 再確認されなかった → `withdrawn`（→ v0.2.1 §4.3 の stale 遷移判定へ）

### 5.2 collapse — 同一 thread × 同一 knowledge は active evidence 1 件

同じ thread の複数 candidate が同じ knowledge へ same 判定された場合、一意制約（knowledge_id, thread_id, status=active）に抵触するため commit 前に統合する: comment_ids を和集合、confidence 等は監査情報として candidate イベント側に残す。**active evidence は 1 件だけ。**

### 5.3 ThreadRemoved

レビューコメントは削除されうる。**完全取得済み snapshot 同士の比較**で:

- previous complete snapshot に存在 ∧ current complete snapshot に不在 → `ThreadRemoved` 観測イベント → 当該 thread の active evidence を `withdrawn`
- 部分取得・GraphQL error 時には削除判定を行わない（v0.2.1 §7.2 の原則を維持）

---

## 6. EvidenceActor — source の複数主体化（High）

thread には複数人・複数 bot が返信する（例: Greptile が指摘 → trusted human が補足・承認）。単一 `source` では表現できないため:

```typescript
type EvidenceActor = {
  comment_id: string;
  actor_id?: string;            // GraphQL actor node ID（login rename 耐性）
  login?: string;
  actor_kind: "user" | "bot" | "unknown";
  provider: "human" | "devin" | "greptile" | "bugbot" | "other";
  trust: "trusted" | "untrusted" | "unknown";
};

type KnowledgeEvidence = {
  // …v0.2.1 §4.2 の項目に加えて
  originator: EvidenceActor;    // thread 先頭コメントの actor
  actors: EvidenceActor[];      // evidence_comment_ids に含まれるコメントの actor 集合
  sources: Array<"human" | "devin" | "greptile" | "bugbot" | "other">;  // actors から導出
};
```

将来 auto-activate を有効化する条件は「thread 参加者に trusted human がいる」ではなく「**evidence_comment_ids 内に trusted human のコメントがある**」とする。

---

## 7. ETag は実ファイルバイト列の hash（High）

canonicalize 後の hash では frontmatter の並べ替え・空白改行編集・YAML コメント追加・表記調整といった直接編集を検知できない。CAS の目的は「人間が編集した実ファイルの保護」であるため:

```typescript
const etag = sha256(await fs.readFile(knowledgePath));  // 実バイト列
```

`semantic_etag` を別途持つのは可だが、**CAS の precondition には使用しない**。

YAML 書式について M1 では次を仕様化する: 「ツール経由の更新は frontmatter を再 serialize するため、YAML コメント・キー順序・引用スタイルは保持されない」。CST 保持パーサの導入は将来課題として README に明記（人間編集の主対象は本文 Markdown であり、frontmatter の書式喪失は許容範囲と判断）。

---

## 8. Evidence 追加の Markdown 非依存化と frontmatter スリム化（High）

### 8.1 問題

evidence の正本はイベントログなのに、追加を Markdown CAS 経路に通すと、人間が本文を編集した直後の正当な evidence 取り込みが ETag conflict で失敗する。ingest のたびに md 差分も発生し、git 共有時のノイズになる。

### 8.2 仕様（推奨案を採用）

**自動的な evidence 追加では knowledge Markdown を変更しない。** `EvidenceCreated` イベントの append + projection 更新のみ行い、get_rules / get_knowledge は events 由来の値を structuredContent で合成して返す。

frontmatter の canonical フィールドを次に**確定**する（高頻度派生値を除外）:

```yaml
schema_version: 1
id: kn_01J4…
repo_id: R_kgDO…
rule: "…"
category: error-handling
scope: ["src/ipc/**"]
severity: should
status: active            # proposed | active | stale | deprecated | rejected
activation: { origin: automatic | human, pinned: false }
related_ids: []           # この文書側から張る片方向参照のみ（逆方向は projection で合成）
revision: 2
origin: { type: distilled, prompt_version: …, prompt_digest: …, output_schema_version: …, output_schema_digest: …, trust_policy_digest: …, provider: …, model: … }
last_automatic_update: { transaction_id: txn_…, at: … }
created_at: …
updated_at: …
```

**frontmatter に置かないもの**（events / projection から合成）: `evidence_count` / `violation_count` / `applied_count` / `sources` / `representative_evidence`。

`reconcile --write-derived-metadata` は「git 共有向けに派生値スナップショットを明示的に書き込みたい場合」の任意操作として残す（通常の ingest では一切書かない）。related_ids は finalize の overlaps 判定時、**新規作成される proposed 文書側にのみ**書き、既存 active 文書の md には触れない。

利点: evidence 追加が人間編集と競合しない / ingest ごとの md 差分ゼロ / canonical transaction の file_writes が減り簡素になる。

---

## 9. Admin plane の位置づけ修正と M1 の選択（High）

表現を次に確定する:

> MCP plane / admin plane 分離は、**MCP tool 経由の権限昇格を防ぐ運用境界**である。同一 OS ユーザーとして任意 shell 実行・ファイル書き込みが可能なエージェントに対する**セキュリティ境界ではない**。

M1 は**安全優先**を採用する:

- `approve` / `reject` / `add --active` に `--yes` を**提供しない**。実 TTY での対話操作のみ
- SECURITY.md に上記の境界定義と、同一ユーザー shell からの迂回可能性を明記
- `--yes` の導入（cron 等での一括承認）は、エージェント側で `~/.repo-knowledge` と admin CLI を deny 設定できることを確認したうえで M2 以降に再検討

---

## 10. distillation_key は version 文字列ではなく digest（High）

version の上げ忘れで再蒸留が発火しない事故を防ぐため、job 一意性には**実内容の digest** を使う。表示・監査用の version は provenance に併記する（§8.2 の origin ブロック）。

```typescript
const promptDigest       = sha256(await fs.readFile("prompts/distill.md"));
const outputSchemaDigest = sha256(canonicalJson(outputSchema));
const trustPolicyDigest  = sha256(canonicalJson(effectiveRepoTrustPolicy));  // repo 単位の実効値

const distillationKey = sha256(canonicalJson({
  content_fingerprint,
  prompt_digest: promptDigest,
  output_schema_digest: outputSchemaDigest,
  trust_policy_digest: trustPolicyDigest,
}));
// job 一意性 = thread_id + distillation_key（v0.2.1 §4.5 の定義を置換）
```

## 11. fingerprint の決定性（High）

GraphQL connection の返却順に暗黙依存しない。生成前に正規化・明示ソートを行い、diffHunk は thread 単位ではなく**各コメントの正規化データに含める**:

```typescript
const normalizedComments = comments
  .map(c => ({
    id: c.id,
    body: normalizeLf(c.body),
    diffHunk: c.diffHunk ? normalizeLf(c.diffHunk) : undefined,
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
  }))
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

const contentFingerprint = sha256(canonicalJson({ threadId, path, comments: normalizedComments }));
```

## 12. 追加受け入れテスト（既存 24 件に追加）

25. prepared 後・event append 前に kill しても、staged append payload から完全復旧する
26. staged append payload が欠損している場合、通常起動せず UNRECOVERABLE_TRANSACTION（fail-closed）になる
27. commit 途中に read を実行しても、新旧が混在した snapshot を観測しない
28. 異なる 2 リポジトリを同時初回登録しても repositories.json の両方が保持される
29. finalize 成功後にレスポンスを破棄し、同一 submission を再試行すると同一 receipt が返る
30. 同じ submission_id へ異なる payload を送ると IDEMPOTENCY_KEY_REUSED になる
31. extract 後に merge 対象 knowledge を編集すると finalize が MERGE_TARGET_CHANGED になる
32. 完全 PR snapshot から thread が消えた場合、旧 evidence が withdrawn になる
33. 同じ thread の複数 candidate が同一 knowledge へ same 判定されても active evidence は 1 件だけ
34. 人間が Markdown 本文を編集していても、新しい evidence event は正常に記録される
35. prompt 内容を変更して version を据え置いても digest 変化により redistill 対象になる
36. repositories.json 更新と repo write を並行しても deadlock しない
37. 未解決 prepared transaction がある間、get_rules が古い SQLite 結果を返さない
38. comment の GraphQL 返却順が変化しても content fingerprint が変わらない

## 13. 実装ステータス

```
Status: 実装開始承認 / write path freeze（本補遺反映済み）
Architecture Gate: PASS
Mutation Path Gate: PASS（v0.2.1 の基本設計 + 本補遺 4 補正）

着手可能（freeze 非依存）:
  domain schema / directory layout / Markdown reader / event parser /
  SQLite projection / GraphQL client / trust normalization

freeze 反映後に実装:
  canonical commit engine（§1）/ recovery engine（§1.4–1.5, §2）/
  registry writer（§3）/ submit extract・finalize commit（§4）
```
