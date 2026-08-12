# repo-knowledge-mcp

repo-knowledge-mcp は、人間と複数の AI reviewer が Pull Request に残した知見を個人用ローカルストアへ取り込み、監査可能な Markdown rule に蒸留し、Codex、Claude Code、Cursor へ stdio MCP で提供するツールです。
M3 はチーム共通台帳を作らず、利用者ごとの GitHub 権限、信頼対象、利用結果に基づく knowledge を `~/.repo-knowledge/` へ保存します。
外部送信と trusted-human の自動 active 化は既定で無効です。

## 位置づけ

| 製品 | 主な役割 |
|---|---|
| Serena memory | agent が探索して残す project note。onboarding や作業記憶が中心 |
| Bugbot learned rules | PR 上の反応や返信から学び、Bugbot 自身の review を改善する rule |
| repo-knowledge-mcp | 人間と複数 AI reviewer の evidence を vendor-neutral な local store に残し、任意の MCP client へ提供 |

repo-knowledge-mcp の軸は次の 4 点です。

- **Local-first**: canonical data はローカルに置き、LLM への送信は経路ごとの明示 opt-in がない限り行いません。
- **Vendor-neutral**: 特定 reviewer や coding agent に知識を閉じません。
- **Human + multi-AI evidence**: 人間、Devin、Greptile、Bugbot などの由来を evidence として追跡します。
- **Auditable Markdown**: rule の正本は人間が読める Markdown で、イベント履歴から再構築できます。

## 対応環境

| 項目 | M3 の保証範囲 |
|---|---|
| Node.js | 22.13 以降の Node 22、または Node 24 以降 |
| OS | macOS、Linux |
| storage | ローカル filesystem |
| transport | stdio |
| MCP protocol | `2025-11-25` initialize era、`2026-07-28` discover / `_meta` era |

Windows、NFS、SMB、Dropbox、iCloud Drive などの同期領域は保証対象外です。
永続化は POSIX permission、directory fsync、atomic rename、PID lock に依存します。

## セットアップ

GitHub へのアクセスは `gh` CLI に委譲します。
repo-knowledge-mcp は GitHub token を受領・保存しません。

```console
gh auth login
gh auth status
node --version
```

公開 package を一時実行する場合は `npx`、継続利用する場合は global install を使用できます。

```console
npx -y repo-knowledge-mcp --help
npm install --global repo-knowledge-mcp
repo-knowledge --help
```

対象 repository の workspace で guided setup を実行すると、Git remote、`gh` 認証、private storage、外部送信、信頼する人間 reviewer、初回同期を一つの TTY session で設定できます。
外部送信と reviewer trust の質問は既定で `No` です。
初回同期は既定で直近 90 日を対象とし、`--since <iso>` で開始時刻を指定するか、`--all-history` で全履歴を明示できます。

```console
cd /absolute/path/to/repository
repo-knowledge setup

# workspace 外から repository 名を指定する場合
repo-knowledge setup owner/repository --since 2026-05-01T00:00:00Z

# 結果を機械的に読む場合（実 TTY は必要、stdout は JSON 1 document）
repo-knowledge setup owner/repository --json
```

実 TTY では repository 解決、local store 準備、doctor、同期、trust 候補検出を、spinner と経過時間付きの名前付き phase として stderr に表示します。
質問を表示する前に spinner は停止し、完了時は repository、同期件数、外部送信、trust、health、次の操作を人間向けに要約します。
従来の機械可読な全結果が必要な場合は `--json` を付けてください。この場合、stdout には JSON 1 document だけを出力し、progress は表示しません。

中断または部分的な同期失敗後は同じ command を再実行すると、保存済み scope と checkpoint から再開します。
canonical data と setup state は `~/.repo-knowledge/` 配下だけに保存され、対象 workspace へ `.repo-knowledge/` を作成しません。

初回の server 起動または storage を使う command でも `~/.repo-knowledge/` と安全な既定 config を作成します。
保存先を分ける場合は、server と CLI の両方へ同じ `REPO_KNOWLEDGE_HOME` を設定してください。

