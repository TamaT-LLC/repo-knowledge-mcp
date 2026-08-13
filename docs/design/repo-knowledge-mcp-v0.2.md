# repo-knowledge-mcp 設計書

- Version: 0.2
- Date: 2026-08-06
- Status: 条件付き承認の指摘反映済み — Implementation Gate 解消、実装開始可
- 前版からの変更: 末尾「付録B: v0.1 からの変更履歴」参照

## Implementation Gate 対応状況

| Gate 項目 | 対応 |
|---|---|
| MCP roots / sampling 依存の解消 | §7.1 / §10 で解消（roots 不使用、sampling 不採用） |
| 正本と派生データの再定義 | §6 イベントログ方式（案A）を採用 |
| evidence / outcome モデルの分離 | §6.3 / §6.4 で分離 |
| trust policy 導入 | §11 |
| thread fingerprint / nested pagination | §8.3 / §8.1 |

---

## 1. 概要

repo-knowledge-mcp は、リポジトリごとの PR レビュー指摘（人間のレビュアーおよび Devin Review / Greptile / Bugbot 等の AI レビュアー）をローカルに収集し、LLM で一般化ルールへ蒸留して蓄積し、コーディングエージェント（Claude Code / Cursor 等）に MCP 経由で供給するツールである。

コンセプトは「生コメント層」と「蒸留済みナレッジ層」の 2 層構造。生のレビューコメントは文脈依存でノイズが多いため、エージェントが参照するのは蒸留済みルールのみとし、生データは監査ログ兼・蒸留再実行用の原本として保持する。

差別化軸は次の 4 つ（§21）: **Local-first / Vendor-neutral / Human + multi-AI evidence / Auditable Markdown**。

## 2. 背景と課題

- 同じリポジトリで同種のレビュー指摘が繰り返される。指摘はマージと同時に流れてしまい、次のコード生成に活かされない。
- CLAUDE.md / .cursor/rules に手で書き溜める運用は、(a) 更新が続かない、(b) 全ルールが常時コンテキストに載りトークンを浪費する、という 2 つの問題がある。
- Serena のメモリーは「エージェント自身が書くプロジェクトノート」、Bugbot の learned rules は「Bugbot 自身のレビュー品質改善」であり、いずれも「人間 + 複数 AI レビュアーの知見をベンダー中立にローカル蓄積し、任意のコーディングエージェントへ供給する」領域を持たない（§21）。

## 3. スコープ

### 3.1 ツール構成とバージョン計画

| ツール | v0.1 | 備考 |
|---|---|---|
| `get_rules` | 必須 | コード生成前の主役 |
| `search_knowledge` | 必須 | セルフレビュー・探索 |
| `get_knowledge` | 必須 | ID 指定の詳細取得 |
| `ingest_pr` | 必須 | raw 取得と自動蒸留 |
| `prepare_distillation` | 推奨 | API キーレス経路（§10.2） |
| `submit_distillation` | 推奨 | 同上 |
| `add_knowledge` | 任意 | 手動知見 |
| `update_knowledge` | 任意 | 人間による承認・編集（proposed→active 等） |
| `sync_repo` | v0.2 | カーソル設計確定後 |
| `record_outcome` | v0.2 | outcome の定義と重み付けが安定してから。誤った自己強化ループを先に作らない |
| `stats` | v0.2 | 集計定義確定後 |
| `export`（ルール本文） | v0.3 | trust policy 運用実績後。ただし bootstrap 1 行の出力（§12.3）はルール本文を含まないため M1 から可 |

### 3.2 やらないこと（Non-goals）

- コードのセマンティック検索・編集（Serena の領域）
- レビュー自体の実行（レビュー bot ではない）
- GitHub 以外のホスティング対応（当面）
- クラウド同期・サーバーサイド機能
- MCP roots / sampling / logging capability への依存（2026-07-28 仕様で deprecated。新規実装では採用しない）

## 4. 全体アーキテクチャ

```
[人間のレビュー指摘]  [AIレビュアー指摘 (Devin/Greptile/Bugbot)]
        └──────────────┬──────────────┘
                       ▼
        収集 (ingest)  gh CLI / GitHub GraphQL (nested pagination)
                       ▼
        thread fingerprint 判定 → distill job 作成 (pending)
                       ▼
        蒸留 (distill)  Provider Adapter または prepare/submit 経路
        └ trust policy による初期 status 決定 (proposed / active / raw-only)
                       ▼
        マージ (same / overlaps / different 判定)
                       ▼
   ナレッジストア  knowledge/*.md + raw/*.jsonl + events/*.jsonl (正本)
                       ▼ reindex (完全再構築可)
                index.sqlite (派生投影: FTS + 集計)
                       ▼
        MCP サーバー (stdio, SDK v2) / CLI
                       ▼
        コーディングエージェント (Claude Code / Cursor)
```

処理は「収集 → fingerprint 判定 → job 化 → 蒸留 → trust 判定 → マージ → イベント記録 → 投影更新」のパイプライン。各ステージは純粋関数に近い形で分離してテスト可能にする。

## 5. 技術スタック

