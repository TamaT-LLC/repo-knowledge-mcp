# repo-knowledge-mcp 設計補遺 v0.2.1 — Mutation Path 仕様の確定

- Version: 0.2.1（v0.2 への追補。本補遺と v0.2 本体が矛盾する場合は**本補遺が優先**）
- Date: 2026-08-06
- Status: **実装開始承認** / Architecture Gate: 通過 / Mutation Path Gate: 本補遺で確定 → **write path freeze**
- 実装順序: §10 の M1-A から着手可

## 0. v0.2 本体からの差し替え対応表

| v0.2 の節 | 本補遺での扱い |
|---|---|
| §6.1 ストレージレイアウト | §1（transactions/）、§6（registry / repos/）、§7（raw/ 3 分割）で改訂 |
| §6.2 frontmatter | §4.4（status に stale 追加、activation ブロック）、§5.3（distillation → origin + last_automatic_update）で改訂 |
| §6.3 evidence モデル | §4.2 で全面差し替え |
| §6.5 SQLite | §1.4（projection_meta）、§4.2（partial unique index）、§8.2（FTS 更新方式）を追加 |
| §7.4 update_knowledge / §7.5 revision | §2（admin plane 分離）、§5（ETag CAS）で改訂 |
| §8.3 thread fingerprint | §4.1（content / state 分離）で差し替え |
| §9.4 マージ | §2.4（自動実行範囲の限定）で改訂 |
| §10.2 prepare/submit | §3（2 フェーズ化 + lease fencing + 送信同意）で全面差し替え |
| §11.3 初期 status | §2.3（M1 は autoActivate 無効）で改訂 |
| §13 検索 | §8（実装細則）を追加 |
| §15 同時実行 | §1（トランザクション）、§9（lock 細則）で強化 |
| §16 CLI | approve / reject / edit / redistill / reconcile を追加 |
| §19 M1 | §10（M1-A〜D 分割）、§11（受け入れテスト +12）で改訂 |

---

## 1. Canonical Transaction Journal（Gate 1: 正本間のコミット原子性）

### 1.1 問題

