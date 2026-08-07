# repo-knowledge-mcp 統合仕様書 v0.3

- Version: 0.3
- Date: 2026-08-06
- Status: M1-A 完了、v0.2 本体・補遺 3 本・Errata の統合完了
- 対応 Issue: RKM-ERRATA-023-TASK-007

<a id="reading-rules"></a>

## 0. 文書の位置づけと読み方

本書は、v0.2 本体、v0.2.1 補遺、v0.2.2 補遺、v0.2.3 補遺、v0.2.3 Errata を一つに再編した規範文書である。
確定済みの意味と制約は変更していない。
実装とテストで確認した事実だけを「5. 実装・テストで確認した事実」に追加した。
元文書は履歴と差分確認のため、次のファイルでも参照できる。

- [v0.2 本体](./repo-knowledge-mcp-v0.2.md)
- [v0.2.1 Mutation Path 補遺](./repo-knowledge-mcp-v0.2.1-supplement.md)
- [v0.2.2 Write Path 補遺](./repo-knowledge-mcp-v0.2.2-supplement.md)
- [v0.2.3 Write Path Freeze 補遺](./repo-knowledge-mcp-v0.2.3-supplement.md)
- [v0.2.3 Errata](./repo-knowledge-mcp-v0.2.3-errata.md)

### 0.1 規範の優先順位

同じ対象について記述が異なる場合は、次の順序で後の文書層を優先する。

1. 本書 5 節の実装・テスト事実
2. 本書 4 節の Errata
3. 本書 3.2 節の v0.2.3 Write Path
4. 本書 3.1 節の v0.2.2 Write Path
5. 本書 2 節の v0.2.1 Mutation Path
6. 本書 1 節の v0.2 Architecture

上位層は、下位層の明示された差し替え対象だけを置き換える。
明示されていない確定事項はそのまま有効である。
各統合層に残る古い記述は履歴と追跡のために保持し、差し替え表が示す範囲では規範として使用しない。

### 0.2 統合構造

