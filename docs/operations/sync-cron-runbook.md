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

## 定期実行の登録（schedule）

同期は MCP server の中では動かさず、OS の scheduler から CLI を起動する。
`repo-knowledge schedule install <owner/name>` が scheduler ごとの設定を生成する。既定の間隔は 60 分。

| platform | `schedule install` の動作 |
| --- | --- |
| macOS | `~/Library/LaunchAgents/io.github.tamat-llc.repo-knowledge.sync.<owner>.<name>.plist` を書き、`launchctl bootstrap gui/<uid>` で登録する |
| Linux | crontab を自動編集しない。追加する行を出力するだけ（`crontab -e` で追記する） |
| その他 | `SCHEDULE_PLATFORM_UNSUPPORTED` |

```console
repo-knowledge schedule install owner/repository --dry-run     # 生成内容の確認のみ
repo-knowledge schedule install owner/repository --interval 30 --max-prs 200
repo-knowledge schedule status                                  # 登録済み job の一覧（JSON）
repo-knowledge schedule print owner/repository --format cron    # crontab 行だけを出力
repo-knowledge schedule uninstall owner/repository
```

- `--interval` は 5〜1440 分。cron 形式では 60 の約数の分か 24 の約数の時間だけを受け付ける
- 生成される設定は `node` と CLI の絶対パス、`gh` の directory を含む `PATH`、`REPO_KNOWLEDGE_HOME` を固定する。
  Node.js の更新や再インストールで path が変わったら `schedule install` を再実行する
- `npx` 経由の CLI は npm cache 内を指すため警告が出る。`npm install -g` した CLI から登録する
- log は `REPO_KNOWLEDGE_HOME/logs/sync-<owner>.<name>.jsonl`（stdout の summary JSONL）と `.err.log`（stderr）
- 最後に成功した同期時刻は `repo-knowledge stats <owner/name>` の `sync.last_success_at`、
  最後の run の結果は `sync.last_run`（`outcome`、`error_code`、`has_more`、`consecutive_failures`）で確認する

### launchd（macOS）

`schedule install` が生成する plist の要点。手で管理したい場合は `schedule print --format launchd` の出力を保存して
`launchctl bootstrap gui/$(id -u) <plist>` で登録する。

```xml
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/opt/homebrew/lib/node_modules/@tamat-llc/repo-knowledge-mcp/dist/bin.js</string>
  <string>sync</string>
  <string>owner/repository</string>
</array>
<key>StartInterval</key>
<integer>3600</integer>
<key>RunAtLoad</key>
<true/>
```

- launchd は同じ job の実行中に次の起動を重ねない。加えて repository の sync lock が CLI と MCP の同時実行も防ぐ
- スリープ中に過ぎた起動は復帰後にまとめて 1 回実行される
- 解除は `repo-knowledge schedule uninstall owner/repository`（`launchctl bootout` と plist 削除）

### GitHub Actions（self-hosted runner）

`REPO_KNOWLEDGE_HOME` の canonical data と checkpoint は永続化が必要なため、GitHub-hosted runner の
使い捨て環境ではなく、storage を保持する self-hosted runner で実行する。`concurrency` で run の重複も避ける。

```yaml
name: repo-knowledge sync
on:
  schedule:
    - cron: "0 * * * *"
  workflow_dispatch:
concurrency:
  group: repo-knowledge-sync
  cancel-in-progress: false
jobs:
  sync:
    runs-on: [self-hosted, repo-knowledge]
    timeout-minutes: 50
    steps:
      - name: Sync
        env:
          REPO_KNOWLEDGE_HOME: /srv/repo-knowledge
        run: |
          set +e
          repo-knowledge sync owner/repository --max-prs 500 </dev/null
          rc=$?
          if [ "$rc" -eq 75 ]; then exit 0; fi
          exit "$rc"
```

GitHub Actions の `schedule` は混雑時に遅延・間引きされることがある。厳密な間隔が必要なら launchd か cron を使う。

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

`repo-knowledge schedule install owner/repository --interval 15` を Linux で実行すると、追加すべき行が出力される
（crontab は編集しない）。手で書く場合は次の例のように、15 分ごとに 1 リポジトリを同期し、summary をログへ追記し、
失敗時のみメール通知する。exit 75（別の同期が実行中で skip）は通知しない。

```crontab
MAILTO=ops@example.com
PATH=/opt/homebrew/bin:/usr/bin:/bin
# m h dom mon dow command
*/15 * * * * repo-knowledge sync owner/repository </dev/null >> "$HOME/log/repo-knowledge-sync.jsonl" 2>> "$HOME/log/repo-knowledge-sync.err"; rc=$?; [ "$rc" -eq 0 ] || [ "$rc" -eq 75 ] || echo "repo-knowledge sync failed with exit $rc"
```

`schedule install` が生成する行は末尾に `# repo-knowledge-sync owner/repository` の marker を付ける。
`schedule status` はこの marker で `crontab -l` の行を探し、`schedule uninstall` は削除すべき marker を案内する。