atomic write は 1 ファイル単位であり、knowledge/*.md と events/*.jsonl は**いずれも正本**である。「md 更新成功 → evidence append 前にクラッシュ」で正本同士が矛盾し、SQLite 再構築では復旧できない。

### 1.2 transaction manifest

```
<repo>/transactions/txn_<ULID>.json
```

```typescript
type CanonicalTransaction = {
  schema_version: 1;
  transaction_id: string;                 // txn_<ULID>
  state: "prepared" | "committed";
  preconditions: Array<{ path: string; expected_sha256: string | null }>; // null = 新規作成
  file_writes: Array<{ path: string; staged_path: string; new_sha256: string }>;
  event_appends: Array<{
    log: "distillation" | "evidence" | "outcomes";
    event_id: string;
    payload_sha256: string;
  }>;
  created_at: string;
  committed_at?: string;
};
```

### 1.3 コミットプロトコル（全書き込み経路が必ず通る）

1. writer lock 取得
2. preconditions の現在ファイル hash を検証（不一致 → 中止、CONFLICT）
3. 変更後 Markdown を一時ファイルへ stage
4. manifest を `state: "prepared"` で書き、fsync
5. staged → 本パスへ rename
6. event_id 付きイベントを各 JSONL へ append（fsync）
7. manifest を `state: "committed"` へ更新
8. SQLite を 1 トランザクションで投影更新
9. projection_meta の checkpoint 更新
10. lock 解放（成功した manifest は削除またはアーカイブ）

**正本コミットが先、SQLite が後。** 8–9 に失敗しても正本はロールバックせず、`index_dirty = true` として次回起動または read 前に再投影する。

### 1.4 起動時リカバリと projection_meta

- `prepared` かつ未 committed の manifest → event_id と file hash を照合し、**不足している操作だけを冪等に再実行**して committed へ進める（rename 済みかは new_sha256 で判定、append 済みかは event_id で判定）
- `committed` だが checkpoint 未反映 → SQLite 投影のみ再実行

```sql
CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version / last_committed_transaction_id / canonical_digest / index_dirty
```

### 1.5 reindex は正本を変更しない

| コマンド | 役割 |
|---|---|
| `reindex` | 正本を**一切変更せず** SQLite だけ再構築 |
| `doctor` | 不整合（counts と events の乖離等）を報告のみ |
| `reconcile --write-derived-metadata` | 明示操作として counts 等を Markdown へ書き戻す（§1.3 の経路で） |

v0.2 §6.2 の「reindex が frontmatter を修正」は撤回。git 共有時に reindex が不要な Markdown 差分を生まないことを保証する。

---

## 2. Mutation 境界 — MCP plane と admin plane の分離（Gate 2）

### 2.1 原則

MCP tools は model-controlled なインターフェースであり、**ツールを呼んだ主体を「人間」とは扱えない**。PR コメント由来のインジェクションでエージェントが承認系操作を実行しうるため、承認は MCP の外（CLI / TTY）に置く。

### 2.2 権限表

| 操作 | MCP plane | admin plane（CLI） |
|---|---|---|
| add_knowledge | **常に proposed** で登録 | `add --active` 可（TTY 確認付き） |
| update_knowledge | proposed の**編集提案のみ**。status の active 化不可。active ルール本文・scope・severity の直接変更不可 | `edit <id>` で可（ETag CAS 経由） |
| status 遷移（→active / →rejected） | **不可** | `approve <id>` / `reject <id>` |
| search_knowledge / get_rules | **active 固定**（status 引数を公開しない。proposed は返さない） | `list --status proposed` で棚卸し |
| submit_distillation 由来ルール | 原則 proposed | — |

`approve` は対話 TTY を既定とし、非対話実行は明示的な `--yes` を要求。承認時に表示する項目: ルール本文 / severity / scope / 根拠レビュー（URL）/ source と trust / distillation origin / 既存ルールとの関係（related_ids・possible matches）。

### 2.3 M1 の既定は自動 active なし

quality gate の閾値が未計測の段階で自動 active を許すべきではない。

```json
{ "trust": { "autoActivateTrustedHuman": false } }
```

M1 では手動 `add --active` を除き**すべて proposed から開始**する。最初の実 PR 10 件を人間が確認し、precision が十分と判断してから opt-in で有効化する（v0.2 §11.3 の初期 status 表は、この opt-in 後の挙動として読む）。

### 2.4 same マージの自動実行範囲（trust laundering 防止）

AI 由来 candidate が既存 active ルールと same 判定されることで active 本文・scope・severity を書き換えられてはならない。

| 操作 | 扱い |
|---|---|
| evidence 追加 / source 観測記録 / representative_evidence 更新 | 自動実行可 |
| rule 本文変更 / detail 変更 / scope 追加 / severity 変更 | **提案止まり** — `KnowledgeRevisionProposal` イベントとして保存し、人間承認（`approve-revision <id>`）後に §1.3 経路で反映 |

### 2.5 脅威モデル（README / SECURITY.md に明記）

- **防ぐもの**: 未知 bot・外部コントリビューター・PR 本文からの永続的ナレッジ汚染、エージェントによる偶発的な承認・改稿
- **防がないもの**: 同一 OS ユーザー権限を奪取したプロセス、`~/.repo-knowledge` を直接改変できる悪意あるローカルホスト（ファイル権限は §9 で緩和するが境界にはならない）

---

## 3. Host-assisted 蒸留 — 2 フェーズ submit・lease fencing・送信同意（Gate 3）

### 3.1 問題

v0.2 の prepare は candidate 生成前に similar_rules を返しており、candidate に対する正確な類似検索になっていない。また Provider 無効環境では same/overlaps/different を判定する LLM がサーバー側に存在しない。さらに host-assisted はホストモデル（多くはクラウド）へレビュー本文と diff を渡すため、「クラウド送信は Provider Adapter の opt-in のみ」という v0.2 の説明と矛盾する。

### 3.2 プロトコル（prepare → submit×2）

```typescript
prepare_distillation({ repo, limit?: number /* default 1 */ })
→ { jobs: [{
     job_id: string;
     lease_token: string;
     lease_generation: number;
     expires_at: string;
     thread_fingerprint: string;      // = content_fingerprint（§4.1）
     comments: CommentData[];
     diff?: string;                    // includeDiffHunk=true の場合のみ
     path?: string;
     output_schema: object;
   }] }