| 項目 | 選定 | 備考 |
|---|---|---|
| 言語 / ランタイム | TypeScript / **Node.js 22+** (ESM) | Node 20 は 2026-04 に EOL。`"engines": { "node": ">=22" }`、CI は Node 22 / 24 |
| MCP SDK | **`@modelcontextprotocol/server`（SDK v2）** | v1 の `@modelcontextprotocol/sdk` は使わない。`serveStdio(() => buildServer())` で起動。v2 は 2025 系クライアント（initialize）と 2026-07-28 系（`_meta` エンベロープ）の両方を同一 factory で待ち受ける。対応 protocol version を package.json と README に明記 |
| スキーマ検証 | `zod` v4 | SDK v2 の inputSchema / outputSchema は Standard Schema 対応で zod v4 をそのまま渡せる。蒸留 JSON の検証にも共用 |
| DB | `better-sqlite3` | WAL 前提（§15.4）。native addon のため**バンドル対象外（external）** |
| GitHub アクセス | `gh` CLI ラッパー (`execa`) | 認証を gh に委譲、トークンを一切保持しない |
| glob 判定 | `picomatch` | scope マッチング |
| frontmatter | `yaml` strict parser | 完全一致する `---` delimiter の knowledge md だけを読み書きし、実行可能 parser の選択を許可しない |
| ID | ULID (`ulid`) | 連番は同時実行・git マージで衝突するため不採用（§15.1） |
| ビルド / 配布 | **`tsc`** / npm publish (`bin` 指定) | tsup は不採用（メンテナンス状況と native addon の external 化を考慮すると、この規模では tsc が最も事故が少ない）。`npx -y repo-knowledge-mcp` で起動 |
| ログ | `pino`（**stderr**） | stdout は JSON-RPC 専用。**console.log 禁止**、使うなら console.error |
| テスト | `vitest` | |

## 6. データ設計 — イベントログ正本方式（案A）

### 6.1 ストレージレイアウトと正本の定義

```
~/.repo-knowledge/
├── config.json
└── <owner>/<repo>/
    ├── knowledge/
    │   └── kn_<ULID>.md          # 蒸留済みナレッジ（正）
    ├── raw/
    │   └── comments.jsonl         # GitHub 原本（正・append-only）
    ├── events/
    │   ├── distillation.jsonl     # 蒸留 job の状態遷移（正）
    │   ├── evidence.jsonl         # ルール↔指摘の関連（正）
    │   └── outcomes.jsonl         # applied / violated（正・v0.2〜）
    ├── index.sqlite               # 派生投影（FTS + 集計。完全再構築可）
    ├── state.json                 # 同期カーソル（正）
    └── .write.lock                # per-repo writer lock（§15.2）
```

| 情報 | 正本 |
|---|---|
| 蒸留済みルール本文・属性 | knowledge/*.md |
| GitHub 原本（コメント・diff・PR メタ） | raw/comments.jsonl |
| 蒸留状態遷移（pending→…→done 等） | events/distillation.jsonl |
| ルールと指摘の関連（evidence） | events/evidence.jsonl |
| applied / violated | events/outcomes.jsonl |
| 同期カーソル | state.json |
| 検索・集計用投影 | index.sqlite（**唯一の再生成可能・使い捨てデータ**） |

`reindex` は knowledge / raw / events / state をすべて読み、index.sqlite をゼロから再構築する。**SQLite にしか存在しない永続情報を作らない**ことが本方式の不変条件であり、可搬性・Rust 移植（§20）・git 共有への布石となる。

### 6.2 knowledge ファイル形式（schema_version: 1）

```markdown
---
schema_version: 1
id: kn_01J4NKQYVYK9R1J8CAYK1Q6GQH
repo_id: R_kgDOExample            # GitHub repository node ID（rename/移管耐性）
repo: tamat/izanagi
rule: "Tauri の invoke 結果は Result として扱い、失敗を UI へ通知する"
category: error-handling          # style|naming|architecture|error-handling|security|perf|test|docs|other
scope:
  - "src/ipc/**"
  - "src-tauri/**/*.rs"
severity: should                  # must | should | consider
status: active                    # proposed | active | deprecated | rejected
evidence_count: 3                 # events 由来のキャッシュ。reindex 時に再計算・整合検証
violation_count: 0                # 同上
applied_count: 0                  # 同上
sources: [human, greptile]
representative_evidence:          # 代表 3 件まで。全量は events/evidence.jsonl
  - evidence_id: ev_01J4...
    pr: 128
    thread_id: PRRT_kwDO...
    url: "https://github.com/tamat/izanagi/pull/128#discussion_r..."
    source: human
    path: "src/ipc/client.ts"
related_ids: []                   # overlaps 判定されたルール（§9.4）
revision: 2                       # 楽観ロック用（§7.5）
created_at: 2026-08-06T03:00:00Z
updated_at: 2026-08-06T04:30:00Z
distillation:
  prompt_version: distill-v1
  provider: anthropic
  model: "<configured-model>"
