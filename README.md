# repo-knowledge-mcp

> **公開状況**
>
> この source の release version は `v0.4.1` です。
> npm registry への反映前は `@tamat-llc/repo-knowledge-mcp@0.4.0` を利用してください。

**repo-knowledge-mcp** は、Pull Request のレビューから得た知見を個人用ローカルストアへ保存し、Codex、Claude Code、Cursor から再利用できる rule に変換する stdio MCP server です。
人間と複数の AI reviewer が残した指摘を GitHub から取得し、根拠を追跡できる Markdown として管理します。

外部送信と trusted-human rule の自動 active 化は既定で無効です。
GitHub token は `gh` CLI が管理し、repo-knowledge-mcp は token を受領または保存しません。

## 目次

- [できること](#capabilities)
- [対応環境](#supported-environments)
- [最短セットアップ](#quick-start)
- [レビューが rule になるまで](#review-to-rule)
- [MCP client への登録](#mcp-clients)
- [privacy と信頼設定](#privacy-and-trust)
- [MCP tools と CLI](#tools-and-cli)
- [Node API](#node-api)
- [トラブルシュート](#troubleshooting)
- [データの保存と削除](#data-lifecycle)
- [開発と release gate](#development-and-release)

<a id="capabilities"></a>

## できること

repo-knowledge-mcp は、レビューの取得から coding agent への提供までを次の順序で処理します。

```text
GitHub Pull Request のレビュー
  ↓ gh CLI で取得
個人用ローカルストアの raw evidence
  ↓ 明示的に許可した方法で蒸留
proposed knowledge
  ↓ 人間が TTY で承認
active rule
  ↓ get_rules
Codex、Claude Code、Cursor
```

- **Local-first**：canonical data を `~/.repo-knowledge/` に保存します。
- **Vendor-neutral**：特定の reviewer や coding agent に知識を閉じません。
- **追跡可能な根拠**：rule から元の review comment と Pull Request を確認できます。
- **明示的な承認**：MCP tool から knowledge を active に変更できません。
- **安全な既定値**：外部送信、diff hunk の送信、trusted-human の自動 active 化は個別に opt-in します。

Serena memory が agent の探索結果と作業記憶を残すのに対し、repo-knowledge-mcp は Pull Request の review evidence を再利用可能な rule に変換します。
Bugbot learned rules が Bugbot 自身の review を改善するのに対し、repo-knowledge-mcp は同じ rule を複数の MCP client へ提供します。

<a id="supported-environments"></a>

## 対応環境

| 項目 | v0.4 の保証範囲 |
| --- | --- |
| Node.js | Node 22.13 以降、または Node 24 以降 |
| OS | macOS、Linux |
| storage | ローカル filesystem |
| transport | stdio |
| GitHub access | `gh` CLI |

Windows、NFS、SMB、Dropbox、iCloud Drive などの同期領域は保証対象外です。
永続化は POSIX permission、directory fsync、atomic rename、PID lock に依存します。

<a id="quick-start"></a>

## 最短セットアップ

以下の package コマンドは npm registry の exact version を使います。
最初に `npm view @tamat-llc/repo-knowledge-mcp@0.4.1 version` が `0.4.1` を返すことを確認してください。
`E404` の間は各例の `0.4.1` を `0.4.0` に置き換えます。
source checkout から試す手順は[開発と release gate](#development-and-release)にあります。

### 1. GitHub と Node.js を準備する

```console
gh auth login
gh auth status
node --version
```

private repository を対象にする場合は、その repository を読める GitHub アカウントで `gh` にログインしてください。

### 2. repository を初期化する

対象 repository の workspace で guided setup を実行します。

```console
cd /absolute/path/to/repository
npx -y @tamat-llc/repo-knowledge-mcp@0.4.1 setup
```

workspace の外から実行する場合は repository 名を指定します。

```console
npx -y @tamat-llc/repo-knowledge-mcp@0.4.1 setup owner/repository
```

継続して CLI を使う場合は global install も選べます。

```console
npm install --global @tamat-llc/repo-knowledge-mcp@0.4.1
repo-knowledge --help
```

guided setup は repository の解決、private storage の作成、外部送信の選択、信頼する人間 reviewer の選択、初回同期を一つの TTY session で行います。
外部送信と reviewer trust の質問は既定で `No` です。
初回同期は既定で直近 90 日を対象とし、`--since <iso>` または `--all-history` で変更できます。

結果を機械的に読む場合は、実 TTY から `--json` を付けて実行します。
この場合は stdout に JSON document を一件だけ出力し、progress を表示しません。

中断または部分的な同期失敗後は、同じ command を再実行してください。
保存済み scope と checkpoint から処理を再開します。

### 3. installation を診断する

```console
npx -y @tamat-llc/repo-knowledge-mcp@0.4.1 doctor owner/repository
```

`doctor` は runtime、GitHub 認証、config、storage、canonical data、検索用 projection を変更せずに検査します。

### 4. MCP client へ登録する

Codex を使う場合は次の command で登録します。

```console
codex mcp add repo-knowledge -- npx -y @tamat-llc/repo-knowledge-mcp@0.4.1
codex mcp list
```

続いて、agent が変更前に `get_rules` を呼ぶための一文を出力します。

```console
npx -y @tamat-llc/repo-knowledge-mcp@0.4.1 export owner/repository --bootstrap
```

出力された一文を `AGENTS.md`、`CLAUDE.md`、または `.cursor/rules` 配下の rule に追加してください。
この一文は knowledge 本文を埋め込まず、変更対象の file と task を添えて `get_rules` を呼ぶよう agent へ指示します。

### 5. repository の状態を確認する

coding agent へ次のように依頼します。

> 変更予定の file と task を指定して、repo-knowledge MCP の `get_rules` を呼んでください。

初回同期の直後に `learning` が返ることがあります。
これは失敗ではなく、取得した review が蒸留または人間の承認を待っている状態です。

| `readiness.state` | 状態 | 次の操作 |
| --- | --- | --- |
| `setup_required` | 初期設定または初回同期が未完了 | `repo-knowledge setup` |
| `learning` | pending job または proposed knowledge が存在 | 蒸留を実行して `repo-knowledge review` |
| `ready` | active rule が存在 | 返された rule を使う |
| `empty` | 同期済みだが再利用できる候補がない | 新しい review の後に `repo-knowledge sync` |

`ready` で `rules: []` が返る場合は正常な検索不一致です。
初期設定不足を意味しません。

<a id="review-to-rule"></a>

## レビューが rule になるまで

次の例は入出力の関係を示すために簡略化しています。
実際の rule は、取得した review thread と trust policy によって異なります。

Pull Request に次の review comment が残ったとします。

> GitHub API の応答は、保存する前に strict schema で検証し、未知 key を拒否してください。

蒸留処理はこの comment を根拠として proposed knowledge を作ります。
人間が `repo-knowledge review owner/repository` で承認すると、knowledge は active になります。

coding agent が `src/github/client.ts` の変更前に `get_rules` を呼ぶと、次のような応答を受け取ります。

```json
{
  "matched_count": 1,
  "readiness": {
    "state": "ready",
    "next_action": "Use the returned rules."
  },
  "repo": "owner/repository",
  "rules": [
    {
      "evidence_count": 2,
      "id": "kn_01EXAMPLE0000000000000000",
      "match_reasons": [
        {
          "file_path": "src/github/client.ts",
          "pattern": "src/github/**/*.ts",
          "type": "scope"
        }
      ],
      "rule": "GitHub API の応答は、永続化する前に strict schema で検証する",
      "severity": "should",
      "violation_count": 0
    }
  ],
  "truncated": false
}
```

rule の detail、コード例、paginated evidence を確認する場合は `get_knowledge` を使います。
元の comment に API、型、package 名の根拠がない場合、具体的なコード例は生成しません。

<a id="mcp-clients"></a>

## MCP client への登録

### Codex

```console
codex mcp add repo-knowledge -- npx -y @tamat-llc/repo-knowledge-mcp@0.4.1
codex mcp get repo-knowledge
```

保存先を変更する場合は、CLI と MCP server に同じ `REPO_KNOWLEDGE_HOME` を渡します。

```console
codex mcp add repo-knowledge \
  --env REPO_KNOWLEDGE_HOME=/absolute/private/path \
  -- npx -y @tamat-llc/repo-knowledge-mcp@0.4.1
```

設定方法は [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) を参照してください。

### Claude Code

```console
claude mcp add repo-knowledge -- npx -y @tamat-llc/repo-knowledge-mcp@0.4.1
claude mcp get repo-knowledge
```

```console
claude mcp add repo-knowledge \
  --env REPO_KNOWLEDGE_HOME=/absolute/private/path \
  -- npx -y @tamat-llc/repo-knowledge-mcp@0.4.1
```

設定方法は [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp) を参照してください。

### Cursor

project 単位では `.cursor/mcp.json`、全 project 共通では `~/.cursor/mcp.json` に次の設定を置きます。

```json
{
  "mcpServers": {
    "repo-knowledge": {
      "command": "npx",
      "args": ["-y", "@tamat-llc/repo-knowledge-mcp@0.4.1"],
      "env": {
        "REPO_KNOWLEDGE_HOME": "/absolute/private/path"
      }
    }
  }
}
```

設定方法は [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol) を参照してください。

<a id="privacy-and-trust"></a>

## privacy と信頼設定

canonical data は利用者ごとの private storage に保存します。
同じ repository でも、利用者が選ぶ trust policy と利用結果によって active rule と順位は異なります。

review content を LLM へ渡す方法は、Provider Adapter と host-assisted distillation の二つです。
どちらも明示的な opt-in がない限り送信しません。
diff hunk の送信には別の opt-in が必要です。

| 方法 | 送信先 | 既定 |
| --- | --- | --- |
| Provider Adapter | ログイン済みの Claude Code、Codex、または Grok CLI が使う cloud model | 無効 |
| host-assisted distillation | 接続中の MCP client が使う host model | 無効 |

Provider Adapter の `llm.mode` は `anthropic`、`openai`、`xai` に対応します。
認証には `claude auth login`、`codex login`、`grok login` で作成したサブスクリプション session を使います。
Provider API key は設定せず、子 CLI process へ渡す環境変数も実行・locale・proxy / custom CA・provider subscription 認証に必要な allowlist に限定します。
GitHub token、cloud credential、その他の任意の親 process 環境変数は引き継ぎません。

`trust.autoActivateTrustedHuman` も既定では `false` です。
この値を有効にしても、pilot、quality gate、trust policy の条件を満たす trusted-human non-`must` candidate だけが対象になります。
AI reviewer、未知 bot、外部 contributor、mixed trust、`must` candidate は review inbox に残ります。

設定例、送信される field、review 手順は[利用と運用の詳細ガイド](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/usage-reference.md)を参照してください。
脅威モデルと security boundary は [SECURITY.md](./SECURITY.md) に記載しています。

<a id="tools-and-cli"></a>

## MCP tools と CLI

MCP server は次の 11 tools を公開します。

| tool | 用途 |
| --- | --- |
| `get_rules` | file path と task に合う active rule を返す |
| `search_knowledge` | active knowledge を検索する |
| `get_knowledge` | detail、コード例、evidence を読む |
| `ingest_pr` | 一つの Pull Request snapshot を取得する |
| `sync_repo` | checkpoint から増分同期する |
| `record_outcome` | 実際に観測した rule の利用結果を冪等に記録する |
| `add_knowledge` | manual knowledge を proposed で追加する |
| `update_knowledge` | ETag を使って変更 proposal を作る |
| `prepare_distillation` | host-assisted job を一件取得する |
| `submit_distillation` | 蒸留結果を検証して提出する |
| `stats` | repository の集計を読み取る |

Codex や Claude Code は、変更前に `get_rules` を呼び、実装・検証・違反確認などの実結果が確定した rule だけ `record_outcome` で記録します。
`get_rules` が rule を返しただけで `applied` を記録してはいけません。
通常経路では作業結果ごとの安定した `event_key`、`result_observed: true`、`context`、`note` を渡します。
同じ request の retry は二重記録されません。
判定基準、privacy、誤記録時の扱いは[outcome 記録ガイド](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/usage-reference.md#outcome-とランキング)を参照してください。

MCP plane から status を active または rejected に変更する tool は公開しません。
承認と却下は実 TTY を必要とする admin CLI だけが行います。

主な CLI commands は次のとおりです。

| command | 用途 |
| --- | --- |
| `setup [repo]` | private storage、privacy、trust、初回同期を設定 |
| `sync [repo]` | 更新された Pull Request を増分同期 |
| `review [repo]` | proposed knowledge を一つの TTY session で処理 |
| `list [repo]` | canonical knowledge を列挙 |
| `stats [repo]` | versioned aggregate を JSON で出力 |
| `doctor [repo]` | installation と canonical state を診断 |
| `export [repo] --bootstrap` | agent bootstrap の一文を出力 |
| `serve` | stdio MCP server を明示起動 |

すべての command と option は `repo-knowledge --help` で確認できます。
定期同期、outcome、stats、storage の詳細は[利用と運用の詳細ガイド](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/usage-reference.md)にあります。

<a id="node-api"></a>

## Node API

package root は、CLI を Node.js から実行する `runDefaultRepoKnowledgeCli` と、その option type だけを stable API として公開します。

`v0.4.0` では、`v0.3.0` の package root にあったその他の export を `./experimental` へ移しました。
CLI command と MCP protocol の利用方法に変更はありません。

```js
import { runDefaultRepoKnowledgeCli } from "@tamat-llc/repo-knowledge-mcp";

process.exitCode = await runDefaultRepoKnowledgeCli({ argv: ["--help"] });
```

旧 root export は移行用の `@tamat-llc/repo-knowledge-mcp/experimental` から参照できますが、SemVer の互換性保証と deprecation 期間の対象外です。
公開 symbol の inventory、versioning、source checkout からの移行方法は [Node API と公開境界](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/node-api.md)に記載しています。

<a id="troubleshooting"></a>

## トラブルシュート

| 症状 | 確認と対処 |
| --- | --- |
| `npm ERR! E404` | package 名と指定した exact version が npm registry に存在するか確認する |
| Node.js version error | Node 22.13 以降、または Node 24 以降へ変更する |
| GitHub repository を読めない | `gh auth status` と対象アカウントの repository 権限を確認する |
| Provider subscription を使えない | 選択した provider に応じて `claude auth status --json`、`codex login status`、または `GROK_DISABLE_API_KEY_AUTH=1 grok models` を確認し、必要なら login command を再実行する |
| `setup` または `review` が TTY error で停止する | pipe や redirect の外で、stdin と stdout が実 TTY の terminal から実行する |
| `readiness.state` が `setup_required` | `repo-knowledge setup owner/repository` を実行する |
| `readiness.state` が `learning` | 外部送信の選択を確認し、蒸留後に `repo-knowledge review owner/repository` を実行する |
| `readiness.state` が `empty` | 新しい review の後に `repo-knowledge sync owner/repository` を実行する |
| `ready` だが `rules` が空 | 正常な検索不一致。file path と task を確認して作業を続ける |
| lock timeout | 同じ repository を更新する別 process を確認し、終了後に再実行する |
| MCP client から接続できない | `repo-knowledge doctor owner/repository` と client 側の MCP 登録内容を確認する |

sync の失敗 code と再試行方法は [sync cron 運用 runbook](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/sync-cron-runbook.md) にあります。
解決しない場合は、秘密情報と review content を除いた診断結果を添えて [GitHub Issues](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues) へ報告してください。
security vulnerability は [Security policy](./SECURITY.md) の窓口へ報告してください。

<a id="data-lifecycle"></a>

## データの保存と削除

既定の保存先は `~/.repo-knowledge/` です。
対象 repository の workspace へ `.repo-knowledge/` を作成しません。

MCP 登録、global package、ローカルデータは別々に管理されます。
利用を停止する場合は、必要な項目だけを削除してください。

```console
codex mcp remove repo-knowledge
claude mcp remove repo-knowledge
npm uninstall --global @tamat-llc/repo-knowledge-mcp
```

package を uninstall してもローカルデータは残ります。
ローカルデータも消す場合は、`repo-knowledge doctor` で保存先を確認し、必要な backup を取得してから、そのディレクトリだけを削除してください。

<a id="development-and-release"></a>

## 開発と release gate

source checkout から試す場合は、lifecycle script を止めて依存関係を取得し、audit 後に build します。

```console
npm ci --ignore-scripts
npm audit --audit-level=high
npm audit signatures
npm rebuild
npm run build
node dist/bin.js setup
```

変更を検証する場合は次の gate を実行します。

```console
npm run check
npm run golden
npm run quality:gate
npm run package:smoke
```

CI は Node 22 と Node 24 で同じ gate を実行します。
npm 公開時は tag と commit を検証し、provenance 付き package を公開した後、registry の exact version を再度 smoke します。

- [npm release runbook](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/npm-release-runbook.md)
- [M2 acceptance matrix](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/testing/m2-acceptance-matrix.md)
- [M3 acceptance matrix](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/testing/m3-acceptance-matrix.md)
- [M3 release report template](https://github.com/TamaT-LLC/repo-knowledge-mcp/blob/main/docs/operations/m3-release-report-template.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

[MIT License](./LICENSE)
