# repo-knowledge-mcp 利用と運用の詳細ガイド

この文書は、初期設定後の knowledge 処理、privacy 設定、定期同期、stats、ローカルストレージを扱います。
最初に動かす手順は [README](../../README.md#quick-start) を参照してください。

## repository の解決と設定

既定の config は `~/.repo-knowledge/config.json` です。
JSON は strict に検証され、未知 key、無効な repository 名、矛盾する provider 設定を拒否します。

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

repository は次の順序で解決します。

1. MCP tool の `repo`
2. MCP tool の `workspace_path`
3. server 起動時の `--repo` または `--workspace`
4. config の `workspaceMappings`
5. config の `defaultRepo`

GitHub 上で repository が rename された場合も、GraphQL node ID を使って同じ local store へ解決します。

保存先を分ける場合は、server と CLI の両方へ同じ `REPO_KNOWLEDGE_HOME` を設定してください。

```console
export REPO_KNOWLEDGE_HOME="$HOME/.repo-knowledge"
repo-knowledge doctor owner/repository
```

## 初回同期後の knowledge 処理

guided setup は review thread を raw evidence として保存し、蒸留が必要な thread に job を作ります。
外部送信を許可しない場合、job は pending のままローカルに残ります。

蒸留方法は Provider Adapter と host-assisted distillation の二つです。
どちらの方法でも、抽出結果は検証を通過してから proposed knowledge になります。

proposed knowledge は一つの TTY session で確認できます。

```console
repo-knowledge review owner/repository
```

各候補では rule、再利用理由、scope、severity、source、trust、evidence、possible match、metadata の順に表示します。
操作は `approve`、`reject`、`skip`、`edit` です。
`skip` と途中終了は状態を変更しないため、次の session で同じ候補を確認できます。

表示後に候補が変更された場合、CLI は古い revision または ETag で書き込みません。
最新内容を再表示して判断を求めます。

## 外部送信を行わない場合

`llm.mode` が `disabled` で、host-assisted の同意 flag がそろっていない場合、review content を LLM へ送りません。
raw evidence と pending job はローカルに保存されるため、後から送信方法を選べます。

```json
{
  "llm": {
    "mode": "disabled",
    "allowCloudTransmission": false,
    "model": null
  },
  "hostAssistedDistillation": {
    "enabled": false,
    "allowReviewContentTransmission": false,
    "includeDiffHunk": false,
    "maxCharactersPerJob": 30000
  }
}
```

## Provider Adapter で蒸留する

Provider Adapter は、ローカルでログイン済みの provider CLI を通じて distillation prompt と review data を送ります。
API key は設定しません。server は provider CLI の子 process へ渡す環境変数を実行・locale・proxy / custom CA・provider subscription 認証に必要な allowlist に限定し、GitHub token や cloud credential を含むその他の親 process 環境変数を除外します。
proxy / custom CA が必要な環境では、`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（lowercase 版を含む）、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS` を引き継ぎます。proxy URL に credential を含める場合は、同一 OS user の process から読める secret として扱ってください。
Codex CLI では user config と rule の読み込みに加え、shell、browser、computer、plugin 等の tool feature と web search も無効化します。

| `llm.mode` | 利用する CLI | login / 確認 |
| --- | --- | --- |
| `anthropic` | Claude Code | `claude auth login` / `claude auth status --json` |
| `openai` | Codex CLI | `codex login` / `codex login status` |
| `xai` | Grok CLI | `grok login` / `GROK_DISABLE_API_KEY_AUTH=1 grok models` |

先に利用する CLI をインストールし、対象サブスクリプションへログインしてください。
その後、`setup` で provider と model を選ぶか、次のように config を設定します。

Anthropic（Claude Code）の設定例です。

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
claude auth login
repo-knowledge distill owner/repository
```

OpenAI の場合は次のように設定します。

```json
{
  "llm": {
    "mode": "openai",
    "allowCloudTransmission": true,
    "model": "your-openai-model-id"
  }
}
```

```console
codex login
repo-knowledge distill owner/repository
```

xAI の Grok を使う場合は次のように設定します。

```json
{
  "llm": {
    "mode": "xai",
    "allowCloudTransmission": true,
    "model": "your-grok-model-id"
  }
}
```

```console
grok login
repo-knowledge distill owner/repository
```

repository 単位の `repoPolicies.<owner/name>.allowCloudTransmission: false` は global opt-in より優先されます。
MCP の `ingest_pr` と `sync_repo` も同じ Provider Adapter を使います。
MCP server 起動後に `llm` 設定を変えた場合は、client から server を再接続して config を読み直してください。

Provider Adapter が送る data には、comment ID、本文、時刻、actor と trust の metadata、path、取得済み diff hunk、repository context、candidate、既存 rule の要約が含まれます。
これらの field は provider CLI を起動する前に sensitive-content scanner で検査されます。
検出時は `SENSITIVE_CONTENT_DETECTED` で処理を止め、provider process へ payload を渡しません。
error には検出値を含めず、field path と kind だけを返します。

## host-assisted distillation を使う

host-assisted distillation は、接続中の Claude Code または Codex が使う host model へ一件ずつ job を渡します。
Provider CLI は起動せず、`llm.mode` は `disabled` のままにします。

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

> repo-knowledge MCP の `prepare_distillation` でこの repository の pending job を一件取得し、返された schema に従って抽出と照合を行い、`submit_distillation` まで進めてください。

`prepare_distillation` は既定で一度に一件だけを lease します。
normalized comment、actor、path、output schema を host model へ渡します。
diff hunk は `includeDiffHunk: true` の場合だけ送信します。
extract 時の comment と diff、finalize 時の candidate と possible match は、MCP client へ返す前に Provider Adapter と同じ scanner で検査されます。

sensitive content が見つかった job は `reason: sensitive_content_detected` として blocked になります。
`sensitive_content_findings` に含まれるのは field path と kind だけです。
実在する credential は失効または rotate し、送信元から削除または伏せ字にしてから再同期してください。
false positive は元の文字列を書き換えるか、外部送信を無効のままにします。
scanner の pattern を弱めて回避しないでください。

## trusted-human rule の自動 active 化

guided setup は、観測した人間 reviewer を信頼候補として表示します。
明示確認なしに候補を `trustedActorIds` または `trustedLogins` へ追加しません。
未知 bot と外部 contributor は信頼候補から除外します。

`trust.autoActivateTrustedHuman` の既定値は `false` です。
有効にしても、次の条件をすべて満たす candidate だけが active になります。

- M2 pilot の判断が `go` である
- live quality gate が `pass` である
- operator-local eligibility と現在の trust policy digest が一致する
- thread が trusted human だけで構成されている
- severity が `should` または `consider` である

AI reviewer、未知 bot、外部 contributor、mixed trust、`must` candidate は review inbox に残ります。
判定手順と rollback は [trusted-human auto activation runbook](./trusted-human-auto-activation-runbook.md) を参照してください。

## 定期同期

`repo-knowledge sync` は保存済み checkpoint の直後から、更新された Pull Request だけを取り込みます。
初回だけ `--since` で開始境界を指定でき、以後は引数なしで増分同期を続けます。

cron へ登録する前に、同じ OS user と環境変数で非対話実行を確認してください。

```console
gh auth status
repo-knowledge sync owner/repository </dev/null
echo "exit=$?"
```

15分ごとに同期し、summary JSONL と error log を分ける crontab 例です。

```crontab
MAILTO=ops@example.com
PATH=/opt/homebrew/bin:/usr/bin:/bin
*/15 * * * * repo-knowledge sync owner/repository >> "$HOME/log/repo-knowledge-sync.jsonl" 2>> "$HOME/log/repo-knowledge-sync.err" || echo "repo-knowledge sync failed with exit $?"
```

| exit | 意味 | 対処 |
| ---: | --- | --- |
| 0 | 発見した Pull Request をすべて同期。0件も正常 | 通知しない |
| 1 | 部分失敗、runtime error、lock timeout | 通知し、次回実行で再試行 |
| 2 | 引数または `--since` が不正 | 設定を修正 |

部分失敗時は最初に失敗した Pull Request で停止します。
checkpoint は最後に連続成功した Pull Request に留まるため、失敗より新しい Pull Request が先に取り込まれることはありません。

境界規則、最小権限、lock contention、再試行は [sync cron 運用 runbook](./sync-cron-runbook.md) を参照してください。

## outcome とランキング

`get_rules` が返す rule `id` を使うと、MCP tool の `record_outcome` で利用結果を記録できます。
この操作は local canonical store へのみ書き込むため、Provider Adapter や host-assisted distillation の有効化は不要です。

### Codex と Claude Code から記録する

通常は tool を手で呼び出す必要はありません。
Codex または Claude Code に次のように依頼します。

> 変更前に repo-knowledge の `get_rules` を使い、作業結果を実際に確認できた rule だけ `record_outcome` で一度記録してください。

host が守る順序は次のとおりです。

1. 変更対象の `file_paths` と `task` を渡して `get_rules` を呼びます。
2. 返った rule を実装と検証に使い、適用可否または作業結果を確定します。
3. rule ID と安定した `event_key` を使い、観測済みの結果を `record_outcome` で一度記録します。
4. 通信結果が不明の場合は、`at` を含む初回 request 全体を変えずに再送します。
5. 必要に応じて `stats` で outcome 件数を確認します。

標準的な tool input は次の形です。

```json
{
  "repo": "owner/repository",
  "knowledge_id": "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "outcome": "applied",
  "event_key": "codex:issue-347:implementation-result",
  "result_observed": true,
  "context": {
    "task_id": "issue-347",
    "file_paths": ["src/feature.ts"]
  },
  "note": "rule を適用し、typecheck と対象 test の成功を確認した",
  "at": "2026-08-23T01:23:45.000Z"
}
```

`event_key` は同じ作業結果で再利用できる値にします。
server は repository ID、knowledge ID、`event_key` から privacy-safe な `event_id` を決定的に導出します。
同じ request の retry は replay となり、カウントは増えません。
同じ `event_key` で `outcome`、`at`、`context`、`note` のいずれかを変えると、冪等性 conflict として拒否されます。
`event_id` を直接指定する旧経路も互換性のため使えますが、新しい host 連携では `event_key` を使ってください。
MCP tool では旧経路にも `result_observed: true`、`context`、`note` が必要で、観測契約を省略できません。

### 記録する結果の基準

| outcome | 記録する条件 |
| --- | --- |
| `applied` | rule を実際に実装または判断に適用し、その結果を test や完了状態で確認した |
| `violated` | 作成した差分、実行結果、またはレビューで rule 違反を実際に確認した |
| `not_applicable` | 対象を調べた結果、rule が現在の task に適用されないと判断できた |
| `false_positive` | 検索結果と file、task、実装内容を比較し、明らかな誤検出と確認した |

`get_rules` が rule を返しただけで `applied` を記録してはいけません。
作業が未完了の場合、結果を観測できない場合、pilot 用に成功件数を増やす場合も記録しません。
`event_key` 経路は `result_observed: true`、空でない `context`、結果を説明する `note` がそろわない要求を書き込み前に拒否します。

### privacy と誤記録

`record_outcome` は review comment、diff hunk、prompt を外部へ送信しません。
canonical event に保存されるのは、導出した event ID、knowledge ID、outcome、operator が渡した `context`、`note`、`at` です。
secret、credential、review comment 本文、不要なソースコードを `event_key`、`context`、`note` へ入れないでください。

現行 version の canonical outcome は append-only で、MCP からの取消・上書き tool はありません。
誤って記録した場合は、同じ `event_key` の内容を変えて再送したり、逆の outcome を作って相殺したりしないでください。
返った `event_id`、誤りの理由、影響した期間を local の作業記録に残し、pilot 集計や判定から除外します。
ランキング影響を除く必要がある場合は writer を停止し、store 全体を backup した上で、独立した保守作業として扱います。
稼働中の `events/outcomes.jsonl` を直接編集しないでください。

`violated` は上限付きで順位を上げます。
`applied` は三件以上の sample がある場合だけ順位へ反映します。
`not_applicable` と `false_positive` は上限付きで順位を下げます。
outcome がない rule の順位は outcome 導入前と同じです。

## 根拠のあるコード例

蒸留処理は、review thread に根拠がある場合だけ detail に構造化コード例を付けます。

- 生成例には `generated_example: true` を付ける
- 引用した evidence comment ID を記録する
- cited comment または diff hunk に存在する API、型、package 名だけを使う
- 根拠を確認できない場合はコード例を省略する

コード例は canonical Markdown に保存し、`get_knowledge` が `code_example` として返します。

## stats の読み方

`stats` は canonical snapshot と sync checkpoint から集計値を導出します。
同じ canonical state と request からは同じ response が得られ、集計自体は canonical data を変更しません。

```console
# 全期間の集計
repo-knowledge stats owner/repository

# 直近一週間の日次推移
repo-knowledge stats owner/repository --bucket day \
  --since 2026-08-01T00:00:00Z --until 2026-08-08T00:00:00Z

# cron 監視
repo-knowledge stats owner/repository | jq -e '.operations.failed_jobs == 0'
```

| key | 意味 |
| --- | --- |
| `stats_schema_version` | 集計契約の version |
| `canonical_digest` | canonical state の識別子 |
| `knowledge` | status、category、severity ごとの knowledge 件数 |
| `evidence` | 指定期間の evidence 件数と source |
| `outcomes` | 指定期間の outcome 件数 |
| `jobs` | 現在の distillation job 件数 |
| `sync.last_checkpoint` | 最後に保存した sync cursor |
| `operations` | pending job、failed job、最終同期時刻 |
| `buckets` | `--bucket day` で返す UTC 日次集計 |

`since` と `until` は offset 付き ISO 8601 で指定し、半開区間 `[since, until)` として扱います。
`--bucket day` では両方の指定が必要で、366 UTC 日を超える window を拒否します。

exit code は、成功が0、read failure が1、usage error が2です。
空 repository と期間内 data がない場合は zero stats を返して正常終了します。

## quality gate

抽出、分類、merge、検索の品質は、匿名化 corpus と記録済み provider prediction から再計算します。
通常の quality gate は network と provider login を使いません。

```console
npm run golden
npm run quality:gate
```

| exit | `status` | 意味 |
| ---: | --- | --- |
| 0 | `pass` | 全指標が下限以上で、fixture drift がない |
| 1 | `metric_failure` | 一つ以上の指標が下限未満 |
| 2 | `integrity_failure` | 入力、digest、schema、fixture の整合性に失敗 |

prompt、schema、trust policy を変更した場合は、記録済み prediction から baseline を再生成します。

```console
npm run golden:baseline:replay
npm run quality:gate
```

実 provider を使う測定と threshold 更新は [provider golden baseline 測定 runbook](./golden-baseline-runbook.md) に従ってください。

## storage と直接編集

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

knowledge Markdown、raw JSONL、event JSONL、repository registry は canonical data です。
`index.sqlite` は派生 projection なので、削除後に `reindex` で再構築できます。

storage root は mode 700、config、canonical file、SQLite は mode 600 に矯正します。
stdout は MCP 接続中の JSON-RPC 専用で、diagnostic と provider log は stderr に出力します。

knowledge Markdown を直接削除すると検索結果から消えますが、evidence event は残ります。
履歴を保つ場合は削除せず、admin CLI で `rejected` に変更してください。

tool 経由の更新は YAML frontmatter を再構成するため、comment、key 順、quote style を保持しません。
直接編集は command 実行中を避けてください。
ETag は更新開始前の変更を検出しますが、短い canonical commit 中の外部編集まで atomic CAS として保証しません。

security boundary、permission、prompt injection、knowledge poisoning は [SECURITY.md](../../SECURITY.md) を参照してください。