---
## 背景
Tauri バックエンド側の失敗が握り潰されると、UI では操作が成功したように見える。
## 違反時の影響
（…）
## 適用条件
`invoke` を使ってフロントエンドから Tauri command を呼び出す箇所。
## 根拠となったレビュー
（…）
```

本文構成は **M1 では「背景 / 違反時の影響 / 適用条件 / 根拠となったレビュー」に限定**し、コード例の生成は M2 に回す。M2 でコード例を導入する際も次の制約を課す: 入力 diff またはレビュー本文に根拠がある例のみ具体コード化する / 根拠がなければ概念説明に留める / 架空の関数名・型名・パッケージ名を生成しない / 生成例には `generated_example: true` を付ける。

counts 3 種は events からの派生値のキャッシュである。`reindex` は events から再計算し、frontmatter と不一致なら frontmatter を修正して警告を出す。

### 6.3 evidence モデル

evidence は「どのレビュースレッドがどのルールの根拠か」を表す一級エンティティ。examples / sources だけでは二重カウント防止・source 別統計・監査・1 スレッド複数ルールの追跡ができないため分離する。

```typescript
type KnowledgeEvidence = {
  evidence_id: string;            // ev_<ULID>
  knowledge_id: string;
  repo: string;
  pr_number: number;
  thread_id: string;
  thread_fingerprint: string;     // §8.3
  comment_ids: string[];
  source: "human" | "devin" | "greptile" | "bugbot" | "other";
  author_login?: string;
  author_association?: string;    // OWNER / MEMBER / NONE 等
  path?: string;
  url?: string;
  is_resolved?: boolean;
  is_outdated?: boolean;
  observed_at: string;
  superseded_by?: string;         // fingerprint 変化時、旧 evidence は削除せず参照付与（監査性）
};
```

一意制約: **UNIQUE(knowledge_id, thread_fingerprint)**。同じ PR を再度 `ingest_pr` しても evidence_count は増えない。

### 6.4 outcome モデル（v0.2）

「レビューで観測された回数（evidence）」「エージェントが違反した回数（violation）」「適用された回数（applied）」は異なるシグナルであり、混ぜない。

```typescript
type Outcome = {
  event_id: string;               // 必須。MCP リトライによる二重加算を防ぐ冪等キー
  knowledge_id: string;
  repo: string;
  outcome: "applied" | "violated" | "not_applicable" | "false_positive";
  context?: { task_id?: string; file_paths?: string[]; pr_number?: number };
  note?: string;
  at: string;
};
```

### 6.5 SQLite（派生投影）

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE raw_comments (        -- raw/comments.jsonl の投影
  id TEXT PRIMARY KEY,             -- GitHub comment node_id
  repo_id TEXT, repo TEXT, pr_number INTEGER,
  thread_id TEXT, path TEXT, diff_hunk TEXT,
  body TEXT, author_login TEXT, author_association TEXT,
  actor_kind TEXT, provider TEXT, trust TEXT,   -- §11
  is_resolved INTEGER, is_outdated INTEGER,
  url TEXT, created_at TEXT, updated_at TEXT
);

CREATE TABLE distill_jobs (        -- events/distillation.jsonl の投影
  job_id TEXT PRIMARY KEY,
  repo TEXT, thread_id TEXT, thread_fingerprint TEXT,
  state TEXT NOT NULL,             -- pending|processing|done|skipped|failed
  skip_reason TEXT,                -- §9.2 の enum
  attempts INTEGER DEFAULT 0,
  last_error TEXT, next_retry_at TEXT, lease_expires_at TEXT,
  updated_at TEXT
);

CREATE TABLE knowledge (           -- knowledge/*.md + events の投影
  id TEXT PRIMARY KEY,
  repo TEXT, rule TEXT, detail TEXT, category TEXT,
  scope_json TEXT, severity TEXT, status TEXT,
  evidence_count INTEGER, violation_count INTEGER, applied_count INTEGER,
  sources_json TEXT, revision INTEGER,
  created_at TEXT, updated_at TEXT
);

-- external-content 方式は使わない。検索用テキストを重複保持し reindex で全再構築する
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  knowledge_id UNINDEXED, rule, detail,
  tokenize='trigram'
);

CREATE TABLE evidence (            -- events/evidence.jsonl の投影
  evidence_id TEXT PRIMARY KEY,
  knowledge_id TEXT, thread_fingerprint TEXT,
  source TEXT, pr_number INTEGER, superseded_by TEXT,
  UNIQUE(knowledge_id, thread_fingerprint)
);
```

## 7. MCP インターフェース仕様

サーバー名: `repo-knowledge`。SDK v2 の `registerTool` に zod v4 の inputSchema / **outputSchema** を渡し、人間向けの短い Markdown（content）とエージェント向けの **structuredContent** を併記する。

### 7.1 repo の解決順序（roots 不使用）

MCP roots は 2026-07-28 仕様で deprecated のため依存しない。解決順序:

1. ツールの `repo` 引数（`owner/name`）
2. ツールの `workspace_path` 引数 → `git remote get-url origin` を解析
3. サーバー起動時フラグ `--repo` / `--workspace`
4. config.json の `workspaceMappings`
5. config.json の `defaultRepo`
6. 解決不能なら明示エラー（候補と設定方法をメッセージに含める）

### 7.2 get_rules（主役）

```typescript
// 入力
{ repo?: string; workspace_path?: string; file_paths?: string[]; task?: string; limit?: number /* default 20 */ }

// 出力 (structuredContent)
{
  repo: string;
  rules: Array<{
    id: string;                    // record_outcome / get_knowledge に必須
    rule: string;
    severity: "must" | "should" | "consider";
    evidence_count: number;
    violation_count: number;
    matched_scopes: string[];      // なぜこのルールが返ったか
    example_url?: string;
  }>;
  matched_count: number;
  truncated: boolean;
}
```