```console
export REPO_KNOWLEDGE_HOME="$HOME/.repo-knowledge"
repo-knowledge doctor owner/repository
repo-knowledge ingest owner/repository 123
repo-knowledge list owner/repository --status proposed
```

`setup`、`approve`、`reject`、`edit`、`approve-revision`、`add --active` は実 input/output TTY が必要です。

## Codex から使う

Codex の stdio MCP server として登録します。
ChatGPT desktop、Codex CLI、IDE extension は MCP 設定を共有します。

```console
codex mcp add repo-knowledge -- npx -y repo-knowledge-mcp
codex mcp list
```

別の storage root を使う場合は登録時に environment を渡します。

```console
codex mcp add repo-knowledge \
  --env REPO_KNOWLEDGE_HOME=/absolute/private/path \
  -- npx -y repo-knowledge-mcp
```

設定先と CLI の詳細は [OpenAI の Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) を参照してください。

## Claude Code から使う

Claude Code の project-local stdio server として登録します。

```console
claude mcp add repo-knowledge -- npx -y repo-knowledge-mcp
claude mcp get repo-knowledge
```

別の storage root を使う場合は登録時に environment を渡します。

```console
claude mcp add repo-knowledge \
  --env REPO_KNOWLEDGE_HOME=/absolute/private/path \
  -- npx -y repo-knowledge-mcp
```

Claude Code の stdio server 設定形式は [Anthropic の MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp) を参照してください。

## Cursor から使う

project 単位なら `.cursor/mcp.json`、全 project 共通なら `~/.cursor/mcp.json` に次を置きます。

```json
{
  "mcpServers": {
    "repo-knowledge": {
      "command": "npx",
      "args": ["-y", "repo-knowledge-mcp"],
      "env": {
        "REPO_KNOWLEDGE_HOME": "/absolute/private/path"
      }
    }
  }
}
```

Cursor の設定場所と stdio schema は [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol) を参照してください。

## Agent bootstrap

server instructions だけでは client が必ず `get_rules` を呼ぶとは限りません。
次の command が出力する 1 行を、利用する agent に応じて `AGENTS.md`、`CLAUDE.md`、または `.cursor/rules` 配下の rule に追加してください。

```console
repo-knowledge export owner/repository --bootstrap
```

出力は rule 本文を埋め込まず、変更前に対象 file を添えて `get_rules` を呼ぶよう agent へ指示します。

## 設定

既定の config は `~/.repo-knowledge/config.json` です。
JSON は strict に検証され、未知 key、無効な repository 名、矛盾する provider 設定は fail-closed になります。

```json
{
  "defaultRepo": "owner/repository",
  "repos": ["owner/repository"],
  "workspaceMappings": {
    "/absolute/path/to/repository": "owner/repository"
  },
  "llm": {
    "mode": "disabled",
    "allowCloudTransmission": false,
    "model": null
  },
  "repoPolicies": {},
  "hostAssistedDistillation": {
    "enabled": false,
    "allowReviewContentTransmission": false,
    "includeDiffHunk": false,
    "maxCharactersPerJob": 30000
  },
  "trust": {
    "trustedActorIds": [],
    "trustedLogins": [],
    "aiReviewers": {
      "greptile-apps[bot]": "greptile"
    },
    "sourceAliases": {},
    "externalContributors": "raw-only",
    "autoActivateTrustedHuman": false
  },
  "ingest": {
    "includeOutdated": true,
    "excludeAuthors": []
  }
}
```

repository は tool の `repo`、`workspace_path`、server 起動時の `--repo` / `--workspace`、config の mapping、`defaultRepo` の順に解決します。
GitHub rename 後も GraphQL node ID を使って同じ local store へ解決します。

## 個人利用と信頼設定

knowledge、raw review、event、outcome は Git で共有せず、利用者ごとの private storage に保存します。
同じ repository でも、利用者が選ぶ trust policy と利用結果によって active rule と順位は異なり得ます。

guided setup は観測した人間 reviewer を候補として表示しますが、明示確認なしに信頼対象へ追加しません。
未知 bot と外部 contributor は信頼候補から除外します。