// フェーズ 1: 抽出結果の提出
submit_distillation({
  phase: "extract",
  job_id, lease_token, lease_generation, thread_fingerprint,
  candidates: DistilledCandidate[];
})
→ {
  state: "merge_decision_required";
  finalize_token: string;
  candidates: Array<{
    candidate_id: string;
    candidate: DistilledCandidate;
    possible_matches: ExistingKnowledgeSummary[];  // candidate に対する FTS 検索結果
  }>;
}

// フェーズ 2: マージ判定の提出
submit_distillation({
  phase: "finalize",
  job_id, lease_token, lease_generation, finalize_token,
  decisions: Array<{
    candidate_id: string;
    relation: "same" | "overlaps" | "different";
    target_id?: string;               // same / overlaps の対象
  }>;
})
→ { accepted, merged_evidence, created_proposed, revision_proposals, rejected_reason? }
```

candidates が 0 件（skip_reason あり）の場合、extract で完結し finalize は不要。same 判定でも §2.4 により本文改稿は revision proposal になる。host-assisted 由来の新規ルールは常に proposed。

### 3.3 lease fencing

`lease_expires_at` だけでは「A がタイムアウト → B が再取得して処理 → 遅れて A が commit」を防げない。job ごとに `lease_generation` を単調増加で発行し、**commit（各 submit）時に現在の generation と一致しなければ `STALE_LEASE` で拒否**して再 prepare を促す。fingerprint 一致確認は fencing の代替にならない（同一 fingerprint でも A/B の二重 commit が起こるため）。

### 3.4 送信同意の分離

「API キーレス」と「クラウド非送信」は別概念である。host-assisted 用に独立した opt-in を設ける。

```json
{
  "llm": { "mode": "disabled", "allowCloudTransmission": false },
  "hostAssistedDistillation": {
    "enabled": false,
    "allowReviewContentTransmission": false,
    "includeDiffHunk": false,
    "maxCharactersPerJob": 30000
  }
}
```

- `prepare_distillation` は `enabled && allowReviewContentTransmission` の**両方**が真でなければ raw 本文を返さない（job メタのみ返し、有効化手順を案内）。
- server instructions は「provider 未設定なら必ず prepare」ではなく「**host-assisted distillation が明示的に有効な場合のみ** prepare する」と記載。
- 既定 limit は 1（コンテキスト消費と情報露出の最小化）。

README の送信経路表:

| 経路 | 送信先 |
|---|---|
| Provider Adapter | 設定した LLM Provider |
| Host-assisted | MCP クライアントが利用するモデル |
| disabled | 外部送信なし |

---

## 4. Evidence ライフサイクルと再蒸留（Gate 4）

### 4.1 fingerprint を content と state に分離

resolved の切り替えだけで再蒸留される v0.2 の定義は M1 完了条件（「編集・返信追加時だけ再蒸留」）と矛盾する。抽出内容に影響する diffHunk は content 側に含める。

```typescript
const contentFingerprint = sha256(canonicalJson({
  threadId, path, diffHunk,
  comments: comments.map(c => ({ id: c.id, body: c.body, updatedAt: c.updatedAt })),
}));
const stateFingerprint = sha256(canonicalJson({ isResolved, isOutdated }));
```

| 変化 | 処理 |
|---|---|
| content_fingerprint 変更 | 再蒸留（新 distill job） |
| state_fingerprint のみ変更 | evidence の状態のみ更新。再蒸留しない |
| 両方不変 | スキップ（ただし §4.5 の distillation_key 変化時は除く） |

### 4.2 evidence の世代管理

fingerprint を一意キーにすると、thread 編集のたびに同じ指摘が新 evidence として二重カウントされる。**一意性の基準は「発生元 thread」**とし、世代は status で管理する。

```typescript
type KnowledgeEvidence = {
  evidence_id: string;                   // ev_<ULID>
  occurrence_key: string;                // = `${knowledge_id}:${thread_id}`
  knowledge_id: string;
  repo_id: string;
  pr_number: number;
  thread_id: string;
  content_fingerprint: string;
  state_fingerprint: string;
  status: "active" | "superseded" | "withdrawn";
  eligible_for_count: boolean;
  supersedes?: string;
  superseded_by?: string;
  comment_ids: string[];
  source: "human" | "devin" | "greptile" | "bugbot" | "other";
  author_login?: string;
  author_association?: string;
  path?: string; url?: string;
  observed_at: string;
};
```

概念上の制約は **UNIQUE active evidence (knowledge_id, thread_id)**。正本はイベントログのため、この制約は**書き込みロジック（lock 内チェック）で強制**し、SQLite 側は投影の検証として partial unique index を張る:

```sql
CREATE UNIQUE INDEX evidence_active_unique
ON evidence(knowledge_id, thread_id) WHERE status = 'active';
```

`evidence_count` は `status = 'active' AND eligible_for_count = true` のみを数える。thread 編集時は旧 evidence を `superseded`（count 対象外）にし、新 evidence を active で作成する（supersedes / superseded_by 相互リンク）。

### 4.3 撤回の処理

再蒸留の結果、以前の candidate との対応が消えた場合:

- 対応を失った旧 evidence → `withdrawn` にして evidence_count を再計算
- distilled origin のルールで active evidence が 0 件になった → status を **stale** へ遷移し、get_rules から除外、人間へ通知（doctor / approve 画面に表示）

### 4.4 knowledge status と activation

```
status: proposed | active | stale | deprecated | rejected
```

手動ルールや人間が明示固定したルールは evidence 0 件でも active を維持できる:

```yaml
activation:
  origin: automatic | human
  pinned: true | false      # pinned=true は stale 遷移の対象外