- 対象は **status = active のみ**。proposed は返さない。
- `file_paths` あり: global ルール（scope 未設定）+ いずれかの scope が一致するルール。
- `file_paths` なし: global ルールのみ。`task` があれば task を query とした検索上位を加える。**無条件の全ルール返却はしない**（コンテキスト肥大の再発防止）。
- `limit` で切り詰める際は must を優先的に残し、切れた場合は `truncated: true`。
- detail は返さない（`get_knowledge` で取得）。

### 7.3 scope 仕様

- パスは repo-relative POSIX 形式。`\` は `/` へ正規化してから判定。
- scope 配列は OR 判定。scope 未設定 = repo 全体（global）。
- 大文字小文字は区別する（case-sensitive）。
- negative pattern（`!...`）は v0.1 では不可（バリデーションで拒否）。

### 7.4 その他のツール

| ツール | 入出力の要点 |
|---|---|
| `search_knowledge` | `{ query, repo?, category?, status? /* default: active */, limit? }` → ランキング済み一覧（§13）。3 文字未満の query は LIKE フォールバック |
| `get_knowledge` | `{ id }` → frontmatter 全体 + detail 本文 + 全 evidence |
| `ingest_pr` | `{ repo, pr_number }` → 収集 + fingerprint 判定 + job 化 + （provider 設定時）自動蒸留。サマリ `{ new_threads, changed_threads, unchanged, jobs_created, distilled, pending }` を返す |
| `prepare_distillation` / `submit_distillation` | §10.2 |
| `add_knowledge` | 手動登録。初期 status は trusted human 扱い（§11.3） |
| `update_knowledge` | `{ id, expected_revision, patch }`。**楽観ロック**: revision 不一致なら現内容を返して拒否（人間の直接編集を上書きしない）。status 遷移（proposed→active 承認、rejected 化）もここで行う |

### 7.5 revision（楽観ロック）

人間が Markdown を直接編集した直後に、別プロセスが古い内容で上書きする事故を防ぐ。書き込み時は `revision++`。`update_knowledge` は `expected_revision` を必須とする。CLI / 蒸留マージも同じ経路を通す。

## 8. 収集パイプライン（ingest）

### 8.1 GraphQL 取得（nested pagination 必須）

`reviewThreads` のページングに加え、**各スレッド内 `comments` にもカーソルを付ける**。31 件以上コメントのあるスレッドの取りこぼしを防ぐ。実装は「thread 一覧取得 → comments に `hasNextPage` が立ったスレッドのみ追加クエリ」の 2 段方式。`reviews`（approve / request-changes のサマリ本文）も同様にページングする。

```graphql
comments(first: 100, after: $commentCursor) {
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    author { __typename login }
    authorAssociation
    body diffHunk url createdAt updatedAt
  }
}
```

PR 単位で以下も保存する（再現性・rename/移管耐性）: `repository.id` / `repository.nameWithOwner` / `pullRequest.id` / `number` / `title` / `mergedAt` / `baseRefOid` / `headRefOid`。repo の同一性判定は文字列でなく **repository node ID** を優先する。

### 8.2 正規化とフィルタ

- `author` から ReviewerIdentity（§11.1）を構成。`sourceAliases` 設定で provider へ写像。
- 除外: 空 body、絵文字のみ、CI bot の定型通知。
- resolved / outdated は**除外しない**（解決済み指摘こそナレッジ源）。フラグとして保持し蒸留プロンプトへ渡す。
- issue コメント（雑談が多い）は対象外。

### 8.3 thread fingerprint と再蒸留

コメントは編集され、スレッドには返信が追加される。冪等性は comment ID ではなく **スレッド単位の fingerprint** で判定する。

```typescript
const fingerprint = sha256(canonicalJson({
  threadId, path, isResolved, isOutdated,
  comments: comments.map(c => ({ id: c.id, body: c.body, updatedAt: c.updatedAt })),
}));
```

| 状態 | 処理 |
|---|---|
| thread_id + fingerprint が既存 | スキップ |
| thread_id は既存、fingerprint が変化 | 再蒸留候補として新 job 作成。旧 fingerprint 由来の evidence は削除せず `superseded_by` を付与 |
| thread_id が新規 | 新規蒸留 job |

## 9. 蒸留パイプライン（distill）

### 9.1 抽出 — 1 スレッドから 0〜N ルール

1 スレッドにはエラー処理・命名・テスト不足など複数の学びが混在しうるため、出力は candidate 配列とする。

```json
{
  "candidates": [
    {
      "rule": "Tauri の invoke 結果は Result として扱い、失敗を UI へ通知する",
      "detail": "…",
      "category": "error-handling",
      "scope": ["src/ipc/**", "src-tauri/**/*.rs"],
      "severity": "should",
      "confidence": 0.86,
      "evidence_comment_ids": ["PRRC_xxx", "PRRC_yyy"]
    }
  ],
  "skip_reason": null
}
```

0 件の場合は `{ "candidates": [], "skip_reason": "pr_specific" }`。

### 9.2 skip_reason と job 状態

```typescript
const SkipReason = z.enum([
  "typo", "praise_or_chitchat", "question_without_conclusion",
  "pr_specific", "duplicate_noise", "insufficient_context",
]);
```

**skipped（内容評価の結果ナレッジでない）と failed（システム/モデルの処理失敗）を区別する。** job 状態は `pending | processing | done | skipped | failed`。属性として `attempts / last_error / next_retry_at / lease_expires_at` を保持。JSON 検証失敗は 1 回だけ再試行（エラー内容をプロンプトに添付）し、それでも失敗なら **failed**（skipped にしない）。プロセスが蒸留中に落ちた場合、`lease_expires_at` を過ぎた processing を pending へ戻す。

### 9.3 プロンプト設計方針（品質の最重要レバー）

- 一般化しすぎ（「読みやすいコードを書く」）と具体化しすぎ（変数名そのまま）の両方を悪い例としてプロンプトに埋め込む。
- リポジトリ固有事情（社内ライブラリ名、規約）は**残す**。一般論への丸めは禁止。
- レビューコメント本文は「データ」としてタグで区切り、コメント内の指示への追従を禁止する定型ガードを入れる（§17）。
- プロンプトは `prompts/distill.md` として外部ファイル化し `prompt_version` を付与。golden 評価（§18）で回帰を検知する。

### 9.4 マージ — 類似検索と同一性判定の分離

1. scope / category で候補を絞る
2. FTS **順位**上位 5〜10 件を取得（絶対スコア閾値は使わない — 文書長や query でスケールが変わるため）
3. LLM に 3 値判定させる: **same / overlaps / different**
4. same のみ自動マージ: evidence 追加（UNIQUE 制約で冪等）、sources / scope 和集合、必要なら rule 文の改善
5. **overlaps は別ルールとして新規作成し `related_ids` を相互付与**（過剰統合の防止。例:「invoke の失敗を UI 通知」と「command は Result を返し panic しない」は関連するが同一ではない）
6. different は新規作成

## 10. LLM 実行系 — クラウド送信は明示 opt-in のみ

デフォルトは**蒸留無効**。API キー環境変数の存在だけでコード断片（コメント・diff_hunk）を外部送信することは決してしない。

```json
{
  "llm": { "mode": "disabled", "allowCloudTransmission": false }
}
```

### 10.1 経路A: Provider Adapter（自動蒸留）

`mode: "anthropic"` かつ `allowCloudTransmission: true` を**両方**明示設定した場合のみ有効。将来 `openai` / `local` を追加可能な Adapter インターフェースとする。`repoPolicies` でリポジトリ別に送信可否を上書きできる（§14）。

### 10.2 経路B: prepare / submit（API キーレス・ホスト支援蒸留）

MCP sampling は使わない（2026-07-28 仕様で deprecated。SDK v2 は 2026 系接続で sampling リクエストが例外になる実装であり、legacy フラグでの温存も行わない）。代わりに**通常のツール呼び出し 2 つ**でホスト側エージェント自身に蒸留させる。特定 capability に依存しないため、Claude Code / Cursor いずれでもそのまま動く。

```
prepare_distillation({ repo, limit?: 10 })
  → { jobs: [{ job_id, thread_fingerprint, comments, diff, path,
               similar_rules,            // マージ候補（§9.4 の 1-2 を済ませて渡す）
               output_schema }] }        // §9.1 の JSON Schema