`trust.autoActivateTrustedHuman` の既定値は `false` です。
この値を有効にしても、M2 pilot の `go`、live quality gate の `pass`、同じ trust policy digest を持つ operator-local eligibility がそろわなければ候補は active になりません。
条件がそろった場合も、trusted human だけで構成された thread の `should` / `consider` 候補に限定します。
AI reviewer、未知 bot、外部 contributor、trust class が混在する thread、`must` 候補は review inbox に残ります。

review inbox が未処理でも、既存 active rule の `get_rules` は利用できます。
有効化の前提、記録する digest、rollback は [trusted-human auto activation runbook](./docs/operations/trusted-human-auto-activation-runbook.md) を参照してください。

## 外部送信の経路

GitHub ingest 自体は `gh api graphql` で GitHub から review を取得します。
次の表は、取得済み review content を蒸留のために LLM へ渡す経路です。

| 経路 | opt-in 条件 | 送信先 | 送信または公開される data | 既定 |
|---|---|---|---|---|
| disabled | `llm.mode: "disabled"` かつ host-assisted の二つの同意 flag が揃っていない状態 | なし | 外部送信なし（raw observation と pending job は local に保存） | 有効 |
| Provider Adapter | `llm.mode: "anthropic"`、実効 `allowCloudTransmission: true`、`ANTHROPIC_API_KEY`、model | Anthropic Messages API | distillation prompt と schema、thread の comment ID、本文、時刻、actor/trust metadata、path、取得済み diff hunk、repository context、merge 判定用の candidate と既存 rule 要約 | 無効 |
| host-assisted | `hostAssistedDistillation.enabled: true` と `allowReviewContentTransmission: true` | MCP client が利用する host model | normalized comment、actor、path、output schema（diff hunk は `includeDiffHunk: true` の場合だけ、既定 limit は 1 job） | 無効 |

Provider Adapter を有効にする最小差分は次です。
repository 単位の `repoPolicies.<owner/name>.allowCloudTransmission: false` は global opt-in より優先して送信を拒否します。

```json
{
  "llm": {
    "mode": "anthropic",
    "allowCloudTransmission": true,
    "model": "your-anthropic-model-id"
  }
}
```

```console
export ANTHROPIC_API_KEY=replace-with-your-secret
repo-knowledge distill owner/repository
```

API key は config に書かず process environment で渡してください。
review content と diff に対する secret scanner はないため、secret が含まれうる repository では外部送信を有効にしないでください。

### Claude / Codex のサブスクリプションで蒸留する

Anthropic API を契約していなくても、接続中の Claude Code または Codex を host model として使えます。
この経路は Anthropic Messages API key を使わず、`llm.mode` は `disabled` のままにします。

review content を host model へ渡すため、次の二つを明示的に有効にする必要があります。
diff hunk は別の opt-in であり、既定では送信しません。

```json
{
  "llm": {
    "mode": "disabled",
    "allowCloudTransmission": false,
    "model": null
  },
  "hostAssistedDistillation": {
    "enabled": true,
    "allowReviewContentTransmission": true,
    "includeDiffHunk": false,
    "maxCharactersPerJob": 30000
  }
}
```

設定後、Claude Code または Codex へ次のように依頼します。

> repo-knowledge MCP の `prepare_distillation` でこの repository の pending job を 1 件取得し、返された schema に従って抽出と照合を行い、`submit_distillation` まで進めてください。

`prepare_distillation` は既定で一度に 1 job だけを lease します。
送信内容、文字数制限、diff の扱いを確認してから opt-in してください。

## MCP tools