```

### 4.5 distillation_key — prompt / trust 変更後の再蒸留

fingerprint 不変ならスキップする設計のままだと、「未知 bot を raw-only 収集 → aiReviewers へ登録 → 再 ingest してもスキップ」のように**永久に処理されない**ケースが生じる。job の一意性を次で定義する:

```typescript
const distillationKey = sha256(canonicalJson({
  content_fingerprint,
  prompt_version,
  output_schema_version,
  trust_policy_version,   // trust 設定の変更でインクリメント
}));
// job 一意性 = thread_id + distillation_key
```

モデル名は provenance（§5.3）に保存するが key には含めない（モデル更新のたびの全件再蒸留を避ける）。

```
repo-knowledge redistill <repo> --all
repo-knowledge redistill <repo> --author "greptile-apps[bot]"
repo-knowledge redistill <repo> --prompt-version distill-v2
repo-knowledge redistill <repo> --failed
```

---

## 5. ETag CAS — 直接編集の保護（High）

### 5.1 問題

人間が Markdown を直接編集して revision を変えなかった場合、revision CAS は編集を検知できず、古い内容の書き込みが人間の編集を上書きする。

### 5.2 仕様

- `etag = sha256(canonicalized frontmatter + body)`。`get_knowledge` は `revision` と `etag` の両方を返す。
- 更新は両方必須: `update_knowledge({ id, expected_revision, expected_etag, patch })`。
- **書き込み直前に実ファイルから etag を再計算**し、どちらか不一致なら拒否:

```typescript
type ConflictResult = {
  code: "KNOWLEDGE_CONFLICT";
  current_revision: number;
  current_etag: string;
  current: KnowledgeDocument;
};
```

- 蒸留の same マージ（evidence 追加）、CLI approve / edit、reconcile も**同一の CAS 経路**（= §1.3 の preconditions）を通す。

### 5.3 provenance の正規化

frontmatter の `distillation` 単一オブジェクトは複数回マージ後に意味が曖昧になるため、次に置き換える。完全な来歴は event log で管理する。

```yaml
origin:
  type: distilled            # distilled | manual
  prompt_version: distill-v1
  provider: anthropic
  model: "<model>"
last_automatic_update:
  transaction_id: txn_01...
  at: 2026-08-06T04:30:00Z
