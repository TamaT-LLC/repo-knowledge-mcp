# sync cron 運用 runbook

`repo-knowledge sync [repo] [--since <iso>] [--max-prs <n>]` は、cron から非対話で継続実行できる。
MCP の `sync_repo` tool と CLI `sync` は同一の同期サービスを共有し、同じ summary schema
`{ discovered, deferred, ingested, unchanged, jobs_created, failed, failures[], has_more, next_cursor }` を返す。
設計上の背景は [repo-knowledge-mcp v0.3 設計書](../design/repo-knowledge-mcp-v0.3.md) の §16（CLI）と §19 M2 を参照。

## 前提条件

- Node.js 22.13.0 以上の 22.x または 24.x と `gh` CLI が実行ユーザーの PATH 上にあること
- 実行ユーザーで `gh auth status` が成功し、対象リポジトリを GraphQL で読めること
- `~/.repo-knowledge/`（または `REPO_KNOWLEDGE_HOME`）が実行ユーザー所有・パーミッション 700 であること
- provider 送信（`llm.allowCloudTransmission`）は cron 運用では無効のままを推奨
- 初回導入時は `repo-knowledge doctor <owner/name>` が pass すること

Provider Adapter が有効な場合、sync は取得後の蒸留で review content と取得済み diff を外部送信し得る。
取得だけを定期実行する場合は `llm.mode: disabled` にするか、対象 repository の `allowCloudTransmission` を `false` にする。
host-assisted は同期だけでは起動せず、MCP client が `prepare_distillation` を呼んだときに処理する。

## 境界規則（checkpoint と --since）

同期は PR の `(updatedAt, PR number)` 昇順で進み、成功した PR ごとに
リポジトリ配下の `sync/checkpoint.json` へ resume 境界を耐久記録する。

- 引数なしの `sync` は保存済み checkpoint の直後から再開する。cron の定常運用はこれだけでよい
- `--since <iso>` は初回同期の開始境界を宣言する。境界より厳密に新しい `updatedAt` の PR のみが対象
- checkpoint が存在する場合、checkpoint 境界時刻以上の `--since` は
  `SYNC_SINCE_BEYOND_CHECKPOINT` で拒否される（未同期 PR が永久にスキップされるのを防ぐ fail-closed）
- checkpoint より厳密に古い `--since` は履歴の再送（replay）として許可される。ingest は冪等なので
  同じ期間を CLI と MCP から重複同期しても canonical state は変化しない
- 実行開始時刻の 60 秒前を上限（cutoff）として固定する。cutoff 以降に更新された PR は今回の対象外
  （`deferred` に計上）となり、次回実行で取り込まれる。列挙中に更新された PR も必ず cutoff 以降になる
- `--max-prs <n>`（MCP は `max_pull_requests`）は 1 回の実行で処理する PR 数の上限。古い順に n 件だけ
  処理して checkpoint を進め、残りは次回へ回す。未同期 PR が数千件ある場合は上限付きで繰り返し実行する
- `has_more: true` は checkpoint 以降に処理待ちの PR が残っていること（上限到達、失敗での停止、
  cutoff による繰り延べ）を示す。`false` になるまで引数なしで再実行すれば最新の checkpoint に到達する
- cursor と `--since` の同時指定は `SYNC_BOUNDARY_CONFLICT` で拒否される

## cron 設定

### 最小権限

- 専用の非 root ユーザーで実行する。`sudo` は不要かつ禁止
- 書き込み先は `REPO_KNOWLEDGE_HOME`（既定 `~/.repo-knowledge/`）とログファイルのみ
- GitHub トークンは保存しない。認証は `gh` CLI に委譲されるため、cron 環境に秘密情報を置かない
- ログファイルにはコメント本文などの review content を書かない（summary JSON は件数と PR 番号のみ）

### PATH と環境変数

cron の PATH は最小構成のため、`node` と `gh` の場所を明示する。

```console
$ command -v node gh
/opt/homebrew/bin/node
/opt/homebrew/bin/gh
```

### crontab 例

15 分ごとに 1 リポジトリを同期し、summary をログへ追記し、失敗時のみメール通知する例。

```crontab
MAILTO=ops@example.com
PATH=/opt/homebrew/bin:/usr/bin:/bin
# m h dom mon dow command
*/15 * * * * repo-knowledge sync owner/repository >> "$HOME/log/repo-knowledge-sync.jsonl" 2>> "$HOME/log/repo-knowledge-sync.err" || echo "repo-knowledge sync failed with exit $?"
```

- stdout は 1 行 1 JSON の summary のみなので、そのまま JSONL としてログに追記できる
- stderr には operator 向け diagnostic（エラーコードと対処）だけが出る
- `MAILTO` と `|| echo ...` の組で「非 0 exit のときだけ」cron がメールを送る。
  監視基盤がある場合は wrapper script で exit code を通知に変換する

### 終了 code

| exit | 意味                                                | cron での扱い                                          |
| ---- | --------------------------------------------------- | ------------------------------------------------------ |
| 0    | 発見した PR をすべて同期（0 件含む）                | 正常。通知不要                                         |
| 1    | 部分失敗またはエラー（lock 待ちタイムアウト等含む） | 通知して次回実行で自動再試行                           |
| 2    | 引数誤り（`--since` 形式不正など）                  | 設定ミス。crontab を修正するまで再試行しても回復しない |