| tool | 動作 |
|---|---|
| `get_rules` | file path と task に合う active rule を返す |
| `search_knowledge` | active knowledge を literal-safe に検索する |
| `get_knowledge` | active knowledge、コード例（ある場合）、paginated evidence を読む |
| `ingest_pr` | complete PR snapshot を取得し、raw observation と distillation job を canonical commit する |
| `sync_repo` | checkpoint から増分同期する。CLI `sync` と同一サービス・同一 summary schema |
| `record_outcome` | agent が観測した rule の outcome を `event_id` 冪等で記録する |
| `add_knowledge` | manual knowledge を `proposed` で追加する |
| `update_knowledge` | ETag / revision を使い、変更 proposal を作る。active 化はできない |
| `prepare_distillation` | 明示 opt-in 時だけ host-assisted job data を返す |
| `submit_distillation` | extract または finalize 結果を lease fencing と idempotency 付きで提出する |
| `stats` | knowledge / evidence / outcome / job / sync の versioned 集計を read-only で返す |

MCP plane から status を active / rejected に変更する tool は公開しません。
これは tool 経由の偶発的な権限昇格を抑える運用境界であり、同じ OS user として shell を実行できる agent に対する security boundary ではありません。

`get_rules` は従来の `matched_count`、`rules`、`truncated` を維持したまま、
初期設定不足と正常な検索不一致を区別する `readiness` を返します。

```json
{
  "matched_count": 0,
  "readiness": {
    "next_action": "Run `repo-knowledge setup owner/repository` to initialize private storage and perform the first repository sync.",
    "state": "setup_required"
  },
  "repo": "owner/repository",
  "rules": [],
  "truncated": false
}
```

| `readiness.state` | 意味 |
|---|---|
| `setup_required` | 同期実績、job、knowledge がなく、guided setup または初回同期が必要 |
| `learning` | active rule はまだなく、distillation job または proposed knowledge を処理中 |
| `ready` | active rule が存在。`rules: []` なら指定 file / task に対する正常な不一致 |
| `empty` | 同期実績はあるが、現在再利用できる候補がない |

## CLI commands

| command | 用途 |
|---|---|
| `serve [--repo owner/name]` | stdio MCP server を明示起動 |
| `setup [repo] [--json] [--since <iso> \| --all-history]` | private storage、repository、外部送信、trust、初回同期を対話設定。既定範囲は直近 90 日。既定出力は人間向け要約、`--json` は機械可読出力 |
| `sync [repo] [--since <iso>]` | checkpoint から更新 PR を増分同期（cron 用、下記「cron 同期の運用」参照） |
| `stats [repo] [--bucket <mode>] [--since <iso>] [--until <iso>]` | versioned repository 集計を JSON 1 document で出力 |
| `ingest [repo] <pr>` | 一つの complete PR snapshot を取り込む |
| `distill [repo]` | Provider Adapter で pending job を処理 |
| `list [repo] [--status proposed]` | canonical knowledge と revision proposal を列挙 |
| `review [repo]` | proposed knowledge と pending revision proposal を一つの TTY セッションで確認 |
| `reindex [repo]` | canonical files から `index.sqlite` を再構築 |
| `redistill [repo] <selector>` | `--all`、`--author`、`--prompt-version`、`--failed`、`--outdated` で再 job 化。`--outdated` は現在の prompt / output schema / trust policy digest に対応する job が無い thread だけを queue し、既存 job は reset しない（M2 prompt への選択的再蒸留経路） |
| `reconcile [repo] --write-derived-metadata` | 派生 metadata snapshot を明示的に書く |
| `export [repo] --bootstrap` | agent bootstrap の 1 行だけを出力 |
| `approve` / `reject` / `edit` / `approve-revision` | TTY-only admin operation |
| `add --active <fields>` | TTY-only で human-authored active knowledge を追加 |
| `doctor [repo]` | runtime、GitHub auth、config、storage、canonical data、projection を read-only 診断 |

`sync` / `sync_repo`、`record_outcome`、`stats` は M2 で追加されました。
`stats` は MCP tool と CLI command が同じ schema version と集計値を返します（下記「stats の読み方と運用」参照）。
引数なしで TTY から起動すると help、pipe から起動すると stdio server になります。