```

---

## 6. Repository Registry（High: rename 耐性の完成）

repo node ID は **opaque な一意参照**として扱う（形式を解析しない）。ファイル内部に repo_id があってもディレクトリへ到達できなければ rename 耐性は成立しないため、registry を導入する。

```
~/.repo-knowledge/
├── repositories.json
└── repos/
    └── <stable-storage-id>/        # sha256(repo_node_id) の先頭 16 文字等
```

```json
{
  "repositories": {
    "R_kgDOExample": {
      "path": "repos/4f8c2a91d3e07b56",
      "currentName": "tamat/izanagi",
      "aliases": ["old-owner/izanagi"]
    }
  }
}
```

- repo 解決（v0.2 §7.1）は最終的に **repo node ID → path** へ正規化する。`owner/name` 入力は GraphQL で node ID を引いて registry を参照し、rename 検知時は currentName を更新して旧名を aliases へ移す。
- `repoPolicies` / `workspaceMappings` も内部では repo ID キーへ正規化。
- レビュアーの login rename に備え、GraphQL で actor の `id` も取得し、trust 設定は `trustedActorIds`（推奨）と `trustedLogins`（利便性）の併用に対応する。

---

## 7. イベントエンベロープと raw 観測モデル

### 7.1 共通エンベロープ

```typescript
type EventEnvelope<TType extends string, TPayload> = {
  schema_version: 1;
  event_id: string;          // evt_<ULID>
  type: TType;
  aggregate_id: string;      // job_… / kn_… / ev_…
  recorded_at: string;
  transaction_id?: string;
  payload: TPayload;
};
```

job の状態は上書きではなく**イベント列**で表現する: `DistillationJobCreated / Leased / LeaseExpired / Succeeded / Skipped / Failed`（投影が state 列へ畳み込む）。

### 7.2 raw の 3 分割

comments.jsonl 単独では thread の resolved 変化・並び・PR メタ・review summary を表現できない。

```
raw/
├── pull_requests.jsonl        # PR メタ（node ID, mergedAt, baseRefOid, headRefOid…）
├── thread_observations.jsonl  # thread 単位のスナップショット観測（state fingerprint の元）
└── comments.jsonl             # comment 観測（編集は同一 node ID の再観測）
```

- comment 編集は同一 node ID で複数観測されるため、reindex 時は **recorded_at（同時刻は observation sequence）による last-write-wins** を定義する。
- PR レビュー本文（approve / request-changes のサマリ）には thread ID がないため、synthetic thread ID `review-summary:<review_node_id>` を付与して通常 thread と同じ蒸留パイプラインへ流す。
- **nested pagination の途中で GraphQL エラーが出た場合、部分取得の PR を完全な snapshot として commit しない**（job も作らない）。

---

## 8. 検索実装細則

### 8.1 FTS query の literal escape

MATCH 内は FTS 独自構文（`OR`, `-`, `"`, 括弧, `:` 等）として解釈されるため、既定は literal モードとする。

```typescript
function toFtsLiteral(query: string): string {
  const normalized = query.normalize("NFKC");
  return `"${normalized.replaceAll('"', '""')}"`;
}
// 将来 Boolean 検索を許す場合: query_mode: "literal" | "fts"（既定 literal）
```

### 8.2 フィルタは LIMIT より前に

```sql
SELECT f.knowledge_id, bm25(knowledge_fts) AS bm25_score
FROM knowledge_fts AS f
JOIN knowledge AS k ON k.id = f.knowledge_id
WHERE knowledge_fts MATCH ?
  AND k.repo = ? AND k.status = 'active'
  AND (? IS NULL OR k.category = ?)
ORDER BY bm25_score ASC LIMIT 50;
```

knowledge 更新時の FTS 反映は「同一 knowledge_id 行を delete → 再 insert」。FTS 表側に一意性を期待しない。

### 8.3 boost の上限

回数がテキスト関連度を支配しないよう cap を設ける:

```typescript
const evidenceBoost  = Math.min(0.30, 0.15 * Math.log1p(evidenceCount));
const violationBoost = Math.min(0.15, 0.05 * Math.log1p(violationCount));
```

### 8.4 match_reasons

`matched_scopes` を次に置き換え（task 由来の理由を表現可能に）:

```typescript
match_reasons: Array<
  | { type: "global" }
  | { type: "scope"; pattern: string; file_path: string }
  | { type: "task"; score: number }