submit_distillation({ job_id, thread_fingerprint, candidates })
  → zod 検証 → fingerprint 一致確認 → trust 判定 → マージ → 保存
  → { accepted, merged, created, rejected_reason? }
```

server instructions に「provider 未設定環境では ingest 後に prepare→(自分で蒸留)→submit を行うこと」を記載する。

### 10.3 経路C: どちらも不可

raw 保存 + job を pending のまま返す。次回の経路 A/B 実行時、または CLI 実行時に消化する。

将来メモ: 2026-07-28 仕様の Multi Round-Trip Requests（SEP-2322, `InputRequiredResult`）は経路 B の仕様ネイティブな代替になりうる。クライアント側の対応が普及した段階で移行を検討する。

## 11. Trust Policy — ナレッジ汚染対策

本ツールの本質的リスクは単発のプロンプトインジェクションではなく、**悪意ある・低品質なレビューが「将来エージェントが従う永続ルール」になること**（ナレッジ汚染）。source と trust を分離して防ぐ。

### 11.1 ReviewerIdentity

```typescript
type ReviewerIdentity = {
  actor_kind: "user" | "bot" | "unknown";
  login: string | null;
  provider: "human" | "devin" | "greptile" | "bugbot" | "other";
  trust: "trusted" | "untrusted" | "unknown";
  author_association?: string;   // OWNER / MEMBER / COLLABORATOR / NONE / FIRST_TIME_CONTRIBUTOR …
};
```

trust の決定: `trustedLogins`（config）に含まれる → trusted。`aiReviewers`（config で明示登録された bot login）→ その provider として trusted-AI 扱い。それ以外の bot・未知 login → untrusted / unknown。author_association が NONE / FIRST_TIME_CONTRIBUTOR の人間 → untrusted（外部コントリビューター）。

### 11.2 knowledge status の拡張

`proposed | active | deprecated | rejected`。**get_rules が返すのは active のみ**。proposed は `list_knowledge`（CLI）/ `update_knowledge` で人間が承認する。

### 11.3 初期 status ポリシー

| evidence の由来 | 初期 status |
|---|---|
| 信頼済み人間レビュー（trustedLogins） | active（ただし severity=must は proposed。must の active 化は人間承認必須） |
| 設定済み AI レビュアー（aiReviewers） | proposed |
| AI 由来だが独立した evidence が複数（既定 3 件以上、うち trusted human 1 件以上） | active 昇格候補として通知 |
| 未知 bot | **raw-only（蒸留対象に入れない）**。初回 ingest 時に warn ログで列挙し、aiReviewers への登録を促す |
| 外部コントリビューター | proposed または raw-only（config `externalContributors: "proposed" | "raw-only"`、既定 raw-only） |

## 12. エージェント連携の運用設計

### 12.1 server instructions

「コードを変更する前に `get_rules` を、変更対象ファイルを添えて呼ぶこと」を記載する。ただし instructions だけでは呼び出しは保証されない（クライアントとモデルの判断に依存する）。

### 12.2 bootstrap 1 行

ルール本文の静的注入はしないが、次の 1 行だけを CLAUDE.md / .cursor/rules に置くことを README で推奨し、`repo-knowledge export --bootstrap` で生成できるようにする（数十トークンであり、全ルール注入のコンテキスト肥大問題とは別物）。

```
Before modifying code, call the repo-knowledge MCP `get_rules` tool with the files you expect to change.
```

### 12.3 record_outcome（v0.2）

get_rules の出力に id が含まれるため、エージェントは違反指摘を受けた際 `record_outcome` を呼べる。event_id による冪等化（§6.4）を前提に v0.2 で導入する。

## 13. 検索とランキング — 二段階方式

SQLite FTS5 の `bm25()` は**値が小さいほど関連度が高い**。BM25 の絶対値に独自 boost を加算する方式はスケールが安定しないため、二段階にする。

```sql
-- 第 1 段: FTS で候補取得
SELECT knowledge_id, bm25(knowledge_fts) AS bm25_score
FROM knowledge_fts WHERE knowledge_fts MATCH ?
ORDER BY bm25_score ASC LIMIT 50;
```

```typescript
// 第 2 段: アプリ側で順位ベースの再ランキング（FTS の数値スケールに非依存）
const score =
  reciprocalRank(ftRank) +               // 1 / (1 + rank)
  severityBoost(rule.severity) +          // must: 0.4, should: 0.2, consider: 0
  0.15 * Math.log1p(rule.evidenceCount) +
  0.05 * Math.log1p(rule.violationCount);