`repo-knowledge review owner/repository` は、読み込みと更新の進捗を stderr に表示します。
各候補では session の処理件数を先に示し、rule、再利用理由、scope、severity、source/trust、evidence、possible match、metadata の順に情報をまとめて、`approve` / `reject` / `skip` / `edit` を受け付けます。
`skip` と途中終了では状態を変更しないため、次回の実行で再表示されます。
表示後に候補が変更された場合は古い revision / ETag で書き込まず、最新内容を再表示します。
このコマンドは stdin と stdout の両方が実 TTY の場合だけ状態を変更し、pipe、redirect、`--yes` は受け付けません。

## cron 同期の運用

`repo-knowledge sync` は保存済み checkpoint の直後から更新 PR だけを取り込みます。
初回は `--since` で開始境界を宣言でき、以後は引数なしの定期実行だけで増分同期が続きます。
同じ window を CLI と MCP `sync_repo` から重複同期しても、ingest は冪等なので canonical state は変化しません。

cron へ載せる前に、同じユーザー・同じ環境変数で非対話実行を確認します。

```console
gh auth status
repo-knowledge sync owner/repository </dev/null
echo "exit=$?"
```

15 分ごとに同期し、summary JSONL をログへ追記し、失敗時のみ通知する crontab 例です。

```crontab
MAILTO=ops@example.com
PATH=/opt/homebrew/bin:/usr/bin:/bin
*/15 * * * * repo-knowledge sync owner/repository >> "$HOME/log/repo-knowledge-sync.jsonl" 2>> "$HOME/log/repo-knowledge-sync.err" || echo "repo-knowledge sync failed with exit $?"
```

exit code の契約は cron 監視用に固定されています。

| exit | 意味 | cron での扱い |
|---|---|---|
| 0 | 発見した PR をすべて同期（0 件含む） | 正常。通知不要 |
| 1 | 部分失敗またはエラー（lock 待ちタイムアウト含む） | 通知して次回実行で自動再試行 |
| 2 | 引数誤り（`--since` 形式不正など） | crontab を修正するまで回復しない |

部分失敗時は最初に失敗した PR で停止し、checkpoint は最後に連続成功した PR に留まるため、
失敗より新しい PR が先に取り込まれて穴が生まれることはありません。
`--since` が checkpoint 境界時刻以上の場合は `SYNC_SINCE_BEYOND_CHECKPOINT` で拒否されます（fail-closed）。
lock contention、エラーコード一覧、失敗時の診断は
[sync cron 運用 runbook](./docs/operations/sync-cron-runbook.md) を参照してください。

## outcome の記録とランキング

`get_rules` の応答には rule `id` が含まれるため、agent は rule を適用・違反した際に
`record_outcome` tool で観測結果を返せます。

- `event_id`（`evt_<ULID>`）が冪等キーです。MCP retry で同じ payload が再送されても
  二重加算されず、同じ `event_id` に異なる payload を送ると fail-closed で拒否されます。
- `outcome` は `applied` / `violated` / `not_applicable` / `false_positive` の 4 種で、
  evidence（レビューで観測された回数）とは混ぜずに別カウントとして集計されます。
- outcome は対象 rule が active のときだけ記録でき、canonical event として保存されるため
  `reindex` 後も同じ集計へ再構築されます。

記録された outcome は検索ランキングへ上限付きで反映されます。

- `violated` は違反 boost として順位を上げます（M1 から継続、上限あり）。
- `applied` は最小 sample 数（3 件）未満では効かず、少数の自己報告が
  自己強化ループを作らないよう設計されています。
- `not_applicable` / `false_positive` は上限付きの減点で、outcome ゼロ件の rule の順位は
  M1 とまったく同じです。

## detail のコード例（根拠制約付き）

M2 の蒸留は、review thread に根拠がある場合だけ detail に構造化コード例を付けます。

- 例は常に `generated_example: true` を持ち、引用した evidence comment ID を必ず伴います。
- 例が使う API・型・package 名は、cited comment 本文または diff hunk に実在する token に
  限定され、根拠のない API を含む例は commit 前に拒否されます（幻覚 API の混入防止）。
- 根拠が取れない場合は例を省略し、detail は概念的な記述のままになります。
- 保存先は canonical Markdown 本文で、`get_knowledge` が `code_example` として返します。
  M1 時代の document は `code_example: null` のまま有効で、migration は不要です。