## 失敗時の診断と再試行

### 二重起動と lock contention

同一リポジトリの同期はリポジトリ配下の `.sync.lock` で直列化される。cron の重複起動や
MCP `sync_repo` との同時実行は片方が lock 待ちになり、既定 5 秒で
`LOCK_TIMEOUT: Timed out waiting for <path>/.sync.lock` を出して exit 1 で終わる。

- 対処: 何もしなくてよい。先行 run が checkpoint を進めるため、次回の cron 実行が続きから再開する
- lock ファイルが残留しても、所有 PID の死活を確認して自動回収される（手動削除は不要）
- 常時競合する場合は cron 間隔を広げるか、複数リポジトリの同期ジョブを時間帯でずらす

### 部分失敗

ある PR の ingest が失敗すると、その PR で処理を停止し、checkpoint は
最後に連続成功した PR に留まる（失敗より新しい PR を先に取り込んで穴を作らない決定的規則）。

- stdout の summary: `failed >= 1`、`failures[]` に PR 番号とメッセージ
- stderr の diagnostic: `SYNC_PARTIAL_FAILURE: <failed> of <discovered> ... First failure: PR #<n>: <message>.`
- 対処: 原因（`gh` 認証切れ、レート制限、ネットワーク等）を解消して再実行するだけでよい。
  再実行は失敗 PR から再試行し、成功済み PR の再 ingest は冪等な no-op になる

### PR 一覧の走査中変更

PR を `updatedAt` 順に複数ページ走査している間に更新が入っても、同期は失敗しない。更新された PR は
新しい `updatedAt` が cutoff 以降になるため、順序が乱れて現れても今回は読み飛ばし（`deferred`）、
次回実行で取り込む。更新によってページがずれて同じ PR が同一内容で再度返った場合も読み飛ばす。

cutoff より前の範囲で重複（内容が異なるもの）や順序退行が起きた場合だけ、一覧そのものが不整合と
みなして列挙結果を破棄し、同じ checkpoint 境界から初回を含めて最大 3 回試行する。3 回とも
`PULL_REQUEST_LIST_CHANGED` になった場合、checkpoint は変更されない。MCP 応答は `retryable: true` と
同じ引数での再実行を案内するため、呼び出し側は境界を変更せずに再試行する。

### 再実行時の不変条件

- `sync` の再実行・`--since` replay・MCP `sync_repo` との重複実行のいずれでも
  canonical state（canonical digest）は増殖しない
- checkpoint は単調前進のみで、replay によって後退しない
- 検証したいときは同期を 2 回実行し、2 回目が `discovered: 0`（または全件 `unchanged`）に
  なることを確認する

### エラーコード一覧

| code                                                              | 原因                                                            | 対処                                                                                                 |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SYNC_SINCE_BEYOND_CHECKPOINT`                                    | `--since` が checkpoint 境界時刻以上                            | `--since` を外して再実行。replay したい場合は checkpoint より厳密に古い境界を指定                    |
| `SYNC_MAX_PULL_REQUESTS_INVALID`                                  | `max_pull_requests` が 1〜10000 の整数でない（CLI では `CLI_ARGUMENT_INVALID`） | 値を修正                                                                                             |
| `SYNC_BOUNDARY_CONFLICT`                                          | cursor と `--since` の同時指定                                  | どちらか一方だけを指定                                                                               |
| `SYNC_SINCE_INVALID`                                              | `--since` が ISO-8601 でない（CLI では `CLI_ARGUMENT_INVALID`） | タイムスタンプ形式を修正                                                                             |
| `SYNC_REPOSITORY_MISMATCH`                                        | 解決された repository と ingest 先の repo_id が不一致           | `--repo` 指定と config の workspaceMappings を確認                                                   |
| `SYNC_CHECKPOINT_REPOSITORY_MISMATCH`                             | checkpoint が別リポジトリのもの                                 | storage の取り違えを調査。安易に checkpoint を削除しない                                             |
| `SYNC_CHECKPOINT_INVALID` / `SYNC_CHECKPOINT_VERSION_UNSUPPORTED` | checkpoint 破損または将来 version                               | バックアップから復旧するか、全期間再同期を許容できる場合のみ checkpoint を退避して初回同期をやり直す |
| `PULL_REQUEST_LIST_CHANGED`                                      | cutoff より前の PR 一覧が自動再試行中も不整合                   | 同じ引数で再実行。checkpoint は未変更なので `since` を新しくしない                                  |
| `LOCK_TIMEOUT`                                                    | 同時実行による lock 待ちタイムアウト                            | 放置してよい。次回実行が再開する                                                                     |
| `GRAPHQL_REQUEST_FAILED` ほか `GH_*`                              | `gh` 実行失敗（未認証・ネットワーク等）                         | `gh auth status` と接続を確認して再実行                                                              |

## 動作確認手順

cron に載せる前に、同じユーザー・同じ環境変数で非対話実行を確認する。

```console
env PATH=/opt/homebrew/bin:/usr/bin:/bin \
  repo-knowledge sync owner/repository </dev/null
echo "exit=$?"
```

初回は `--since` で開始境界を明示してもよい。以後の実行は引数なしで checkpoint から再開する。