- stdout は 1 行 1 JSON の summary のみなので、そのまま JSONL としてログに追記できる
- stderr には operator 向け diagnostic（エラーコードと対処）だけが出る
- `MAILTO` と `|| echo ...` の組で「非 0 exit のときだけ」cron がメールを送る。
  監視基盤がある場合は wrapper script で exit code を通知に変換する

### 終了 code

| exit | 意味                                                          | cron での扱い                                          |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------ |
| 0    | 発見した PR をすべて同期（0 件含む）                          | 正常。通知不要                                         |
| 1    | 部分失敗またはエラー                                          | 通知して次回実行で自動再試行                           |
| 2    | 引数誤り（`--since` 形式不正など）                            | 設定ミス。crontab を修正するまで再試行しても回復しない |
| 75   | 同じ repository の同期が実行中のため skip（`SYNC_ALREADY_RUNNING`） | 正常扱い。通知不要。次回実行が続きから再開する         |

## 失敗時の診断と再試行

### 二重起動と lock contention

同一リポジトリの同期はリポジトリ配下の `.sync.lock` で排他される。lock は PR 一覧の取得（network I/O）を含む
run 全体で保持されるため、CLI、scheduler、MCP `sync_repo` のどの組み合わせでも同時に一つしか走らない。
後から起動した run は最大 5 秒だけ lock を待ち、取れなければ何も変更せずに終わる。

- CLI: stdout に `{"reason":"SYNC_ALREADY_RUNNING","skipped":true}`、stderr に `SYNC_ALREADY_RUNNING: ...` を出して exit 75
- MCP `sync_repo`: `SYNC_ALREADY_RUNNING` を `retryable: true` で返す
- 対処: 何もしなくてよい。先行 run が checkpoint を進めるため、次回の実行が続きから再開する
- skip された run は `sync/status.json`（`stats` の `sync.last_run`）を更新しない。記録するのは lock を取った run だけ
- lock ファイルが残留しても、所有 PID が存在しなければ自動回収される（手動削除は不要）。
  異常終了した process の PID が別の process に再利用されている場合だけは回収されないので、
  `ps -p <pid>` で無関係な process と確認できたら `.sync.lock` を削除する
- 常時競合する場合は実行間隔を広げるか、`--max-prs` で 1 回の処理量を抑える

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

GitHub の `UPDATED_AT` 並びは内部の時刻で決まり、返却される `updatedAt` より遅れることがある。
そのため一部の PR は `updatedAt` から想定される位置より後ろに現れる（実データでは数分〜4 時間程度、
古い PR では 41 日の例もあった）。列挙は順序の単調性を前提にせず、checkpoint 境界よりさらに
7 日分（sort lag tolerance）古い PR が現れるまで読み進め、node ID で重複を除いてから手元で並べ替える。
この許容幅を超えて並びが遅れた PR は GitHub の `since` 絞り込みや検索の `updated:` でも拾えないため、
増分同期では検出されない。必要なら古い `--since` で履歴を再送（replay）する。

cutoff より前の範囲で同じ PR が異なる `updatedAt` で返った場合や、同じ PR 番号に異なる node ID が
返った場合は、一覧が自己矛盾しているとみなして fail-closed で停止し、checkpoint は変更しない。
走査中に repository の node ID が変わった場合は列挙結果を破棄し、同じ checkpoint 境界から初回を
含めて最大 3 回試行する。3 回とも `PULL_REQUEST_LIST_CHANGED` になった場合、checkpoint は変更されない。
MCP 応答は `retryable: true` と同じ引数での再実行を案内するため、呼び出し側は境界を変更せずに再試行する。

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
| `PULL_REQUEST_LIST_CHANGED`                                      | 走査中の repository 変化が自動再試行中も解消しない              | 同じ引数で再実行。checkpoint は未変更なので `since` を新しくしない                                  |
| `SYNC_ALREADY_RUNNING`                                            | 同じ repository の同期が実行中（CLI は exit 75）                | 放置してよい。次回実行が再開する                                                                     |
| `LOCK_TIMEOUT`                                                    | run 内部の canonical lock 待ちタイムアウト                      | 次回実行で再試行。続く場合は他の書き込み処理を確認                                                   |
| `SCHEDULE_INTERVAL_UNSUPPORTED`                                   | cron で表せない `--interval`（exit 2）                          | 60 の約数の分か 24 の約数の時間を指定                                                                |
| `SCHEDULE_GH_NOT_FOUND`                                           | `schedule install` 実行時に `gh` が PATH にない                  | `gh` をインストールして再実行                                                                        |
| `SCHEDULE_LAUNCHCTL_FAILED`                                       | `launchctl bootstrap` / `bootout` の失敗                        | stderr を確認。直前の bootout 直後なら少し待って再実行                                               |
| `GRAPHQL_REQUEST_FAILED` ほか `GH_*`                              | `gh` 実行失敗（未認証・ネットワーク等）                         | `gh auth status` と接続を確認して再実行                                                              |

## 動作確認手順

cron に載せる前に、同じユーザー・同じ環境変数で非対話実行を確認する。

```console
env PATH=/opt/homebrew/bin:/usr/bin:/bin \
  repo-knowledge sync owner/repository </dev/null
echo "exit=$?"
```

初回は `--since` で開始境界を明示してもよい。以後の実行は引数なしで checkpoint から再開する。