## quality gate の運用

M2 の抽出・分類・マージ・検索品質は、匿名化 corpus と記録済み provider prediction から
オフラインで再計算できる quality gate で管理します。network も API key も不要です。

```console
npm run quality:gate
```

- exit 0（`status: "pass"`）: 全指標が review 済み下限以上で、fixture drift もなし
- exit 1（`status: "metric_failure"`）: いずれかの指標が下限未満
- exit 2（`status: "integrity_failure"`）: 入力不正、閾値と baseline の束縛不一致、fixture drift

quality report は機械可読 JSON として stdout に出力され、同じ入力からは
Node 22 / 24 で同一 byte の report が得られます。指標だけを再計算する場合は次を使います。

```console
npm run golden
```

prompt や schema、trust policy の世代を意図して変更した場合は、記録済み prediction から
baseline artifact を再生成してから gate を再実行します。

```console
npm run golden:baseline:replay
npm run quality:gate
```

実 provider での閾値実測（operator のみ・明示 opt-in）、閾値更新の合意手続き、
失敗時の診断は [golden baseline 測定 runbook](./docs/operations/golden-baseline-runbook.md) を、
要件と test の対応は [M2 acceptance matrix](./docs/testing/m2-acceptance-matrix.md) を参照してください。

## stats の読み方と運用

`stats` は canonical snapshot（knowledge Markdown + canonical JSONL）と repo-local な sync checkpoint だけから導出する read-only の純関数です。
同じ canonical state と同じ request からは常に同一の response が得られ、壁時計や生成時刻を含みません。
canonical data を変更する経路はなく、`reindex` 前後でも全集計値が一致します。

response の各値の意味は次のとおりです。

| key | 意味 |
|---|---|
| `stats_schema_version` | 集計契約の version（現在 `1`）。キーや単位の意味が変わる変更で increment |
| `canonical_digest` | canonical state の識別子。同じ digest なら同じ集計値 |
| `window` | 受理した半開区間 `[since, until)` を UTC instant へ正規化した echo。`timezone` は常に `"UTC"` |
| `knowledge.total` / `by_status` / `by_category` / `by_severity` | 当該 repository の knowledge Markdown 全件（全 status）の frontmatter 分類。window の影響を受けない現在状態 |
| `evidence.total` / `by_status` | window 内に observed された evidence の件数と status（active / superseded / withdrawn）分類 |
| `evidence.by_source` | 同じ evidence 集合の source provider 分類。1 evidence が複数 source を持つと各 source に 1 ずつ数えるため、合計は `total` を超えうる |
| `evidence.eligible_for_count` | window 内 evidence のうち status=active かつ `eligible_for_count: true` の件数。knowledge の `evidence_count` と同じ資格判定 |
| `outcomes.total` / `by_type` | window 内の outcome event（applied / violated / not_applicable / false_positive）分類 |
| `jobs.total` / `by_state` | distill job の現在状態（pending / processing / awaiting_finalize / done / skipped / failed）分類。window の影響を受けない |
| `sync.last_checkpoint` | sync checkpoint の cursor（`last_pr_number` / `last_updated_at`）と checkpoint の `updated_at`。未同期 repository は `null` |
| `operations` | `pending_jobs` / `failed_jobs`（`jobs.by_state` の再掲）と `last_sync_checkpoint_at`。cron 同期運用の監視入口 |
| `buckets` | `--bucket day` のときだけ、window と交差する UTC 暦日を昇順で全列挙した日次集計。観測 0 件の日も 0 埋め。`--bucket total`（既定）では `null` |

分類はすべて enum の全キーを列挙し、該当 0 件でもキーを `0` で返します。
空 repository や期間内データなしはエラーではなく、zero stats の正常応答（exit 0）です。

期間 filter の規則は次のとおりです。