| 統合層 | 役割 | 主な元文書 |
|---|---|---|
| [Architecture](#architecture) | 目的、スコープ、データ正本、MCP、収集、蒸留、検索、運用の基準 | v0.2 |
| [Mutation Path](#mutation-path) | canonical transaction、権限境界、lease、evidence lifecycle、ETag、registry | v0.2.1 |
| [Write Path](#write-path) | staged payload、read isolation、receipt、recovery、COMMITTED marker、finalize guard | v0.2.2、v0.2.3 |
| [Errata](#errata) | E-01〜E-04、P-01、I-01 | v0.2.3 Errata |
| [実装事実](#implementation-facts) | M1-A の実装と kill-point テストで確認した事実 | v0.3 追加 |

### 0.3 差し替えの統合索引

| 下位層 | 差し替え対象 | 最終的に読む節 |
|---|---|---|
| Architecture | ストレージ、frontmatter、evidence、SQLite、更新 CAS、fingerprint、prepare/submit、検索、同時実行、M1 | [Mutation Path](#mutation-path) と [Write Path](#write-path) |
| Mutation Path | manifest、recovery、read isolation、receipt、ETag、evidence 追加、distillation key、fingerprint | [v0.2.2](#write-path-v022) と [v0.2.3](#write-path-v023) |
| v0.2.2 Write Path | receipt replay、FinalizeContext、knowledge_file_state、JSONL envelope、COMMITTED marker、match set | [v0.2.3](#write-path-v023) |
| v0.2.3 Write Path | replay phase、request hash、source generation bind、集合 sort、skip policy、全件 SHA 検知 | [Errata](#errata) |

<a id="architecture"></a>

## 1. Architecture

この節は v0.2 の Architecture 基準を保持する。
0.3 節の差し替え対象には、後続の Mutation Path、Write Path、Errata を適用する。
それ以外の目的、スコープ、インターフェース、収集・蒸留・検索・運用要件はこの節の記述を継承する。

<a id="architecture-v02"></a>

### repo-knowledge-mcp 設計書

- Version: 0.2
- Date: 2026-08-06
- Status: 条件付き承認の指摘反映済み — Implementation Gate 解消、実装開始可
- 前版からの変更: 末尾「付録B: v0.1 からの変更履歴」参照

#### Implementation Gate 対応状況

| Gate 項目 | 対応 |
|---|---|
| MCP roots / sampling 依存の解消 | §7.1 / §10 で解消（roots 不使用、sampling 不採用） |
| 正本と派生データの再定義 | §6 イベントログ方式（案A）を採用 |
| evidence / outcome モデルの分離 | §6.3 / §6.4 で分離 |
| trust policy 導入 | §11 |
| thread fingerprint / nested pagination | §8.3 / §8.1 |

---

#### 1. 概要

repo-knowledge-mcp は、リポジトリごとの PR レビュー指摘（人間のレビュアーおよび Devin Review / Greptile / Bugbot 等の AI レビュアー）をローカルに収集し、LLM で一般化ルールへ蒸留して蓄積し、コーディングエージェント（Claude Code / Cursor 等）に MCP 経由で供給するツールである。

コンセプトは「生コメント層」と「蒸留済みナレッジ層」の 2 層構造。生のレビューコメントは文脈依存でノイズが多いため、エージェントが参照するのは蒸留済みルールのみとし、生データは監査ログ兼・蒸留再実行用の原本として保持する。

差別化軸は次の 4 つ（§21）: **Local-first / Vendor-neutral / Human + multi-AI evidence / Auditable Markdown**。

#### 2. 背景と課題

- 同じリポジトリで同種のレビュー指摘が繰り返される。指摘はマージと同時に流れてしまい、次のコード生成に活かされない。
- CLAUDE.md / .cursor/rules に手で書き溜める運用は、(a) 更新が続かない、(b) 全ルールが常時コンテキストに載りトークンを浪費する、という 2 つの問題がある。
- Serena のメモリーは「エージェント自身が書くプロジェクトノート」、Bugbot の learned rules は「Bugbot 自身のレビュー品質改善」であり、いずれも「人間 + 複数 AI レビュアーの知見をベンダー中立にローカル蓄積し、任意のコーディングエージェントへ供給する」領域を持たない（§21）。

#### 3. スコープ

##### 3.1 ツール構成とバージョン計画

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

##### 3.2 やらないこと（Non-goals）

- コードのセマンティック検索・編集（Serena の領域）
- レビュー自体の実行（レビュー bot ではない）
- GitHub 以外のホスティング対応（当面）
- クラウド同期・サーバーサイド機能
- MCP roots / sampling / logging capability への依存（2026-07-28 仕様で deprecated。新規実装では採用しない）

#### 4. 全体アーキテクチャ

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

#### 5. 技術スタック

| 項目 | 選定 | 備考 |
|---|---|---|
| 言語 / ランタイム | TypeScript / **Node.js 22+** (ESM) | Node 20 は 2026-04 に EOL。`"engines": { "node": ">=22" }`、CI は Node 22 / 24 |
| MCP SDK | **`@modelcontextprotocol/server`（SDK v2）** | v1 の `@modelcontextprotocol/sdk` は使わない。`serveStdio(() => buildServer())` で起動。v2 は 2025 系クライアント（initialize）と 2026-07-28 系（`_meta` エンベロープ）の両方を同一 factory で待ち受ける。対応 protocol version を package.json と README に明記 |
| スキーマ検証 | `zod` v4 | SDK v2 の inputSchema / outputSchema は Standard Schema 対応で zod v4 をそのまま渡せる。蒸留 JSON の検証にも共用 |
| DB | `better-sqlite3` | WAL 前提（§15.4）。native addon のため**バンドル対象外（external）** |
| GitHub アクセス | `gh` CLI ラッパー (`execa`) | 認証を gh に委譲、トークンを一切保持しない |
| glob 判定 | `picomatch` | scope マッチング |
| frontmatter | `gray-matter` | knowledge md の読み書き |
| ID | ULID (`ulid`) | 連番は同時実行・git マージで衝突するため不採用（§15.1） |
| ビルド / 配布 | **`tsc`** / npm publish (`bin` 指定) | tsup は不採用（メンテナンス状況と native addon の external 化を考慮すると、この規模では tsc が最も事故が少ない）。`npx -y repo-knowledge-mcp` で起動 |
| ログ | `pino`（**stderr**） | stdout は JSON-RPC 専用。**console.log 禁止**、使うなら console.error |
| テスト | `vitest` | |

#### 6. データ設計 — イベントログ正本方式（案A）

##### 6.1 ストレージレイアウトと正本の定義

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

##### 6.2 knowledge ファイル形式（schema_version: 1）

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

##### 6.3 evidence モデル

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

##### 6.4 outcome モデル（v0.2）

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

##### 6.5 SQLite（派生投影）

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

#### 7. MCP インターフェース仕様

サーバー名: `repo-knowledge`。SDK v2 の `registerTool` に zod v4 の inputSchema / **outputSchema** を渡し、人間向けの短い Markdown（content）とエージェント向けの **structuredContent** を併記する。

##### 7.1 repo の解決順序（roots 不使用）

MCP roots は 2026-07-28 仕様で deprecated のため依存しない。解決順序:

1. ツールの `repo` 引数（`owner/name`）
2. ツールの `workspace_path` 引数 → `git remote get-url origin` を解析
3. サーバー起動時フラグ `--repo` / `--workspace`
4. config.json の `workspaceMappings`
5. config.json の `defaultRepo`
6. 解決不能なら明示エラー（候補と設定方法をメッセージに含める）

##### 7.2 get_rules（主役）

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

##### 7.3 scope 仕様

- パスは repo-relative POSIX 形式。`\` は `/` へ正規化してから判定。
- scope 配列は OR 判定。scope 未設定 = repo 全体（global）。
- 大文字小文字は区別する（case-sensitive）。
- negative pattern（`!...`）は v0.1 では不可（バリデーションで拒否）。

##### 7.4 その他のツール

| ツール | 入出力の要点 |
|---|---|
| `search_knowledge` | `{ query, repo?, category?, status? /* default: active */, limit? }` → ランキング済み一覧（§13）。3 文字未満の query は LIKE フォールバック |
| `get_knowledge` | `{ id }` → frontmatter 全体 + detail 本文 + 全 evidence |
| `ingest_pr` | `{ repo, pr_number }` → 収集 + fingerprint 判定 + job 化 + （provider 設定時）自動蒸留。サマリ `{ new_threads, changed_threads, unchanged, jobs_created, distilled, pending }` を返す |
| `prepare_distillation` / `submit_distillation` | §10.2 |
| `add_knowledge` | 手動登録。初期 status は trusted human 扱い（§11.3） |
| `update_knowledge` | `{ id, expected_revision, patch }`。**楽観ロック**: revision 不一致なら現内容を返して拒否（人間の直接編集を上書きしない）。status 遷移（proposed→active 承認、rejected 化）もここで行う |

##### 7.5 revision（楽観ロック）

人間が Markdown を直接編集した直後に、別プロセスが古い内容で上書きする事故を防ぐ。書き込み時は `revision++`。`update_knowledge` は `expected_revision` を必須とする。CLI / 蒸留マージも同じ経路を通す。

#### 8. 収集パイプライン（ingest）

##### 8.1 GraphQL 取得（nested pagination 必須）

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

##### 8.2 正規化とフィルタ

- `author` から ReviewerIdentity（§11.1）を構成。`sourceAliases` 設定で provider へ写像。
- 除外: 空 body、絵文字のみ、CI bot の定型通知。
- resolved / outdated は**除外しない**（解決済み指摘こそナレッジ源）。フラグとして保持し蒸留プロンプトへ渡す。
- issue コメント（雑談が多い）は対象外。

##### 8.3 thread fingerprint と再蒸留

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

#### 9. 蒸留パイプライン（distill）

##### 9.1 抽出 — 1 スレッドから 0〜N ルール

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

##### 9.2 skip_reason と job 状態

```typescript
const SkipReason = z.enum([
  "typo", "praise_or_chitchat", "question_without_conclusion",
  "pr_specific", "duplicate_noise", "insufficient_context",
]);
```

**skipped（内容評価の結果ナレッジでない）と failed（システム/モデルの処理失敗）を区別する。** job 状態は `pending | processing | done | skipped | failed`。属性として `attempts / last_error / next_retry_at / lease_expires_at` を保持。JSON 検証失敗は 1 回だけ再試行（エラー内容をプロンプトに添付）し、それでも失敗なら **failed**（skipped にしない）。プロセスが蒸留中に落ちた場合、`lease_expires_at` を過ぎた processing を pending へ戻す。

##### 9.3 プロンプト設計方針（品質の最重要レバー）

- 一般化しすぎ（「読みやすいコードを書く」）と具体化しすぎ（変数名そのまま）の両方を悪い例としてプロンプトに埋め込む。
- リポジトリ固有事情（社内ライブラリ名、規約）は**残す**。一般論への丸めは禁止。
- レビューコメント本文は「データ」としてタグで区切り、コメント内の指示への追従を禁止する定型ガードを入れる（§17）。
- プロンプトは `prompts/distill.md` として外部ファイル化し `prompt_version` を付与。golden 評価（§18）で回帰を検知する。

##### 9.4 マージ — 類似検索と同一性判定の分離

1. scope / category で候補を絞る
2. FTS **順位**上位 5〜10 件を取得（絶対スコア閾値は使わない — 文書長や query でスケールが変わるため）
3. LLM に 3 値判定させる: **same / overlaps / different**
4. same のみ自動マージ: evidence 追加（UNIQUE 制約で冪等）、sources / scope 和集合、必要なら rule 文の改善
5. **overlaps は別ルールとして新規作成し `related_ids` を相互付与**（過剰統合の防止。例:「invoke の失敗を UI 通知」と「command は Result を返し panic しない」は関連するが同一ではない）
6. different は新規作成

#### 10. LLM 実行系 — クラウド送信は明示 opt-in のみ

デフォルトは**蒸留無効**。API キー環境変数の存在だけでコード断片（コメント・diff_hunk）を外部送信することは決してしない。

```json
{
  "llm": { "mode": "disabled", "allowCloudTransmission": false }
}
```

##### 10.1 経路A: Provider Adapter（自動蒸留）

`mode: "anthropic"` かつ `allowCloudTransmission: true` を**両方**明示設定した場合のみ有効。将来 `openai` / `local` を追加可能な Adapter インターフェースとする。`repoPolicies` でリポジトリ別に送信可否を上書きできる（§14）。

##### 10.2 経路B: prepare / submit（API キーレス・ホスト支援蒸留）

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

##### 10.3 経路C: どちらも不可

raw 保存 + job を pending のまま返す。次回の経路 A/B 実行時、または CLI 実行時に消化する。

将来メモ: 2026-07-28 仕様の Multi Round-Trip Requests（SEP-2322, `InputRequiredResult`）は経路 B の仕様ネイティブな代替になりうる。クライアント側の対応が普及した段階で移行を検討する。

#### 11. Trust Policy — ナレッジ汚染対策

本ツールの本質的リスクは単発のプロンプトインジェクションではなく、**悪意ある・低品質なレビューが「将来エージェントが従う永続ルール」になること**（ナレッジ汚染）。source と trust を分離して防ぐ。

##### 11.1 ReviewerIdentity

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

##### 11.2 knowledge status の拡張

`proposed | active | deprecated | rejected`。**get_rules が返すのは active のみ**。proposed は `list_knowledge`（CLI）/ `update_knowledge` で人間が承認する。

##### 11.3 初期 status ポリシー

| evidence の由来 | 初期 status |
|---|---|
| 信頼済み人間レビュー（trustedLogins） | active（ただし severity=must は proposed。must の active 化は人間承認必須） |
| 設定済み AI レビュアー（aiReviewers） | proposed |
| AI 由来だが独立した evidence が複数（既定 3 件以上、うち trusted human 1 件以上） | active 昇格候補として通知 |
| 未知 bot | **raw-only（蒸留対象に入れない）**。初回 ingest 時に warn ログで列挙し、aiReviewers への登録を促す |
| 外部コントリビューター | proposed または raw-only（config `externalContributors: "proposed" | "raw-only"`、既定 raw-only） |

#### 12. エージェント連携の運用設計

##### 12.1 server instructions

「コードを変更する前に `get_rules` を、変更対象ファイルを添えて呼ぶこと」を記載する。ただし instructions だけでは呼び出しは保証されない（クライアントとモデルの判断に依存する）。

##### 12.2 bootstrap 1 行

ルール本文の静的注入はしないが、次の 1 行だけを CLAUDE.md / .cursor/rules に置くことを README で推奨し、`repo-knowledge export --bootstrap` で生成できるようにする（数十トークンであり、全ルール注入のコンテキスト肥大問題とは別物）。

```
Before modifying code, call the repo-knowledge MCP `get_rules` tool with the files you expect to change.
```

##### 12.3 record_outcome（v0.2）

get_rules の出力に id が含まれるため、エージェントは違反指摘を受けた際 `record_outcome` を呼べる。event_id による冪等化（§6.4）を前提に v0.2 で導入する。

#### 13. 検索とランキング — 二段階方式

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

#### 14. 設定（config.json）

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

#### 15. 同時実行・冪等性・クラッシュ復旧

MCP サーバーと cron CLI が同時に動く前提で設計する。

##### 15.1 ID

`kn_<ULID>` / `ev_<ULID>` / `job_<ULID>`。連番は同時実行と将来の git マージで衝突するため不採用。

##### 15.2 per-repo writer lock

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

##### 15.3 atomic write

Markdown / state.json / jsonl のローテーションは「一時ファイルへ書く → fsync → rename」。jsonl への append は lock 内で行う。

##### 15.4 SQLite

`journal_mode = WAL` / `busy_timeout = 5000` / `foreign_keys = ON`（§6.5）。

#### 16. CLI

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

#### 17. セキュリティ

- GitHub トークンを保存・受領しない。すべて gh CLI の認証に委譲。
- `~/.repo-knowledge/` はパーミッション 700 で作成（コード断片を含むため）。
- クラウド送信は §10 の明示 opt-in のみ。README に送信されるデータの範囲を明記。将来検討: 送信前 secret scanner / diff サイズ上限 / 除外パス設定。
- プロンプトインジェクション対策（§9.3）+ ナレッジ汚染対策としての trust policy（§11）。前者は単発、後者は永続の防御であり両方必要。
- stdio 汚染防止: stdout は JSON-RPC 専用、ログは stderr のみ。

#### 18. テスト方針

##### 18.1 評価指標

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

##### 18.2 必須 fixture

1 スレッド複数ルール / 発言が撤回されたスレッド / resolved だが不採用の指摘 / edited comment / 後から reply が追加された thread / 未知 bot / 外部コントリビューター / プロンプトインジェクション文 / 日本語 2 文字検索 / 31 件以上の thread comments / 同一 PR の二重 ingest / LLM 処理中クラッシュ（lease 復旧）/ Markdown 手編集後の reindex / MCP と cron の同時書き込み。

##### 18.3 ゲート

- **smoke gate**: 実 PR 10 件の取り込みと E2E 動作。
- **quality gate**: 匿名化 fixture 50 スレッド以上での指標達成（閾値は初回計測後に設定）。

#### 19. マイルストーン

##### M1（v0.1）完了条件

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

##### M2（v0.2）

sync_repo / record_outcome / stats / quality gate 運用開始 / detail へのコード例（根拠制約付き）。完了条件: cron 同期で 2 週間運用し、ランキングが体感に合う。

##### M3（v0.3）

export（ルール本文）/ リポジトリ内 `.repo-knowledge/` モード（git 共有）/ npm 公開・README 整備。完了条件: チームメンバーが npx 一発で導入できる。

#### 20. 将来構想

- **Rust 移植 / izanagi 統合**: 正本がすべてファイル（md + jsonl + json）でイベントソーシングされているため言語非依存。`izanagi-core` にリーダー実装を置き、izanagi のスキルレジストリへ「リポジトリの過去指摘」を供給する経路を想定。TS 版はリファレンス実装として維持。
- **MRTR 移行**: 経路 B を SEP-2322（Multi Round-Trip Requests）ベースへ置き換える検討（クライアント普及後）。
- **レビュアー比較分析**: evidence の source × category 統計から「どの AI レビュアーがどの領域に強いか」を可視化。Zenn 記事ネタとしても有望。
- **org 共有ナレッジ**: org 横断ルール名前空間（Serena の global/ 規約を参考）。

#### 21. 競合との棲み分け（README 記載方針）

README 冒頭で次の 3 者比較を明示する。

| 製品 | 主な役割 |
|---|---|
| Serena memory | エージェントが探索して残すプロジェクトノート（オンボーディング主用途） |
| Bugbot learned rules | PR 上の反応・返信・人間レビューから学習し、**Bugbot 自身の**レビュー品質を改善する学習ルール（2026-04 GA、Cursor のダッシュボードで管理） |
| repo-knowledge-mcp | **人間 + 複数 AI レビュアー**の知見を、**ローカルかつベンダー中立**に蓄積し、**任意の**コーディングエージェントへ供給 |

差別化軸: **Local-first**（データは手元、クラウド送信は opt-in）/ **Vendor-neutral**（特定レビュアー・特定エージェントに閉じない）/ **Human + multi-AI evidence**（evidence の source 別トラッキング）/ **Auditable Markdown**（正本が人間可読・手編集可・git 管理可）。

---

#### 付録A: プロジェクト構成

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

#### 付録B: v0.1 からの変更履歴

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

<a id="mutation-path"></a>

## 2. Mutation Path

この節は v0.2.1 で確定した mutation 境界を保持する。
transaction journal、MCP plane と admin plane、host-assisted 蒸留、evidence lifecycle、ETag、repository registry を規定する。
同節の差し替え表に加えて、後続の Write Path と Errata を適用する。

<a id="mutation-v021"></a>

### repo-knowledge-mcp 設計補遺 v0.2.1 — Mutation Path 仕様の確定

- Version: 0.2.1（v0.2 への追補。本補遺と v0.2 本体が矛盾する場合は**本補遺が優先**）
- Date: 2026-08-06
- Status: **実装開始承認** / Architecture Gate: 通過 / Mutation Path Gate: 本補遺で確定 → **write path freeze**
- 実装順序: §10 の M1-A から着手可

#### 0. v0.2 本体からの差し替え対応表

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

#### 1. Canonical Transaction Journal（Gate 1: 正本間のコミット原子性）

##### 1.1 問題

atomic write は 1 ファイル単位であり、knowledge/*.md と events/*.jsonl は**いずれも正本**である。「md 更新成功 → evidence append 前にクラッシュ」で正本同士が矛盾し、SQLite 再構築では復旧できない。

##### 1.2 transaction manifest

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

##### 1.3 コミットプロトコル（全書き込み経路が必ず通る）

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

##### 1.4 起動時リカバリと projection_meta

- `prepared` かつ未 committed の manifest → event_id と file hash を照合し、**不足している操作だけを冪等に再実行**して committed へ進める（rename 済みかは new_sha256 で判定、append 済みかは event_id で判定）
- `committed` だが checkpoint 未反映 → SQLite 投影のみ再実行

```sql
CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version / last_committed_transaction_id / canonical_digest / index_dirty
```

##### 1.5 reindex は正本を変更しない

| コマンド | 役割 |
|---|---|
| `reindex` | 正本を**一切変更せず** SQLite だけ再構築 |
| `doctor` | 不整合（counts と events の乖離等）を報告のみ |
| `reconcile --write-derived-metadata` | 明示操作として counts 等を Markdown へ書き戻す（§1.3 の経路で） |

v0.2 §6.2 の「reindex が frontmatter を修正」は撤回。git 共有時に reindex が不要な Markdown 差分を生まないことを保証する。

---

#### 2. Mutation 境界 — MCP plane と admin plane の分離（Gate 2）

##### 2.1 原則

MCP tools は model-controlled なインターフェースであり、**ツールを呼んだ主体を「人間」とは扱えない**。PR コメント由来のインジェクションでエージェントが承認系操作を実行しうるため、承認は MCP の外（CLI / TTY）に置く。

##### 2.2 権限表

| 操作 | MCP plane | admin plane（CLI） |
|---|---|---|
| add_knowledge | **常に proposed** で登録 | `add --active` 可（TTY 確認付き） |
| update_knowledge | proposed の**編集提案のみ**。status の active 化不可。active ルール本文・scope・severity の直接変更不可 | `edit <id>` で可（ETag CAS 経由） |
| status 遷移（→active / →rejected） | **不可** | `approve <id>` / `reject <id>` |
| search_knowledge / get_rules | **active 固定**（status 引数を公開しない。proposed は返さない） | `list --status proposed` で棚卸し |
| submit_distillation 由来ルール | 原則 proposed | — |

`approve` は対話 TTY を既定とし、非対話実行は明示的な `--yes` を要求。承認時に表示する項目: ルール本文 / severity / scope / 根拠レビュー（URL）/ source と trust / distillation origin / 既存ルールとの関係（related_ids・possible matches）。

##### 2.3 M1 の既定は自動 active なし

quality gate の閾値が未計測の段階で自動 active を許すべきではない。

```json
{ "trust": { "autoActivateTrustedHuman": false } }
```

M1 では手動 `add --active` を除き**すべて proposed から開始**する。最初の実 PR 10 件を人間が確認し、precision が十分と判断してから opt-in で有効化する（v0.2 §11.3 の初期 status 表は、この opt-in 後の挙動として読む）。

##### 2.4 same マージの自動実行範囲（trust laundering 防止）

AI 由来 candidate が既存 active ルールと same 判定されることで active 本文・scope・severity を書き換えられてはならない。

| 操作 | 扱い |
|---|---|
| evidence 追加 / source 観測記録 / representative_evidence 更新 | 自動実行可 |
| rule 本文変更 / detail 変更 / scope 追加 / severity 変更 | **提案止まり** — `KnowledgeRevisionProposal` イベントとして保存し、人間承認（`approve-revision <id>`）後に §1.3 経路で反映 |

##### 2.5 脅威モデル（README / SECURITY.md に明記）

- **防ぐもの**: 未知 bot・外部コントリビューター・PR 本文からの永続的ナレッジ汚染、エージェントによる偶発的な承認・改稿
- **防がないもの**: 同一 OS ユーザー権限を奪取したプロセス、`~/.repo-knowledge` を直接改変できる悪意あるローカルホスト（ファイル権限は §9 で緩和するが境界にはならない）

---

#### 3. Host-assisted 蒸留 — 2 フェーズ submit・lease fencing・送信同意（Gate 3）

##### 3.1 問題

v0.2 の prepare は candidate 生成前に similar_rules を返しており、candidate に対する正確な類似検索になっていない。また Provider 無効環境では same/overlaps/different を判定する LLM がサーバー側に存在しない。さらに host-assisted はホストモデル（多くはクラウド）へレビュー本文と diff を渡すため、「クラウド送信は Provider Adapter の opt-in のみ」という v0.2 の説明と矛盾する。

##### 3.2 プロトコル（prepare → submit×2）

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

##### 3.3 lease fencing

`lease_expires_at` だけでは「A がタイムアウト → B が再取得して処理 → 遅れて A が commit」を防げない。job ごとに `lease_generation` を単調増加で発行し、**commit（各 submit）時に現在の generation と一致しなければ `STALE_LEASE` で拒否**して再 prepare を促す。fingerprint 一致確認は fencing の代替にならない（同一 fingerprint でも A/B の二重 commit が起こるため）。

##### 3.4 送信同意の分離

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

#### 4. Evidence ライフサイクルと再蒸留（Gate 4）

##### 4.1 fingerprint を content と state に分離

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

##### 4.2 evidence の世代管理

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

##### 4.3 撤回の処理

再蒸留の結果、以前の candidate との対応が消えた場合:

- 対応を失った旧 evidence → `withdrawn` にして evidence_count を再計算
- distilled origin のルールで active evidence が 0 件になった → status を **stale** へ遷移し、get_rules から除外、人間へ通知（doctor / approve 画面に表示）

##### 4.4 knowledge status と activation

```
status: proposed | active | stale | deprecated | rejected
```

手動ルールや人間が明示固定したルールは evidence 0 件でも active を維持できる:

```yaml
activation:
  origin: automatic | human
  pinned: true | false      # pinned=true は stale 遷移の対象外
```

##### 4.5 distillation_key — prompt / trust 変更後の再蒸留

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

#### 5. ETag CAS — 直接編集の保護（High）

##### 5.1 問題

人間が Markdown を直接編集して revision を変えなかった場合、revision CAS は編集を検知できず、古い内容の書き込みが人間の編集を上書きする。

##### 5.2 仕様

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

##### 5.3 provenance の正規化

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

#### 6. Repository Registry（High: rename 耐性の完成）

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

#### 7. イベントエンベロープと raw 観測モデル

##### 7.1 共通エンベロープ

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

##### 7.2 raw の 3 分割

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

#### 8. 検索実装細則

##### 8.1 FTS query の literal escape

MATCH 内は FTS 独自構文（`OR`, `-`, `"`, 括弧, `:` 等）として解釈されるため、既定は literal モードとする。

```typescript
function toFtsLiteral(query: string): string {
  const normalized = query.normalize("NFKC");
  return `"${normalized.replaceAll('"', '""')}"`;
}
// 将来 Boolean 検索を許す場合: query_mode: "literal" | "fts"（既定 literal）
```

##### 8.2 フィルタは LIMIT より前に

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

##### 8.3 boost の上限

回数がテキスト関連度を支配しないよう cap を設ける:

```typescript
const evidenceBoost  = Math.min(0.30, 0.15 * Math.log1p(evidenceCount));
const violationBoost = Math.min(0.15, 0.05 * Math.log1p(violationCount));
```

##### 8.4 match_reasons

`matched_scopes` を次に置き換え（task 由来の理由を表現可能に）:

```typescript
match_reasons: Array<
  | { type: "global" }
  | { type: "scope"; pattern: string; file_path: string }
  | { type: "task"; score: number }
>;
```

##### 8.5 LIKE フォールバック細則

- 3 文字判定は **NFKC 正規化後の Unicode code point 数**で行う
- `%` と `_` を escape、最大 query 長を設定、空文字・記号のみは拒否
- trigram は既定 case-insensitive である点を LIKE 側の照合と揃える（`LOWER()` 比較）

---

#### 9. 実装前確定事項

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

#### 10. 実装順序（M1 を 4 段階に分割）

LLM 処理を始める前に、正本・復旧・冪等性を確定させる。

##### M1-A: ストレージ基盤
Markdown reader/writer / event envelope / **transaction journal** / writer lock / recovery / reindex / ETag + revision / SQLite projection。
**完了条件: 任意の commit ステップでプロセスを kill しても、再起動後に同一状態へ収束する。**

##### M1-B: GitHub ingest
GraphQL nested pagination / raw observations（3 分割）/ identity・trust 判定 / content・state fingerprint / distill job 作成（distillation_key）/ unknown bot raw-only。

##### M1-C: Provider Adapter 蒸留
Anthropic adapter / extract / candidate merge（§2.4 の範囲）/ proposed 管理（CLI approve）/ golden 評価。

##### M1-D: Host-assisted
明示 opt-in（§3.4）/ prepare / submit extract・finalize / lease fencing / payload 制限 / proposed 固定。

#### 11. M1 受け入れテスト（v0.2 の 12 項目に追加）

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

#### 12. Status

```
Status: 実装開始承認
Architecture Gate: 通過（v0.2）
Mutation Path Gate: 本補遺 v0.2.1 で確定 — write path freeze
着手: M1-A から
```

<a id="write-path"></a>

## 3. Write Path

この節は v0.2.2 と v0.2.3 の write path freeze を保持する。
v0.2.3 が v0.2.2 を差し替える範囲は、v0.2.3 の対応表に従う。

<a id="write-path-v022"></a>

### 3.1 v0.2.2 統合層

#### repo-knowledge-mcp 設計補遺 v0.2.2 — Write Path 最終補正（freeze）

- Version: 0.2.2（v0.2 + v0.2.1 への追補。矛盾時は **v0.2.2 > v0.2.1 > v0.2** の順で優先）
- Date: 2026-08-06
- Status: **write path freeze**。本補遺の反映をもって canonical writer / recovery engine / submit finalize commit の実装に着手可

##### 0. v0.2.1 からの差し替え対応表

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

##### 1. Staged Append Payload — トランザクションの再生可能性（Blocker 1・最優先）

###### 1.1 問題

v0.2.1 の manifest は `event_appends` に `payload_sha256` しか持たない。「prepared → md rename → event append 前にクラッシュ」で、append すべきイベント**本文**が失われ、hash からは復元できない。また対象ログが 3 種の enum に固定されており、raw/*.jsonl・KnowledgeRevisionProposal・submissions（§4）等の正本書き込みを表現できない。

###### 1.2 transaction ディレクトリと汎用 manifest

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

###### 1.3 prepared へ進める条件（この順で全完了後にのみ prepared）

1. 全 file_writes の staged file 作成・fsync
2. 全 append_records の staged JSONL 行作成・fsync
3. manifest.tmp 作成・fsync
4. manifest.json へ atomic rename
5. `transactions/txn_<ULID>/` ディレクトリを fsync

以降のコミットは v0.2.1 §1.3 の 5–10（rename → append → committed → SQLite → checkpoint → cleanup）。

###### 1.4 recovery 判定

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

###### 1.5 fail-closed

`RECOVERY_CONFLICT` / `UNRECOVERABLE_TRANSACTION` が残る repo は、**doctor と復旧用 CLI 以外のすべての read / write を拒否**する（MCP ツールはエラーで復旧手順を案内）。中途半端な状態で通常運転を続けない。

---

##### 2. Read Isolation（Blocker 2）

###### 2.1 問題

writer が「md rename 済み・events 未 append・SQLite 未更新」の間に get_rules / get_knowledge / search_knowledge が走ると、新旧混在の snapshot を観測できる。

###### 2.2 M1 の仕様

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

##### 3. Registry のグローバルロックと repo_id 一貫性（Blocker 3）

###### 3.1 問題

repo ごとの .write.lock では repositories.json への同時初回登録（A: izanagi 登録 ∥ B: fern 登録）を保護できず、read-modify-write の競合で片方の登録が失われる。

###### 3.2 仕様

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

###### 3.3 storage-id

```typescript
const storageId = sha256(repoNodeId).slice(0, 32);  // 16 hex は不足。32 hex 以上または full SHA-256
```

###### 3.4 SQLite / 検索の repo_id 化

knowledge / evidence / raw_comments / distill_jobs の結合・フィルタは mutable な `repo` 名ではなく **`repo_id`** を使う。v0.2.1 §8.2 の例は次に差し替え:

```sql
WHERE knowledge_fts MATCH ?
  AND k.repo_id = ? AND k.status = 'active'
```

`repo` 名は表示用として保持する。

---

##### 4. Submit の冪等性と token binding（Blocker 4）

###### 4.1 問題

lease fencing は「古い worker の commit」を防ぐが、「**finalize commit 成功 → MCP レスポンス消失 → クライアントが同一 finalize を再試行**」を扱えない。単に STALE_LEASE や job already done を返すと、クライアントは 1 回目の成否を判別できず、再実行すれば evidence / proposal が二重作成されうる。

###### 4.2 submission_id と receipt

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

###### 4.3 FinalizeContext と検証

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

###### 4.4 token 生成

`lease_token` / `finalize_token` は予測可能な ULID ではなく**暗号学的乱数**（`crypto.randomBytes(32)` 相当）で生成し、保存時は hash 化する。opaque・有効期限付きの handle として扱う。

---

##### 5. Evidence の再対応付け・collapse・ThreadRemoved（High）

###### 5.1 再蒸留時の候補集合

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

###### 5.2 collapse — 同一 thread × 同一 knowledge は active evidence 1 件

同じ thread の複数 candidate が同じ knowledge へ same 判定された場合、一意制約（knowledge_id, thread_id, status=active）に抵触するため commit 前に統合する: comment_ids を和集合、confidence 等は監査情報として candidate イベント側に残す。**active evidence は 1 件だけ。**

###### 5.3 ThreadRemoved

レビューコメントは削除されうる。**完全取得済み snapshot 同士の比較**で:

- previous complete snapshot に存在 ∧ current complete snapshot に不在 → `ThreadRemoved` 観測イベント → 当該 thread の active evidence を `withdrawn`
- 部分取得・GraphQL error 時には削除判定を行わない（v0.2.1 §7.2 の原則を維持）

---

##### 6. EvidenceActor — source の複数主体化（High）

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

##### 7. ETag は実ファイルバイト列の hash（High）

canonicalize 後の hash では frontmatter の並べ替え・空白改行編集・YAML コメント追加・表記調整といった直接編集を検知できない。CAS の目的は「人間が編集した実ファイルの保護」であるため:

```typescript
const etag = sha256(await fs.readFile(knowledgePath));  // 実バイト列
```

`semantic_etag` を別途持つのは可だが、**CAS の precondition には使用しない**。

YAML 書式について M1 では次を仕様化する: 「ツール経由の更新は frontmatter を再 serialize するため、YAML コメント・キー順序・引用スタイルは保持されない」。CST 保持パーサの導入は将来課題として README に明記（人間編集の主対象は本文 Markdown であり、frontmatter の書式喪失は許容範囲と判断）。

---

##### 8. Evidence 追加の Markdown 非依存化と frontmatter スリム化（High）

###### 8.1 問題

evidence の正本はイベントログなのに、追加を Markdown CAS 経路に通すと、人間が本文を編集した直後の正当な evidence 取り込みが ETag conflict で失敗する。ingest のたびに md 差分も発生し、git 共有時のノイズになる。

###### 8.2 仕様（推奨案を採用）

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

##### 9. Admin plane の位置づけ修正と M1 の選択（High）

表現を次に確定する:

> MCP plane / admin plane 分離は、**MCP tool 経由の権限昇格を防ぐ運用境界**である。同一 OS ユーザーとして任意 shell 実行・ファイル書き込みが可能なエージェントに対する**セキュリティ境界ではない**。

M1 は**安全優先**を採用する:

- `approve` / `reject` / `add --active` に `--yes` を**提供しない**。実 TTY での対話操作のみ
- SECURITY.md に上記の境界定義と、同一ユーザー shell からの迂回可能性を明記
- `--yes` の導入（cron 等での一括承認）は、エージェント側で `~/.repo-knowledge` と admin CLI を deny 設定できることを確認したうえで M2 以降に再検討

---

##### 10. distillation_key は version 文字列ではなく digest（High）

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

##### 11. fingerprint の決定性（High）

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

##### 12. 追加受け入れテスト（既存 24 件に追加）

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

##### 13. 実装ステータス

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

<a id="write-path-v023"></a>

### 3.2 v0.2.3 統合層

#### repo-knowledge-mcp 設計補遺 v0.2.3 — Write Path Freeze 最終確定

- Version: 0.2.3（v0.2 / v0.2.1 / v0.2.2 への追補。優先順位: **v0.2.3 > v0.2.2 > v0.2.1 > v0.2**）
- Date: 2026-08-06
- Status: 最終 freeze 条件 4 点を反映 — **Write Path Freeze: PASS**

##### 0. v0.2.2 からの差し替え対応表

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

##### 1. Receipt と ephemeral handle の分離（Blocker 1）

###### 1.1 問題

v0.2.2 は「response をそのまま receipt に保存」「token は hash のみ保存」「FinalizeContext は ephemeral」を同時に定めており、両立しない。response をそのまま保存すれば平文 finalize_token が正本 JSONL に残り、保存しなければ extract のレスポンス消失時に同じ token を返せず、返せたとしても再起動後は Context が消えていて使えない。

###### 1.2 receipt は「安定部分」のみを保存する

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

###### 1.3 replay 規則

| 状況 | 動作 |
|---|---|
| finalize の同一 submission replay | receipt の stable_response を完全再生 |
| extract の同一 submission replay・lease 有効 | stable_response を再利用し、**新しい** finalize token と最新 possible_matches を発行 |
| extract の同一 submission replay・lease 失効 | `RESUME_REQUIRED` |
| prepare 時に job が awaiting_finalize | extract receipt の candidate set を再利用し、新 lease・新 token・最新 possible_matches を返す（再抽出しない） |
| 同じ phase が別 submission_id で commit 済み・request_sha256 同一 | committed receipt を replay |
| 同じ phase が別 submission_id で commit 済み・request_sha256 相違 | `PHASE_ALREADY_COMMITTED` |

###### 1.4 receipt 照合は lease / token 検証より先

```
1. submission_id で receipt 検索
2. request_sha256 一致 → 保存済み stable_response を返す（ここで終了）
3. receipt なし → lease / token 検証へ
```

この順序でないと、成功済み finalize を token 期限切れ後に再送した際、成功結果ではなく STALE_LEASE が返ってしまう。

---

##### 2. knowledge_file_state — Markdown 直接編集の失効検知（Blocker 2）

###### 2.1 問題

dirty marker を「未削除の committed manifest」に置いたが、人間の直接編集は manifest を作らない。active → rejected の直接変更・scope 変更・ファイル削除後も、get_rules が古い active ルールを返し続ける。ETag は**書き込み競合**の検知であり、**read projection の失効**検知ではない。

###### 2.2 仕様（自動差分投影を採用）

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

###### 2.3 ファイル削除のセマンティクス

直接削除された knowledge は投影から除去され、以後 get_rules / search に現れない。関連 evidence イベントは残り、doctor が orphan として報告する。運用上の推奨は削除ではなく `status: rejected` への編集（履歴・監査が保たれる）。README に明記する。

---

##### 3. Canonical JSONL Record Envelope と復旧手順（Blocker 3）

###### 3.1 全 canonical JSONL レコードの統一形式

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

###### 3.2 append の実装契約

- `write()` が全 bytes を書くと仮定せず、bytesWritten が全長に達するまでループする
- `target_path` / `staged_path` は絶対パス禁止。repo root 配下の正規化済み relative path のみ（`..`・symlink escape 拒否）

###### 3.3 recovery 手順（この順序で固定）

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

##### 4. Finalize 時の match set 再検証（Blocker 4）

###### 4.1 問題

FinalizeContext の revision / ETag / status 束縛は「既存候補の変更」しか検出できない。並行する Job A / B が同種 candidate をそれぞれ possible_matches 空で extract すると、A の finalize で kn_A が生まれても B は「different → kn_B 新規作成」を通過でき、重複ルールが生成される。

###### 4.2 仕様

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

###### 4.3 merge 候補検索の範囲

通常検索（active 固定）と異なり、merge 用候補検索は **active + proposed + 当該 thread の previous evidence 由来の stale** を含める。rejected / deprecated は除外。proposed を検索対象に含めないと、複数 AI レビューから同じ proposed ルールが量産される。

###### 4.4 exact duplicate の collapse

同一 candidate set 内で正規化 rule が完全一致する candidate は commit 前に統合する（意味的重複の判定まではサーバーに求めない。exact 一致のみ）。

---

##### 5. canonicalJson / hash 仕様の固定（High）

###### 5.1 仕様

TS / Rust 間・再起動後の digest 決定性のため、次を永続仕様とする:

```
canonical_json_version: jcs-rfc8785-v1   # RFC 8785 JSON Canonicalization Scheme
encoding: UTF-8
hash: SHA-256
hex: lowercase
表記: `sha256:${hex}`
```

###### 5.2 集合配列の事前正規化

JCS は配列順序を変えないため、**意味的に集合である配列は JCS 適用前に sort + dedupe** する: trustedActorIds / trustedLogins / sources / scope（OR 集合）/ possible match IDs / candidate IDs / evidence_comment_ids。会話順など順序に意味がある配列（normalized_comments 等）は保持する。

###### 5.3 distillation_input_digest — actor を含める

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

##### 6. 0 candidate の完全性と finalize 検証（High）

###### 6.1 0 candidate は「skip + 撤回処理」を単一 transaction で行う

candidates が 0 件の extract は finalize 不要だが、単なる job skipped ではない。**同一 canonical transaction** で次をすべて行う:

1. extract receipt 追加
2. DistillationJobSkipped 追加
3. 当該 thread の旧 active evidence を withdrawn
4. evidence_count 再計算（投影）
5. 必要なら knowledge を stale へ遷移
6. SQLite 投影更新

これを欠くと、撤回されたレビュー由来のルールが active のまま残る。

###### 6.2 finalize の完全性検証

- 部分的な decisions を受け入れない: **submitted candidate_id 集合 == extract 時 candidate_id 集合** を必須とする
- `same` / `overlaps` → target_id 必須、`different` → target_id 禁止
- target_id は possible_matches に含まれること
- candidate_id の重複禁止、decision の不足・余分の禁止
- evidence_comment_ids は対象 thread の**現在の complete snapshot** に存在する comment ID の部分集合であることをサーバーが検証
- **originator / actors / sources / trust はモデル出力を信用せず、サーバーが comment ID から導出する**

---

##### 7. COMMITTED marker — committed 遷移の耐久化（High）

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

##### 8. CAS の保証範囲 — commit 区間中の外部編集（High）

外部エディタは repo lock を取得しないため、「precondition 検証 → stage → 人間が編集 → rename」の TOCTOU 窓は lock だけでは閉じられない。次を仕様・README に明記する:

- ETag は「更新**開始前**に存在した編集」を確実に検知する
- canonical transaction の commit 区間中に行われた外部直接編集は、完全な atomic CAS の保証対象外
- 直接編集は transaction 実行中を避ける（commit 区間は短い）
- **file precondition は stage 完了後・適用直前にも再検証**し（stage 作成 → 最終 precondition 再検証 → prepared 永続化 → 即座に適用）、競合窓を最小化する

---

##### 9. 対応 OS の限定（High）

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

##### 10. Complete snapshot の識別子（High）

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

##### 11. 追加受け入れテスト（既存 38 件に追加）

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

##### 12. 実装ステータス

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

<a id="errata"></a>

## 4. Errata

この節は E-01〜E-04、P-01、I-01 を対応要件へ反映する。
v0.2.3 までの write path 構造は変更しない。
受け入れテスト 55〜63 は [6.2 の対応表](#acceptance-tests-55-63-trace) から要件と実装へ追跡できる。

### repo-knowledge-mcp 設計 Errata（v0.2.3 対応）

- **日付**：2026-08-06
- **位置づけ**：v0.2.3 への errata。
  write path の構造は変更しない。
  実装時の解釈差を閉じる確定事項である。
- **ステータス**：**Architecture Gate、Mutation Path Gate、Write Path Freeze はすべて PASS**。
  設計レビューは完了した。
  以降は kill-point テストと projection 整合テストから得た事実のみを errata として追記する。

<a id="errata-e01"></a>

#### E-01：receipt replay の phase 別分岐

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

<a id="errata-e02"></a>

#### E-02：request_sha256 の対象フィールド

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

<a id="errata-e03"></a>

#### E-03：finalize と元レビュー世代の bind

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

<a id="errata-e04"></a>

#### E-04：locale に依存しない集合配列の sort 規則

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

<a id="policy-p01"></a>

#### P-01：skip_reason ごとの evidence 撤回ポリシー

このポリシーは M1-C のドメインポリシーである。
v0.2.3 §6.1 の「0 candidate → 旧 evidence withdrawn」は、**definitive non-knowledge に限定**する。
「判断できない」状態まで撤回すると、モデルの一時的な判断不能によって有効ルールが stale 化する。

| skip_reason | 既存 evidence |
|---|---|
| typo / praise_or_chitchat / question_without_conclusion / pr_specific | withdrawn 可（撤回パス：receipt + skipped + withdrawal + stale 判定） |
| insufficient_context | 既存 evidence は**維持**し、manual review 対象としてマーク（receipt + skipped のみ、evidence 不変） |
| duplicate_noise | 重複先 knowledge ID が判明した場合のみ再対応付けし、対象不明なら維持 |

これにより、M1-C の着手前提条件は充足する。

<a id="implementation-i01"></a>

#### I-01：M1 の knowledge_file_state

mtime の実精度はプラットフォームに依存するため、path + size + mtime_ns による候補絞りは M1 では採用しない。
M1 では、**read 前に knowledge/*.md 全ファイルの SHA-256 を計算**する。
数百から数千ファイルの規模であれば、実用上の問題はない。
テスト 63「同一 byte size 編集の検出」も、この方式なら自明に通る。

スケール時には、stat tuple を強化し、dev / ino / ctime_ns の追加と定期 full verification へ移行する。
これは推奨 B にあたり、M2 以降で行う。

<a id="acceptance-55-63"></a>

#### 追加受け入れテスト

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

#### 最終ステータスと着手順

- **Status**：実装開始承認
- **Architecture Gate**：PASS
- **Mutation Path Gate**：PASS
- **Write Path Freeze**：PASS
- **Errata E-01〜E-04**：反映済み
- **P-01 と I-01**：確定

##### 着手順

- **M1-A**：即時可。
  kill-point テスト 25、26、44、53 を commit engine より先に作成する。
- **M1-B**：即時可。
- **M1-C**：P-01 が確定済みのため着手可。
- **M1-D**：E-01〜E-03 のテスト 55〜60 を先に作成してから着手する。

##### 以降の設計変更

新規レビューループは行わない。
以降は、実装とテストで得た事実のみを errata として本文書へ追記する。
M1-A 完了時に、v0.2 本体、補遺 3 本、本 errata を v0.3 統合仕様書へ再編する。

#### M1-A 完了時の実装 Errata

次の項目は設計変更ではなく、M1-A の実装と kill-point テストで確認した事実である。

##### F-01：prepared を境界とする kill 後の収束

実プロセスを SIGKILL するテストにより、staged payload 完了後、manifest.tmp 完了後、prepared 完了後、file rename 後、append 後、COMMITTED.tmp 完了後、COMMITTED 完了後、projection 完了後を検証した。
prepared より前の kill は旧 canonical state に収束する。
prepared 以後の kill は recovery によって新 canonical state に収束する。

##### F-02：append 済み record と staged payload の関係

同じ record_id と同じ line_sha256 の完全行が target JSONL に存在する場合は、append 適用済みとして収束する。
この場合は、append 後の kill で staged payload が失われていても再適用を必要としない。
target に record がなく staged payload もない場合は、UNRECOVERABLE_TRANSACTION で fail-closed になる。

##### F-03：projection と直接編集の検知

reindex は knowledge Markdown と canonical JSONL を変更せず、index.sqlite だけを再構築する。
read 前に knowledge/*.md の全実バイト SHA-256 を計算するため、同一 byte size かつ同一 mtime の直接編集も検知する。

##### F-04：repository registry の並行初回登録

異なる二つの repo を並行して初回登録しても、global .registry.lock と exact-byte CAS により repositories.json の両 entry が保持される。
repo rename 後も同じ 32 桁 storage-id を使用し、旧 owner/name は aliases に保持される。

##### F-05：確定技術スタックの実装

SQLite 派生投影は better-sqlite3 と WAL を使用する。
knowledge Markdown は gray-matter に strict YAML engine を組み合わせ、duplicate key と無効 schema を fail-closed で拒否する。

<a id="implementation-facts"></a>

## 5. 実装・テストで確認した事実

この節は設計変更ではなく、M1-A 実装と受け入れテストで観測した事実を記録する。

### 5.1 M1-A の完了範囲

M1-A の Markdown reader/writer、Canonical JSONL envelope、transaction journal、repo writer lock、recovery、reindex、ETag と revision、SQLite projection、repository registry を実装した。
実装の入口は [canonical-transaction-store.ts](../../src/canonical-transaction-store.ts) である。
SQLite projection は v0.2 の確定技術スタックに従い、[better-sqlite3 を用いた派生投影](../../src/sqlite-projection.ts) とした。
gray-matter と strict YAML engine による frontmatter、実バイト ETag は [knowledge-document.ts](../../src/knowledge-document.ts) に実装した。
repo ID を基準にした global registry lock と 32 桁 storage-id は [repository-registry.ts](../../src/repository-registry.ts) に実装した。

### 5.2 kill-point で確認した収束境界

実プロセスを SIGKILL するテストにより、staged payload 完了後、manifest.tmp 完了後、prepared 完了後、file rename 後、append 後、COMMITTED.tmp 完了後、COMMITTED 完了後、projection 完了後の状態を確認した。
prepared より前の kill は旧 canonical state に収束する。
prepared 以後の kill は recovery によって新 canonical state に収束する。
append の最終行が部分書き込みの場合は、破損部分を .corrupt に保存し、最後の正常な改行まで切り戻した後に完全行を再 append する。
prepared 後かつ append 前に staged append が失われた場合は、UNRECOVERABLE_TRANSACTION で fail-closed になる。
同じ record_id が同じ実バイトで append 済みなら、staged append が cleanup 前に失われても適用済みとして収束する。
同じ record_id の実バイトが異なる場合は、RECORD_ID_CONFLICT で fail-closed になる。
これらは [canonical transaction の受け入れテスト](../../test/canonical-transaction-store.test.ts) で固定した。

### 5.3 read isolation と projection

read と write は同じ repo lock を取得するため、file rename 済みかつ event append 前の混在 snapshot は返らない。
COMMITTED 後かつ SQLite checkpoint 前の kill は、次の read または recovery で projection を再構築する。
reindex は knowledge Markdown と canonical JSONL を変更せず、index.sqlite だけを再構築する。
knowledge/*.md は read 前に全ファイルの実バイト SHA-256 を計算するため、同一 byte size かつ同一 mtime の直接編集も projection 失効として検知する。
duplicate knowledge ID、duplicate YAML key、無効な schema、無効な UTF-8 は古い projection を返さず KNOWLEDGE_STORE_INVALID で fail-closed になる。

### 5.4 registry の並行性

repositories.json の初回登録と rename 更新は global .registry.lock と exact-byte CAS を通る。
異なる二つの repo を並行登録しても両方の entry が残ることをテストした。
repo rename 後も repo ID から導いた同じ 32 桁 storage-id を使用し、旧 owner/name は aliases に残る。

<a id="acceptance-tests"></a>

## 6. 受け入れテストの追跡

### 6.1 テスト範囲 1〜54

| テスト番号 | 要件の統合先 | 元文書 |
|---|---|---|
| 1〜12 | [Architecture](#architecture-v02) の M1 完了条件 | v0.2 §19 |
| 13〜24 | [Mutation Path](#mutation-v021) の M1 受け入れテスト | v0.2.1 §11 |
| 25〜38 | [v0.2.2 Write Path](#write-path-v022) の追加受け入れテスト | v0.2.2 §12 |
| 39〜54 | [v0.2.3 Write Path](#write-path-v023) の追加受け入れテスト | v0.2.3 §11 |

<a id="acceptance-tests-55-63-trace"></a>

### 6.2 テスト 55〜63 の要件・実装対応

| テスト | 対応要件 | 実装テスト |
|---|---|---|
| 55 | [E-01 receipt replay の phase 別分岐](#errata-e01) | [receipt-replay.test.ts](../../test/receipt-replay.test.ts) |
| 56 | [E-01 の 0 candidate stable response](#errata-e01) | [receipt-replay.test.ts](../../test/receipt-replay.test.ts) |
| 57 | [E-02 request_sha256 の対象フィールド](#errata-e02) | [request-integrity.test.ts](../../test/request-integrity.test.ts) |
| 58 | [E-02 submission と request hash の 1 対 1 bind](#errata-e02) | [request-integrity.test.ts](../../test/request-integrity.test.ts) |
| 59 | [E-03 content_fingerprint bind](#errata-e03) | [finalize-guard.test.ts](../../test/finalize-guard.test.ts) |
| 60 | [E-03 distillation_key bind](#errata-e03) | [finalize-guard.test.ts](../../test/finalize-guard.test.ts) |
| 61 | [E-04 unsigned UTF-16 code unit sort](#errata-e04) | [canonical.test.ts](../../test/canonical.test.ts) |
| 62 | [P-01 skip_reason policy](#policy-p01) | [evidence-policy.test.ts](../../test/evidence-policy.test.ts) |
| 63 | [I-01 全 knowledge Markdown の実バイト SHA-256](#implementation-i01) | [knowledge-file-state.test.ts](../../test/knowledge-file-state.test.ts)、[canonical-transaction-store.test.ts](../../test/canonical-transaction-store.test.ts) |

<a id="source-traceability"></a>

## 7. 元文書から v0.3 への追跡

| 元文書 | 元の範囲 | v0.3 の統合先 |
|---|---|---|
| [v0.2 本体](./repo-knowledge-mcp-v0.2.md) | Implementation Gate、§1〜§21、付録 A・B | [1. Architecture](#architecture-v02) |
| [v0.2.1 補遺](./repo-knowledge-mcp-v0.2.1-supplement.md) | 差し替え表、§1〜§12 | [2. Mutation Path](#mutation-v021) |
| [v0.2.2 補遺](./repo-knowledge-mcp-v0.2.2-supplement.md) | 差し替え表、§1〜§13 | [3.1 v0.2.2 Write Path](#write-path-v022) |
| [v0.2.3 補遺](./repo-knowledge-mcp-v0.2.3-supplement.md) | 差し替え表、§1〜§12 | [3.2 v0.2.3 Write Path](#write-path-v023) |
| [v0.2.3 Errata](./repo-knowledge-mcp-v0.2.3-errata.md) | E-01〜E-04、P-01、I-01、テスト 55〜63 | [4. Errata](#errata) と [6.2 対応表](#acceptance-tests-55-63-trace) |

各統合層には元文書本文を保持している。
差し替え箇所は 0.3 節の索引と各補遺の差し替え表から双方向に確認できる。

<a id="open-questions"></a>

## 8. 未決事項

Issue RKM-ERRATA-023-TASK-007 の統合範囲に未決事項はない。
M1-B、M1-C、M1-D の実装状況はロードマップ上の状態であり、本統合によって設計を変更しない。

<a id="acceptance-criteria"></a>

## 9. 受け入れ条件

- [x] v0.2 本体、補遺 3 本、Errata の確定事項を単一文書内に保持した。
- [x] Architecture、Mutation Path、Write Path の構造を維持した。
- [x] E-01〜E-04、P-01、I-01 の意味と制約を変更していない。
- [x] 受け入れテスト 55〜63 を対応要件と実装テストへ結び付けた。
- [x] 実装とテストで確認した事実だけを 5 節へ追加した。
- [x] 元文書から v0.3 の統合節へ追跡できる。
- [x] Markdown の相対リンクと明示 anchor をローカル検証対象にした。
- [x] M1-A の kill-point、projection、registry テストを含むローカル検証が成功した。

<a id="stats-contract"></a>

## 10. M2 stats 集計契約

この節は M2 の `stats`（v0.2 本体 §3.1 で「集計定義確定後」とした項目）が返す集計の正規契約を定義する。
実装は read service 層の [stats-read-service.ts](../../src/stats-read-service.ts) であり、MCP / CLI への公開はこの契約に従う後続タスクの範囲とする。

<a id="stats-schema-version"></a>

### 10.1 schema version と決定性

- response には `stats_schema_version: 1` を必ず含める。集計の意味・キー・単位を変える変更は version を増やす。
- stats は canonical snapshot（knowledge Markdown + canonical JSONL）と repo-local な sync checkpoint だけから導出する純関数であり、同じ canonical state と同じ request からは常に同一の response が得られる。壁時計や生成時刻を response に含めない。
- response には canonical state の識別子として `canonical_digest`（canonical ファイル hash 集合の JCS SHA-256）を含める。`reindex` は正本を変更しないため（v0.2.1 §1.5）、reindex 前後で digest を含む全集計値が一致する。

<a id="stats-window"></a>

### 10.2 時刻範囲・bucket・timezone

- request は `{ bucket?: "total" | "day", since?: string, until?: string }`。`since` / `until` は offset 付き ISO 8601（`Z` を含む）とし、受理後は UTC instant へ正規化して response の `window` に返す。
- 期間は半開区間 `[since, until)`。`since` ちょうどの instant は含み、`until` ちょうどの instant は含まない。`since >= until` は `INVALID_STATS_WINDOW` として拒否する。
- timezone の意味を固定する: 入力 offset は instant の解釈のみに使い、bucket 境界と day キーはすべて UTC（`window.timezone: "UTC"` 固定）。例えば `2026-08-02T00:30:00+09:00` は UTC instant `2026-08-01T15:30:00Z` として day bucket `2026-08-01` に属する。
- `bucket: "total"`（既定）は期間全体を 1 集計で返し `buckets: null` とする。`bucket: "day"` は `since` と `until` の両方を必須とし（欠落は `STATS_WINDOW_REQUIRED`）、`[since, until)` と交差する UTC 暦日を昇順で全列挙する。観測が 0 件の日も 0 埋めで含める。day bucket 数が 366 を超える window は `STATS_WINDOW_TOO_LARGE` として拒否する。
- 期間 filter は時刻を持つ観測列（evidence の `observed_at`、outcome の `at`）にのみ適用する。knowledge / job / sync は「現在状態」の点集計であり、window の影響を受けない。

<a id="stats-aggregates"></a>

### 10.3 集計定義

すべての分類は §6 で確定した enum を全キー列挙し、該当 0 件でもキーを 0 で返す。空集合の意味は「キー欠落」ではなく「値 0」に固定する。

| section | 定義 |
| --- | --- |
| `knowledge.total` / `by_status` / `by_category` / `by_severity` | 当該 repository の knowledge Markdown 全件（全 status）を frontmatter で分類する |
| `evidence.total` / `by_status` | window 内に observed された evidence を件数と status（active / superseded / withdrawn）で分類する |
| `evidence.by_source` | 同じ evidence 集合を source provider で分類する。1 evidence が複数 source を持つ場合は各 source に 1 ずつ数えるため、`by_source` の合計は `total` を超えうる |
| `evidence.eligible_for_count` | window 内 evidence のうち status=active かつ `eligible_for_count: true` の件数。knowledge の `evidence_count` と同じ資格判定を使う |
| `outcomes.total` / `by_type` | window 内の OutcomeRecorded（§6.4）を outcome 種別（applied / violated / not_applicable / false_positive）で分類する |
| `jobs.total` / `by_state` | distill job の現在状態（pending / processing / awaiting_finalize / done / skipped / failed。§9.2 と v0.2.1 §3 の拡張）を分類する |
| `sync.last_checkpoint` | sync checkpoint の cursor（`last_pr_number` / `last_updated_at`）と checkpoint の `updated_at`。未同期 repository は `null` |
| `operations` | `pending_jobs` / `failed_jobs`（`jobs.by_state` の再掲）と `last_sync_checkpoint_at`。cron 同期運用（§19 M2）の監視入口とする |

<a id="stats-read-boundary"></a>

### 10.4 read 境界と repository 分離

- stats read は knowledge read と同じ一貫 projection 読み口（readKnowledgeView）だけを使う。read 前の canonical 検証と projection 再構築（[F-03](#implementation-facts) の性質）をそのまま継承し、SQLite にしか存在しない値を集計に使わない。
- すべての集計は resolve 済み repo_id で filter する。別 repository の knowledge / evidence / outcome / job は response に混入しない。
- sync checkpoint は repository storage 配下の repo-local ファイルから読み、cursor の repo_id が resolve 済み repo_id と一致しない場合は `STATS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH` で fail-closed にする。

<a id="stats-fixed-tests"></a>

### 10.5 テストで固定した性質

固定 fixture の全集計、空 repository の 0 埋め、期間境界（境界 instant の包含 / 排他、`+09:00` offset の UTC day 割り当て）、reindex 前後の全集計一致、cross-repository 非混入と checkpoint mismatch の fail-closed は、[stats read service の受け入れテスト](../../test/stats-read-service.test.ts) で固定する。

<a id="outcome-ranking-policy"></a>

## 11. M2 outcome ランキング policy

この節は M2 の `record_outcome`（§6.4）が蓄積する 4 種類の outcome を検索ランキング（§13）へ反映する正規 policy を定義する。
実装は [knowledge-search.ts](../../src/knowledge-search.ts) の `OUTCOME_RANKING_POLICY` / `outcomeScore` であり、evidence（§6.3）と outcome を混同しないこと、自己強化ループを bounded signal として抑えることを目的とする。

<a id="outcome-ranking-semantics"></a>

### 11.1 outcome 種別のランキング上の意味

| outcome | 意味 | ランキング効果 |
| --- | --- | --- |
| `applied` | エージェントがルールを適用して成功した | bounded な正の boost。最小 sample 未満は無効 |
| `violated` | ルール違反が実際に観測された（ルールが現実の問題を捉えている証拠） | M1 の violation boost（weight 0.05 / 上限 0.15）を維持し、outcome score では二重計上しない |
| `not_applicable` | ルールが提示されたが状況に適合しなかった | bounded な負の減衰。正の項には決してならない |
| `false_positive` | ルールの指摘自体が誤りだった | bounded な負の penalty。正の項には決してならない |

outcome は evidence とは独立のシグナルであり、`evidence_count` 由来の boost（weight 0.15 / 上限 0.3）とは項を分離する。

<a id="outcome-ranking-score"></a>

### 11.2 outcome score の定義

第 2 段再ランキング（§13）のスコアへ、独立項として bounded な outcome score を加算する。

```typescript
score =
  reciprocalRank(textRank) +
  severityBoost(severity) +
  evidenceBoost(evidenceCount) +
  violationBoost(violationCount) +   // M1 と同一
  outcomeScore(counts);              // M2 追加項

outcomeScore(counts) =
  appliedBoost(counts.appliedCount) -
  notApplicablePenalty(counts.notApplicableCount) -
  falsePositivePenalty(counts.falsePositiveCount);

appliedBoost(n)        = n < minAppliedSample ? 0 : min(0.2, 0.1 * log1p(n))
notApplicablePenalty(n) = min(0.1, 0.05 * log1p(n))
falsePositivePenalty(n) = min(0.25, 0.125 * log1p(n))
```

固定する性質:

- **M1 互換**: outcome が 0 件のとき `outcomeScore = 0` であり、順位は M1 と完全に一致する。
- **最小 sample（無効化規則）**: `applied` は `minAppliedSample = 3` 件未満では boost にならない。少数の自己申告 event が自己強化ループを開始できないための下限であり、penalty 側は 1 件目から作用させる（早期に下げる方向は fail-safe、早期に上げる方向は fail-unsafe）。
- **上限**: 各項は log1p + cap で飽和し、outcome score 全体は `[-0.35, +0.2]` に収まる。大量の同種 outcome を投入しても定義上限を超えない。隣接 text rank 間の reciprocal rank 差（先頭は 0.5）を無条件には超えられない設計とする。
- **単調性**: `not_applicable` / `false_positive` の追加は score を増加させず、`applied` の追加は score を減少させない。
- **決定性と減衰不採用**: score は outcome 件数のみの純関数であり、壁時計に依存する時間減衰は採用しない（同じ event 集合から常に同一の score と順位が得られる。stats の決定性原則 §10.1 と同じ理由）。時間減衰は policy version を上げて将来検討する。

count の導出は projection（[domain-projection.ts](../../src/domain-projection.ts) の `appliedCount` / `violationCount` / `notApplicableCount` / `falsePositiveCount`）が行い、`event_id` 冪等化（§6.4）を経た OutcomeRecorded のみを数える。

<a id="outcome-ranking-policy-version"></a>

### 11.3 policy version と定数の追跡

- 定数一式は `OUTCOME_RANKING_POLICY`（frozen object）として単一定義し、`version: "m2-outcome-v1"` を持つ。定数・式・最小 sample のいずれかを変える変更は policy 変更であり、version を必ず更新する。
- SQLite 側は derived 列（`not_applicable_count` / `false_positive_count`）を追加したため `PROJECTION_SCHEMA_VERSION = "3"` へ更新し、旧 schema の index.sqlite は open 時に drop → 完全再構築される（正本は変更しない）。
- golden report（§11.4）は `policy` オブジェクトをそのまま埋め込むため、policy の変更は report の diff と version 差分として機械的に現れる。

<a id="outcome-ranking-golden"></a>

### 11.4 golden 評価と report

`applied` / `violated` / `false_positive` / `not_applicable` が混在する ranking golden fixture を
[m2-outcome-ranking-golden.json](../../test/fixtures/golden/m2-outcome-ranking-golden.json) に固定し、
[outcome-ranking-golden.ts](../../src/outcome-ranking-golden.ts) の `evaluateOutcomeRankingFixture` が
同一候補集合を **M1 baseline policy** と **M2 outcome policy** の双方で決定的に順位付けして比較 report を生成する（`npm run golden` の 2 本目として [golden-cli.ts](../../src/golden-cli.ts) から実行する）。

report には次を含める:

- 双方の `search_mrr` / `search_ndcg`（§18.1 と同じ定義）と delta
- human ranking rubric（「applied 実績のあるルールは false_positive 連発ルールより上」等の pairwise 期待）の policy 別 pass/fail と pass rate
- `policy`（version + 全定数）と query ごとの両 ranking

固定する受け入れ性質（[outcome-ranking-golden.test.ts](../../test/outcome-ranking-golden.test.ts)、[knowledge-search.test.ts](../../test/knowledge-search.test.ts)）:

1. outcome 0 件の query は両 policy で同一順位
2. `false_positive` / `not_applicable` はルール順位を無条件に押し上げない
3. 大量の同種 outcome でも boost / penalty が定義上限で飽和する
4. 同じ event 集合から決定的な score と順位が得られる（再検索・reindex 後も一致）
5. policy 変更が golden report と version 差分に現れる

## 12. M2 code example grounding 契約

Architecture §6.2 が M2 に課す「入力 diff またはレビュー本文に根拠がある例のみ具体コード化する / 架空の関数名・型名・パッケージ名を生成しない」を、schema と prompt だけでなく **content 本文の機械的検証**として固定する。実装は [code-example-grounding.ts](../../src/code-example-grounding.ts)。

### 12.1 検証の合流点（3 経路）

`code_example` を含む candidate は、次の 3 経路すべてで同一の grounding 検証を通過しない限り canonical に到達しない。

| 経路 | 実装 | 失敗時 |
|---|---|---|
| provider 出力パース | `parseDistillationOutput`（[provider-distillation-service.ts](../../src/provider-distillation-service.ts)） | `DISTILLATION_OUTPUT_INVALID`（json_validation として 1 回だけ再試行 → failed） |
| submit extract / 再水和 | `validateCandidateEvidenceComments`（[submit-distillation-service.ts](../../src/submit-distillation-service.ts)） | `EVIDENCE_COMMENTS_INVALID` |
| canonical finalize | `validateCandidateEvidenceComments`（[canonical-finalize-service.ts](../../src/canonical-finalize-service.ts)） | `EVIDENCE_COMMENTS_INVALID`（書き込み前に拒否） |

### 12.2 トークン規則（決定的・fail-closed）

`code_example.content` から**参照位置のトークン**だけを字句的に抽出する:

1. 呼び出し: `(` が直後に続く識別子（`invoke(`）
2. メンバー参照: `.` の直後の識別子（`.isErr`）
3. メンバー根: 識別子が `.` + 識別子に先行する場合（`superMagicFramework.doEverything` の根）。ただし content 内で宣言キーワード（`catch|class|const|def|enum|fn|for|fun|function|interface|let|struct|trait|type|val|var`）に続いて宣言された名前は除外
4. 構築: `new` 直後の識別子
5. モジュール参照: `import` / `from` / `use` 直後の識別子・パス、および `from` / `import` / `require(` に続く引用符付き specifier

抽出後、次を除外する:

- 長さが `CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH = 3` 未満のトークン
- frozen リスト `CODE_EXAMPLE_GENERIC_TOKENS`（言語横断キーワードと汎用 builtin。リスト全体はテスト [code-example-distillation.test.ts](../../test/code-example-distillation.test.ts) で完全固定し、追加・削除は仕様変更として扱う）

判定は **case-insensitive** で行う。根拠テキストは `code_example.evidence_comment_ids` が引用する comment の body + diff_hunk の連結に限定する（thread の他コメントは根拠にならない）。識別子トークンは根拠テキストの識別子トークン集合への完全一致、モジュール specifier は部分文字列一致で照合する。1 つでも照合できないトークンがあれば **fail-closed で拒否**する（引用 comment が現存しない場合は根拠テキストが空になり、同様に拒否される）。

この規則の限界: untrusted コメント自体が架空 API 名を本文に含む場合、字句照合は通過しうる。その永続化は trust policy（§11）と proposed 既定 status が防ぐ二重防御であり、grounding 検証は provider の幻覚（根拠に現れない名前の生成）を対象とする。

### 12.3 テストで固定した性質

- 有効な comment ID + `generated_example: true` でも、content が引用根拠に現れないトークンを参照する場合は 3 経路すべてで拒否される（fixture `grounded-id-fabricated-content`、[code-example-distillation.json](../../test/fixtures/code-example-distillation.json)）
- diff_hunk のみに現れる API は根拠として有効
- 宣言済みローカル変数・3 文字未満・generic トークンは grounding を要求しない
- `CODE_EXAMPLE_GENERIC_TOKENS` と最小長はテストで完全固定

## 12. M2 code example grounding 契約

Architecture §6.2 が M2 に課す「入力 diff またはレビュー本文に根拠がある例のみ具体コード化する / 架空の関数名・型名・パッケージ名を生成しない」を、schema と prompt だけでなく **content 本文の機械的検証**として固定する。実装は [code-example-grounding.ts](../../src/code-example-grounding.ts)。

### 12.1 検証の合流点（3 経路）

`code_example` を含む candidate は、次の 3 経路すべてで同一の grounding 検証を通過しない限り canonical に到達しない。

| 経路 | 実装 | 失敗時 |
|---|---|---|
| provider 出力パース | `parseDistillationOutput`（[provider-distillation-service.ts](../../src/provider-distillation-service.ts)） | `DISTILLATION_OUTPUT_INVALID`（json_validation として 1 回だけ再試行 → failed） |
| submit extract / 再水和 | `validateCandidateEvidenceComments`（[submit-distillation-service.ts](../../src/submit-distillation-service.ts)） | `EVIDENCE_COMMENTS_INVALID` |
| canonical finalize | `validateCandidateEvidenceComments`（[canonical-finalize-service.ts](../../src/canonical-finalize-service.ts)） | `EVIDENCE_COMMENTS_INVALID`（書き込み前に拒否） |

### 12.2 トークン規則（決定的・fail-closed）

`code_example.content` から**参照位置のトークン**だけを字句的に抽出する:

1. 呼び出し: `(` が直後に続く識別子（`invoke(`）
2. メンバー参照: `.` の直後の識別子（`.isErr`）
3. メンバー根: 識別子が `.` + 識別子に先行する場合（`superMagicFramework.doEverything` の根）。ただし content 内で宣言キーワード（`catch|class|const|def|enum|fn|for|fun|function|interface|let|struct|trait|type|val|var`）に続いて宣言された名前は除外
4. 角括弧メンバー参照: 識別子・`)`・`]` の直後に続く `["name"]` / `['name']` の引用符内文字列のうち識別子パターンに合致するもの（`client["fabricatedApi"]`）。配列リテラル等、受け手が直前にない `["..."]` は対象外
5. 構築: `new` 直後の識別子
6. 型参照: **大文字始まり**の識別子（`[A-Z][A-Za-z0-9_$]*`）が次の構文位置に現れる場合に限る — `:` の直後（型注釈。`const value: FabricatedType`）、`as` の直後（型アサーション）、`<` の直後（ジェネリクス第 1 引数）、`extends` / `implements` の直後。小文字始まりの識別子はこれらの位置では対象外（誤検知抑制）。content 内で宣言された型名（規則 3 の宣言キーワードによる）は除外
7. モジュール参照: `import` / `from` / `use` 直後の識別子・パス、および `from` / `import` / `require(` に続く引用符付き specifier

抽出後、次を除外する:

- 長さが `CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH = 3` 未満のトークン
- frozen リスト `CODE_EXAMPLE_GENERIC_TOKENS`（言語横断キーワード・汎用 builtin・標準ライブラリ型名（`Promise` / `Result` / `Vec` 等は小文字表記で収載し case-insensitive に照合）。リスト全体はテスト [code-example-distillation.test.ts](../../test/code-example-distillation.test.ts) で完全固定し、追加・削除は仕様変更として扱う）

判定は **case-insensitive** で行う。根拠テキストは `code_example.evidence_comment_ids` が引用する comment の body + diff_hunk の連結に限定する（thread の他コメントは根拠にならない）。識別子トークンは根拠テキストの識別子トークン集合への完全一致、モジュール specifier は部分文字列一致で照合する。1 つでも照合できないトークンがあれば **fail-closed で拒否**する（引用 comment が現存しない場合は根拠テキストが空になり、同様に拒否される）。

この規則の限界: untrusted コメント自体が架空 API 名を本文に含む場合、字句照合は通過しうる。その永続化は trust policy（§11）と proposed 既定 status が防ぐ二重防御であり、grounding 検証は provider の幻覚（根拠に現れない名前の生成）を対象とする。

### 12.3 テストで固定した性質

- 有効な comment ID + `generated_example: true` でも、content が引用根拠に現れないトークンを参照する場合は 3 経路すべてで拒否される（fixture `grounded-id-fabricated-content`、[code-example-distillation.json](../../test/fixtures/code-example-distillation.json)）
- 角括弧メンバー参照（`client["fabricatedApi"]()`）と型注釈（`const value: FabricatedType`）の架空名も拒否される（fixture `bracket-and-type-fabrication`）
- diff_hunk のみに現れる API は根拠として有効
- 宣言済みローカル変数・3 文字未満・generic トークンは grounding を要求しない
- `CODE_EXAMPLE_GENERIC_TOKENS` と最小長はテストで完全固定

## 12. M2 code example grounding 契約

Architecture §6.2 が M2 に課す「入力 diff またはレビュー本文に根拠がある例のみ具体コード化する / 架空の関数名・型名・パッケージ名を生成しない」を、schema と prompt だけでなく **content 本文の機械的検証**として固定する。実装は [code-example-grounding.ts](../../src/code-example-grounding.ts)。

### 12.1 検証の合流点（3 経路）

`code_example` を含む candidate は、次の 3 経路すべてで同一の grounding 検証を通過しない限り canonical に到達しない。

| 経路 | 実装 | 失敗時 |
|---|---|---|
| provider 出力パース | `parseDistillationOutput`（[provider-distillation-service.ts](../../src/provider-distillation-service.ts)） | `DISTILLATION_OUTPUT_INVALID`（json_validation として 1 回だけ再試行 → failed） |
| submit extract / 再水和 | `validateCandidateEvidenceComments`（[submit-distillation-service.ts](../../src/submit-distillation-service.ts)） | `EVIDENCE_COMMENTS_INVALID` |
| canonical finalize | `validateCandidateEvidenceComments`（[canonical-finalize-service.ts](../../src/canonical-finalize-service.ts)） | `EVIDENCE_COMMENTS_INVALID`（書き込み前に拒否） |

### 12.2 トークン規則（網羅方式・決定的・fail-closed）

構文位置を列挙するホワイトリスト方式は optional chaining（`fabricatedApi?.()`）・複合型（`Map<string, FabricatedType>`、union）・`satisfies` 等の抜け道が構造的に残るため、**網羅方式**を採用する。構文位置に依存せず、content 内のすべての識別子が検証対象になる。

1. **候補**: `code_example.content` 内のすべての識別子トークン。識別子は Unicode property escapes で定義する（開始 `[\p{L}\p{Nl}_$]`、継続 `[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]`、`u` フラグ）。`réponse` や `Δx` のような Unicode 識別子も対象であり、content 側と根拠側の tokenize は同一規則で行う。**文字列リテラル・コメント内のトークンも含む**（`client["fabricatedApi"]` の引用符内メンバー名やエラーメッセージ文字列もデータとして扱う）。唯一の例外は次項 3 で specifier 扱いになる引用符内文字列の内部で、specifier 全体として照合するため識別子パスからは除外し、package 名の断片が単語単位で根拠化される抜け道と二重報告を避ける
2. **決定的除外**: 次のいずれかに該当するトークンは grounding を要求しない
   - **ASCII のみで構成され**、code point 数が `CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH = 3` 未満のトークン。この免除は `id` / `db` / `fs` のような遍在する短い ASCII 慣用名のためのものであり、**非 ASCII を含むトークンは長さに関わらず照合対象**（`Δx` は免除されない）
   - frozen リスト `CODE_EXAMPLE_GENERIC_TOKENS`（言語横断キーワード・汎用 builtin・標準ライブラリ型名。`Promise` / `Result` / `Vec` / `satisfies` 等を小文字表記で収載し case-insensitive に照合。リスト全体はテスト [code-example-distillation.test.ts](../../test/code-example-distillation.test.ts) で完全固定し、追加・削除は仕様変更として扱う）

   **宣言による除外は存在しない**: content 内で宣言された名前（`interface` / `type` / `const` 等による宣言、関数パラメータ、分割代入、import 局所名）も照合対象に含める。宣言 + 使用の形で架空の型・API 名を通す抜け道を構造的に塞ぐためであり、正当な例のローカル変数名が根拠に現れない場合も拒否側に倒す
3. **モジュール参照**: 次のものを module specifier として扱う（いずれも末尾の `.` `:` `/` `-` を除去）
   - `import` / `from` / `use` 直後の識別子・パス
   - `from` / `import` / `import(` / `require(` に続く引用符付き文字列（**動的 import を含む**）
   - 構文位置に関わらず、**specifier 形状**の引用符内文字列 — `@` で始まる、または `/` を含むもの（`import("@scope/fabricated")` のような動的 import や loader 引数を漏れなく捕捉する決定的規則）

   specifier は**境界付き完全一致**で照合する。根拠テキストから specifier 候補集合 — 引用符内文字列と、specifier パターン（`[A-Za-z_$@][A-Za-z0-9_$@:./-]*`）の最大一致（それぞれ末尾句読点 `.` `:` `/` `-` を除去した変形も含める）— を抽出し、specifier 全体が集合の要素と **case-sensitive に完全一致**する場合のみ根拠ありとする。部分文字列照合は行わない（根拠が `@scope/pkg-utils` のとき `@scope/pkg` は拒否される）
4. **照合**: 残った全トークンを根拠テキストと照合し、**未照合が 1 つでもあれば fail-closed で拒否**する

識別子トークンの判定は **case-insensitive**（`String.prototype.toLowerCase` の Unicode 既定挙動で両辺を小文字化し、根拠テキストの識別子トークン集合への完全一致）、モジュール specifier の判定は **case-sensitive**（前項の境界付き完全一致）で行う。根拠テキストは `code_example.evidence_comment_ids` が引用する comment の body + diff_hunk の連結に限定する（thread の他コメントは根拠にならない）。引用 comment が現存しない場合は根拠テキストが空になり、同様に拒否される。

**誤検知の扱い**: 網羅方式では、根拠に現れないローカル慣用名（宣言名・パラメータ名・文字列内の単語等）も拒否側に倒れる。これは fail-closed 設計として仕様上許容する。緩和は generic リストへの追加（= 仕様変更としてテスト固定を更新）でのみ行う。

この規則の限界: untrusted コメント自体が架空 API 名を本文に含む場合、字句照合は通過しうる。その永続化は trust policy（§11）と proposed 既定 status が防ぐ二重防御であり、grounding 検証は provider の幻覚（根拠に現れない名前の生成）を対象とする。

### 12.3 テストで固定した性質

- 有効な comment ID + `generated_example: true` でも、content が引用根拠に現れないトークンを参照する場合は 3 経路すべてで拒否される（fixture `grounded-id-fabricated-content`、[code-example-distillation.json](../../test/fixtures/code-example-distillation.json)）
- 角括弧メンバー参照（`client["fabricatedApi"]()`）と型注釈（`const value: FabricatedType`）の架空名も拒否される（fixture `bracket-and-type-fabrication`）
- 構文位置に依存しない: `fabricatedApi?.()` / `client?.fabricatedMethod()` / `Map<string, FabricatedType>` / `RealType | FabricatedType` / `value satisfies FabricatedType` がいずれも拒否される（fixture `optional-chaining-and-compound-types` と回帰テスト）
- 宣言による回避が拒否される: `interface FabricatedService {}` / `type FabricatedPayload = …` / `const fabricatedCache = …` のように content 内で宣言しても、根拠に現れない名前は拒否される
- モジュール specifier は境界付き完全一致: 根拠が `@scope/pkg-utils` のとき `@scope/pkg` の import は拒否され、完全一致する specifier は受理される
- 動的 import も specifier 全体で照合される: `import("@scope/fabricated")` は、根拠に `scope` と `fabricated` が別々の単語として存在しても拒否され、specifier 完全一致の根拠がある場合のみ受理される
- Unicode 識別子も照合される: `réponse` / `Δx` は根拠になければ拒否され、根拠にあれば受理される（`Δx` は非 ASCII のため最小長免除の対象外）
- diff_hunk のみに現れる API は根拠として有効
- ASCII のみ 3 文字未満・generic トークンは grounding を要求しない
- `CODE_EXAMPLE_GENERIC_TOKENS` と最小長はテストで完全固定