>;
```

### 8.5 LIKE フォールバック細則

- 3 文字判定は **NFKC 正規化後の Unicode code point 数**で行う
- `%` と `_` を escape、最大 query 長を設定、空文字・記号のみは拒否
- trigram は既定 case-insensitive である点を LIKE 側の照合と揃える（`LOWER()` 比較）

---

## 9. 実装前確定事項

| 項目 | 確定内容 |
|---|---|
| writer lock | lock file に PID / host / created_at を記録し stale lock 回収を実装（プロセス生存確認 + 閾値超過で回収） |
| JSONL 破損 | 最終行が改行なし・JSON 不完全なら起動時に末尾を切り戻して警告（切り戻し分は .corrupt へ退避） |
| ファイル権限 | ディレクトリ 700 に加え config / Markdown / JSONL / SQLite を 600 |
| workspace_path | realpath 後、許可済み workspace root 配下に制限。`..`・symlink escape・任意パス探索を拒否 |
| repo 入力 | `owner/name` を厳格検証（正規表現）し、保存パスへ直接連結しない（§6 の storage-id 経由のみ） |
| execa | `shell: false`、argv 配列、timeout、maxBuffer を明示 |
| GraphQL | data と errors が同時に返る partial response を失敗扱いにし、不完全 snapshot から job を作らない |
| get_knowledge | evidence 全件は大量になりうるため `evidence_limit` と cursor を追加 |
| tool annotations | readOnlyHint / destructiveHint / idempotentHint / openWorldHint を設定。**ただし annotation を認可境界として扱わない**（§2 が境界） |
| pino | stderr destination をコード上で明示し、既定出力先に依存しない |
| confidence | 自動 active 判定には使用しない。監査・評価用メタデータに限定 |

---

## 10. 実装順序（M1 を 4 段階に分割）

LLM 処理を始める前に、正本・復旧・冪等性を確定させる。

### M1-A: ストレージ基盤
Markdown reader/writer / event envelope / **transaction journal** / writer lock / recovery / reindex / ETag + revision / SQLite projection。
**完了条件: 任意の commit ステップでプロセスを kill しても、再起動後に同一状態へ収束する。**

### M1-B: GitHub ingest
GraphQL nested pagination / raw observations（3 分割）/ identity・trust 判定 / content・state fingerprint / distill job 作成（distillation_key）/ unknown bot raw-only。

### M1-C: Provider Adapter 蒸留
Anthropic adapter / extract / candidate merge（§2.4 の範囲）/ proposed 管理（CLI approve）/ golden 評価。

### M1-D: Host-assisted
明示 opt-in（§3.4）/ prepare / submit extract・finalize / lease fencing / payload 制限 / proposed 固定。

## 11. M1 受け入れテスト（v0.2 の 12 項目に追加）

13. 正本 commit の各工程で強制終了しても、再起動時に完全復旧する
14. 正本 commit 後・SQLite 更新前に終了した場合、index が自動修復される
15. get_knowledge 後に Markdown を直接編集すると、古い etag での更新が拒否される
16. MCP 経由ではルールを active 化できない
17. 期限切れ lease を持つ worker の遅延 commit が STALE_LEASE で拒否される
18. resolved / outdated だけの変更では evidence_count が増えず、再蒸留もされない
19. 撤回スレッドの旧 evidence が withdrawn となり、ルールが stale として get_rules から除外される
20. unknown bot を aiReviewers へ追加後、GitHub 再取得なしで redistill できる
21. リポジトリ rename 後も同じ repo ID のストアへ解決される
22. `OR`・`-`・`"`・括弧を含む検索語で FTS syntax error が発生しない
23. proposed ルールが MCP の通常検索・get_rules へ混入しない
24. 不完全な GraphQL pagination 結果から job が作成されない

## 12. Status

```
Status: 実装開始承認
Architecture Gate: 通過（v0.2）
Mutation Path Gate: 本補遺 v0.2.1 で確定 — write path freeze
着手: M1-A から
```