- `since` / `until` は offset 付き ISO 8601 で、半開区間 `[since, until)` として解釈します（`since` ちょうどは含み、`until` ちょうどは含まない）。
- 入力 offset は instant の解釈のみに使い、bucket 境界と day キーは UTC で固定します。
- 期間 filter が効くのは時刻を持つ観測列（evidence の `observed_at`、outcome の `at`）だけです。
- `--bucket day` は `--since` と `--until` の両方が必須で、366 UTC 日を超える window は拒否します。

運用例です。
CLI は JSON 1 document を stdout に出力するため、script からそのまま解析できます。

```console
# 全期間の集計
repo-knowledge stats owner/repository

# 直近 1 週間の日次推移
repo-knowledge stats owner/repository --bucket day \
  --since 2026-08-01T00:00:00Z --until 2026-08-08T00:00:00Z

# cron 監視: 失敗 job が残っていれば非 0 で alert
repo-knowledge stats owner/repository | jq -e '.operations.failed_jobs == 0'
```

exit code は 0 が成功（zero stats を含む）、1 が read 失敗（checkpoint の repository 不一致など）、2 が usage error（不正な window を含む）です。
MCP からは `stats` tool を同じ引数（`bucket` / `since` / `until`）で呼び出せ、CLI と同一の schema version と集計値を返します。

## 保存構造

```text
~/.repo-knowledge/
├── config.json
├── repositories.json
└── repos/<stable-storage-id>/
    ├── knowledge/*.md
    ├── raw/*.jsonl
    ├── events/*.jsonl
    ├── transactions/
    └── index.sqlite
```

`knowledge/*.md`、`raw/*.jsonl`、`events/*.jsonl`、registry は canonical data です。
`index.sqlite` は派生 projection なので削除後に `reindex` できます。
storage root は mode 700、config、canonical files、SQLite は mode 600 に矯正されます。

直接編集には次の制約があります。

- knowledge を直接削除すると検索結果から消えますが evidence event は残り、`doctor` が orphan として報告します。
  履歴を保つには削除でなく `status: rejected` を使用してください。
- tool 経由の更新は YAML frontmatter を再 serialize するため、comment、key 順、quote style は保持しません。
  本文 Markdown を主な手編集面としてください。
- ETag は更新開始前の直接編集を検知しますが、短い canonical commit 区間中に外部 editor が同じ file を変更する競合は完全な atomic CAS の保証対象外です。
  直接編集は command 実行中を避けてください。
- NFS、SMB、network mount、同期 folder では lock、fsync、rename の保証が異なるため使用しないでください。

stdout は MCP 接続中の JSON-RPC 専用です。
structured diagnostic と provider log は stderr に書きます。

## 開発と release gate

```console
npm ci
npm run check
npm run golden
npm run quality:gate
npm run package:smoke
```

`package:smoke` は allowlist と secret pattern の検査を通過した `npm pack` の tarball だけを clean temporary project へ install します。
その tarball から safe default の guided setup、review help、stdio initialize、全 11 tool の list、ローカル `gh` stand-in 経由の `sync_repo` / `stats` / `get_rules` call、stdout の JSON-RPC 純度を検証します。
smoke 用 workspace に `.repo-knowledge/` が作成されず、runtime data が外部の `REPO_KNOWLEDGE_HOME` だけに保存されることも確認します。
CI は Node 22 と 24 の両方で同じ check、golden、quality gate、package smoke を実行します。
npm 公開時は exact tag と commit を再検証し、GitHub OIDC による trusted publishing で provenance 付き tarball を公開した後、registry の exact version を再度 smoke します。
初回公開の bootstrap、npm と GitHub の設定、通常公開、rollback は [npm release runbook](./docs/operations/npm-release-runbook.md) を参照してください。
M2 要件から test・運用手順への追跡は [M2 acceptance matrix](./docs/testing/m2-acceptance-matrix.md) を参照してください。
M3 個人利用要件から test・release gate への追跡は [M3 acceptance matrix](./docs/testing/m3-acceptance-matrix.md) を参照してください。
公開時の実測値と go/no-go は [M3 release report template](./docs/operations/m3-release-report-template.md) に記録します。

脅威モデル、admin plane、直接編集、外部送信の詳細は [SECURITY.md](./SECURITY.md) を参照してください。