```

- trigram tokenizer は 3 Unicode 文字未満の検索語にマッチしない。**query 長 < 3 は rule/detail への LIKE / 完全一致フォールバック**に切り替える。
- external-content FTS は同期維持の複雑さに見合わないため使わない。検索テキストを FTS テーブルに重複保持し、reindex で全再構築する（§6.5）。

## 14. 設定（config.json）

```json
{
  "defaultRepo": "tamat/izanagi",
  "repos": ["tamat/izanagi", "tamat/fern"],
  "workspaceMappings": {
    "/Users/take/src/izanagi": "tamat/izanagi",
    "/Users/take/src/fern": "tamat/fern"
  },
  "llm": {
    "mode": "disabled",
    "allowCloudTransmission": false,
    "model": null
  },
  "repoPolicies": {
    "tamat/private-repo": { "allowCloudTransmission": false }
  },
  "trust": {
    "trustedLogins": ["take", "masuda", "tsutsumi"],
    "aiReviewers": {
      "devin-ai-integration[bot]": "devin",
      "greptile-apps[bot]": "greptile",
      "cursor[bot]": "bugbot"
    },
    "externalContributors": "raw-only"
  },
  "ingest": { "includeOutdated": true, "excludeAuthors": [] }
}
```

bot の login 名は実環境で要確認のため、初回 ingest 時に未知 bot を warn ログで列挙する（§11.3）。

## 15. 同時実行・冪等性・クラッシュ復旧

MCP サーバーと cron CLI が同時に動く前提で設計する。

### 15.1 ID

`kn_<ULID>` / `ev_<ULID>` / `job_<ULID>`。連番は同時実行と将来の git マージで衝突するため不採用。

### 15.2 per-repo writer lock

`<repo>/.write.lock` で書き込みを直列化する。**LLM API 呼び出し中はロックを保持しない**:

```
1. lock 取得
2. distill job 作成（processing + lease_expires_at 設定）
3. lock 解放
4. LLM 実行（ロック外）
5. lock 再取得
6. thread_fingerprint が変化していないことを確認
7. commit（md / events / sqlite）
8. lock 解放
```

### 15.3 atomic write

Markdown / state.json / jsonl のローテーションは「一時ファイルへ書く → fsync → rename」。jsonl への append は lock 内で行う。

### 15.4 SQLite

`journal_mode = WAL` / `busy_timeout = 5000` / `foreign_keys = ON`（§6.5）。

## 16. CLI

```
repo-knowledge                        # stdin が pipe(MCP接続) → serve / TTY → help を表示
repo-knowledge serve
repo-knowledge sync [repo] [--since]  # cron 用（v0.2）
repo-knowledge ingest <repo> <pr>
repo-knowledge distill <repo>         # pending job の消化（経路 A 前提）
repo-knowledge list <repo> [--status proposed]   # 棚卸し・承認対象の確認
repo-knowledge approve <id> / reject <id>        # proposed の処理
repo-knowledge reindex <repo>         # 正本群 → index.sqlite 全再構築
repo-knowledge export <repo> --bootstrap         # §12.2 の 1 行生成
repo-knowledge doctor
```

引数なし実行は TTY 判定で分岐し、ターミナルで誤実行した際に無言で stdio 待ちになるのを防ぐ。

`doctor` のチェック項目: Node バージョン / gh CLI 存在 / `gh auth status` / GraphQL 疎通 / 保存先パーミッション / SQLite FTS5・trigram 利用可否 / config 構文 / LLM provider 設定と allowCloudTransmission の整合 / 対象 repo の remote 解決 / index 整合性（events との count 一致）。

## 17. セキュリティ

- GitHub トークンを保存・受領しない。すべて gh CLI の認証に委譲。
- `~/.repo-knowledge/` はパーミッション 700 で作成（コード断片を含むため）。
- クラウド送信は §10 の明示 opt-in のみ。README に送信されるデータの範囲を明記。将来検討: 送信前 secret scanner / diff サイズ上限 / 除外パス設定。
- プロンプトインジェクション対策（§9.3）+ ナレッジ汚染対策としての trust policy（§11）。前者は単発、後者は永続の防御であり両方必要。
- stdio 汚染防止: stdout は JSON-RPC 専用、ログは stderr のみ。

## 18. テスト方針

### 18.1 評価指標

| 評価対象 | 指標 |
|---|---|
| ナレッジ抽出（is_knowledge 相当） | precision / recall |
| category 分類 | macro F1 |
| severity | weighted accuracy |
| 重複統合（same/overlaps/different） | pairwise precision / recall |
| scope | valid glob 率・期待ファイル一致率 |
| 検索 | MRR / NDCG |
| 冪等性 | 同一 PR 再取込時の状態一致 |
| 再構築 | reindex 前後の検索結果一致 |

golden は完全一致でなく上記指標で評価する（モデル差分への耐性）。

### 18.2 必須 fixture

1 スレッド複数ルール / 発言が撤回されたスレッド / resolved だが不採用の指摘 / edited comment / 後から reply が追加された thread / 未知 bot / 外部コントリビューター / プロンプトインジェクション文 / 日本語 2 文字検索 / 31 件以上の thread comments / 同一 PR の二重 ingest / LLM 処理中クラッシュ（lease 復旧）/ Markdown 手編集後の reindex / MCP と cron の同時書き込み。

### 18.3 ゲート

- **smoke gate**: 実 PR 10 件の取り込みと E2E 動作。
- **quality gate**: 匿名化 fixture 50 スレッド以上での指標達成（閾値は初回計測後に設定）。

## 19. マイルストーン

### M1（v0.1）完了条件

1. 実 PR 10 件を取り込める
2. 同じ PR を何度取り込んでも evidence_count が変わらない
3. コメント編集・返信追加時だけ再蒸留される
4. 1 スレッドから 0〜N 件のルールを抽出できる
5. 未知 bot 由来ルールが自動 active にならない
6. index.sqlite を削除して完全再構築できる
7. Claude Code / Cursor から get_rules を呼び出せる
8. get_rules が id・matched_scopes・truncated を返す
9. LLM 未設定時も raw 保存と job 化が完了する
10. クラウド送信は明示 opt-in 時だけ行われる
11. MCP と CLI の同時実行で破損しない
12. Node 22 / 24 でテストが通る

### M2（v0.2）

sync_repo / record_outcome / stats / quality gate 運用開始 / detail へのコード例（根拠制約付き）。完了条件: cron 同期で 2 週間運用し、ランキングが体感に合う。

### M3（v0.3）

export（ルール本文）/ リポジトリ内 `.repo-knowledge/` モード（git 共有）/ npm 公開・README 整備。完了条件: チームメンバーが npx 一発で導入できる。

## 20. 将来構想

- **Rust 移植 / izanagi 統合**: 正本がすべてファイル（md + jsonl + json）でイベントソーシングされているため言語非依存。`izanagi-core` にリーダー実装を置き、izanagi のスキルレジストリへ「リポジトリの過去指摘」を供給する経路を想定。TS 版はリファレンス実装として維持。
- **MRTR 移行**: 経路 B を SEP-2322（Multi Round-Trip Requests）ベースへ置き換える検討（クライアント普及後）。
- **レビュアー比較分析**: evidence の source × category 統計から「どの AI レビュアーがどの領域に強いか」を可視化。Zenn 記事ネタとしても有望。
- **org 共有ナレッジ**: org 横断ルール名前空間（Serena の global/ 規約を参考）。

## 21. 競合との棲み分け（README 記載方針）

README 冒頭で次の 3 者比較を明示する。

| 製品 | 主な役割 |
|---|---|
| Serena memory | エージェントが探索して残すプロジェクトノート（オンボーディング主用途） |
| Bugbot learned rules | PR 上の反応・返信・人間レビューから学習し、**Bugbot 自身の**レビュー品質を改善する学習ルール（2026-04 GA、Cursor のダッシュボードで管理） |
| repo-knowledge-mcp | **人間 + 複数 AI レビュアー**の知見を、**ローカルかつベンダー中立**に蓄積し、**任意の**コーディングエージェントへ供給 |

差別化軸: **Local-first**（データは手元、クラウド送信は opt-in）/ **Vendor-neutral**（特定レビュアー・特定エージェントに閉じない）/ **Human + multi-AI evidence**（evidence の source 別トラッキング）/ **Auditable Markdown**（正本が人間可読・手編集可・git 管理可）。

---

## 付録A: プロジェクト構成

```
repo-knowledge-mcp/
├── src/
│   ├── index.ts            # エントリ (TTY 判定 → serve / CLI 分岐)
│   ├── server.ts           # buildServer(): SDK v2 registerTool 登録。serveStdio(buildServer)
│   ├── tools/              # 1 ファイル 1 ツール（outputSchema 含む）
│   ├── ingest/
│   │   ├── github.ts       # gh api graphql ラッパー（nested pagination）
│   │   ├── normalize.ts    # ReviewerIdentity 構成・フィルタ
│   │   └── fingerprint.ts  # canonicalJson + sha256
│   ├── distill/
│   │   ├── providers/      # anthropic.ts（Adapter IF）
│   │   ├── extract.ts      # candidates 抽出
│   │   ├── merge.ts        # same/overlaps/different 判定 + マージ
│   │   └── jobs.ts         # job 状態機械（lease 復旧含む）
│   ├── store/
│   │   ├── markdown.ts     # knowledge md 読み書き（revision 管理）
│   │   ├── events.ts       # jsonl append / 読み出し
│   │   ├── sqlite.ts       # 投影・FTS・reindex
│   │   ├── lock.ts         # writer lock
│   │   └── schema.sql
│   ├── ranking.ts          # 二段階ランキング
│   ├── trust.ts            # trust policy
│   ├── domain/types.ts     # zod スキーマ（単一情報源）
│   ├── config.ts
│   └── cli/                # sync / doctor / approve ほか
├── prompts/distill.md      # prompt_version 付き
├── test/                   # fixtures（§18.2）+ golden 評価
└── package.json            # engines: node>=22, bin: repo-knowledge
```

## 付録B: v0.1 からの変更履歴

| # | 変更 | 理由 |
|---|---|---|
| 1 | repo 解決から MCP roots を除外、workspace_path 引数 + workspaceMappings へ | MCP 2026-07-28 で roots deprecated（SEP-2577） |
| 2 | sampling を全面不採用、prepare/submit_distillation の 2 ツール方式へ | 同上 + SDK v2 は 2026 系接続で sampling が例外。legacy フラグも設けない（維持コストに見合わない） |
| 3 | SDK を @modelcontextprotocol/server（v2, serveStdio）へ更新 | v1 sdk パッケージは旧世代。v2 が 2026-07-28 対応の安定版 |
| 4 | ストレージをイベントログ正本方式（案A）へ。events/*.jsonl 追加、SQLite は完全派生 | 「Markdown が正・SQLite 使い捨て」の矛盾解消。可搬性・Rust 移植・git 共有と整合 |
| 5 | occurrences を evidence_count / violation_count / applied_count に分離。outcome は event_id で冪等化 | 異なるシグナルの混在を解消 |
| 6 | evidence を一級エンティティ化、UNIQUE(knowledge_id, thread_fingerprint) | 二重カウント防止・監査・source 別統計 |
| 7 | trust policy（ReviewerIdentity / proposed 状態 / 昇格ポリシー / 未知 bot は raw-only） | ナレッジ汚染対策 |
| 8 | 蒸留出力を 0〜N candidates + skip_reason enum へ。skipped と failed を分離、job に lease | 1 スレッド複数ルール対応・クラッシュ復旧 |
| 9 | thread fingerprint による編集・追記検知、superseded_by | コメント編集・返信への冪等対応 |
| 10 | GraphQL nested pagination、authorAssociation / updatedAt / repo node ID 等の保存 | 31 件超スレッドの欠落防止・rename 耐性 |
| 11 | FTS ランキングを二段階（bm25 ASC 候補 → 順位ベース再スコア）へ。3 文字未満は LIKE。external-content 廃止 | bm25() の符号仕様への適合・スケール安定化 |
| 12 | get_rules に id / matched_scopes / truncated / task を追加、structuredContent + outputSchema 化。get_knowledge 追加。scope 仕様明文化 | record_outcome 前提・検索性・仕様曖昧性の解消 |
| 13 | クラウド送信を mode + allowCloudTransmission の二重 opt-in に。既定 disabled。repoPolicies | API キー存在だけで非公開コードを送らない |
| 14 | ULID 化・writer lock・atomic write・WAL | MCP と cron の同時実行対応 |
| 15 | Node >= 22（CI: 22/24）、ビルドは tsc | Node 20 EOL、tsup のメンテ状況 |
| 16 | detail のコード例生成に根拠制約（M1 は本文 4 節に限定） | 架空 API のハルシネーション防止 |
| 17 | doctor コマンド・TTY 分岐 | 導入負荷の低減 |
| 18 | README に Bugbot learned rules との差別化を追加、4 つの差別化軸を明文化 | Bugbot が 2026-04 に learned rules を GA |
| 19 | record_outcome / sync / stats を v0.2 へ後ろ倒し、M1 完了条件を 12 項目に改訂 | 自己強化ループを定義安定後に導入。smoke/quality gate 分離 |
