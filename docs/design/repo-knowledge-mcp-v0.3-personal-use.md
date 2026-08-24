# repo-knowledge-mcp M3 個人利用要件

- ID: RKM-REQ-M3-001
- Layer: L2
- Feature: personal-knowledge
- Scope: global
- Status: Draft
- Open Questions: 0
- Updated: 2026-08-09
- Upstream: [repo-knowledge-mcp 統合仕様書 v0.3](./repo-knowledge-mcp-v0.3.md)

## 概要

M3 は、過去の Pull Request レビューを各開発者のローカルナレッジへ変換し、Codex や Claude Code がコード変更前に利用できる状態を完成させる。

利用者は、knowledge status、distillation job、canonical store などの内部概念を知らなくても、対象リポジトリで MCP を利用できなければならない。

M3 はチーム共通のルール台帳を構築しない。

各利用者は、自分の GitHub 権限、自分が選んだ信頼対象、自分の利用結果に基づくローカルナレッジを所有する。

## 利用者モデル

M3 の主な利用者は、対象リポジトリの過去のレビュー方針を把握していない開発者である。

利用者は個々のルールの正しさを事前に判断するのではなく、信頼するレビュアーと外部送信の可否を設定する。

通常の利用では `get_rules` が適用可能な active rule を返し、利用者は承認操作を行わない。

候補の由来または内容が自動 active 化の条件を満たさない場合だけ、review inbox を使用する。

## スコープ

### 対象

- `~/.repo-knowledge/` に置く利用者単位のローカルストア
- npm registry からの一時実行と継続利用向けインストール
- カレントワークスペースと Git remote を使ったリポジトリ解決
- 初回同期、外部送信、信頼対象を案内する guided setup
- `get_rules` の readiness と次の操作
- trusted human 由来候補の明示的な opt-in に基づく自動 active 化
- 自動 active 化しない候補を確認する review inbox
- 一つの TTY セッションで候補を順に処理する batch review
- `record_outcome` による利用者単位のランキング調整

### 対象外

- リポジトリ内 `.repo-knowledge/` を正本とする storage mode
- knowledge、raw review、event log の Git 共有
- チーム全員で同じルール集合を維持する保証
- 組織管理者による中央配布または一括承認
- クラウド同期とサーバーサイドのナレッジストア
- ルール本文の一括 export

`export --bootstrap` は、エージェントへ `get_rules` の呼び出しを促す既存機能として維持する。

## 機能要件

### M3-FR-001 個人用ローカルストア

M3 は、利用者ごとの config、raw review、distillation job、knowledge、outcome を `~/.repo-knowledge/` 配下へ保存する。

M3 のコマンドは、対象リポジトリのワークツリーへ canonical data を作成しない。

### M3-FR-002 Guided setup

`repo-knowledge setup` は、カレントワークスペースから対象リポジトリを解決し、GitHub CLI の認証、ローカルストア、provider、信頼設定、初回同期の状態を順に検査する。

外部送信は既定で無効とし、送信先と送信対象を表示した後の明示的な同意によってのみ有効化する。

setup は、対象リポジトリで観測した人間レビュアーを信頼候補として表示できるが、利用者の確認なしに `trustedLogins` へ追加しない。

初回同期は直近 90 日を既定範囲とする。
利用者は `--since <iso-datetime>` で開始境界を上書きでき、全履歴が必要な場合だけ `--all-history` を明示する。
setup は repository ごとの durable state と sync checkpoint を使い、中断後の再実行では最初に選択した範囲を維持して再開する。

実 TTY の setup は、repository と private storage の解決、local store 準備、preflight doctor、初回同期、trust 候補検出、必要な再蒸留、最終 doctor を名前付き phase として stderr に表示する。
長時間 phase では spinner と経過時間を更新し、質問を表示する前に活動表示を完了させる。
正常終了時の既定 stdout は、repository、同期件数、privacy、trust、doctor、現在状態、次の操作をまとめた人間向け summary とする。
完全な `GuidedSetupResult` が必要な利用者は `setup --json` を明示し、この場合は progress を無効化して stdout を JSON 1 document に限定する。

### M3-FR-003 Repository readiness

`get_rules` は、ルールの一致結果に加えて repository readiness を返す。

readiness は次の四状態とする。

| 状態 | 条件 | 利用者へ返す案内 |
| --- | --- | --- |
| `setup_required` | 同期実績、job、knowledge がない | guided setup または初回同期 |
| `learning` | active rule がなく、pending job または proposed knowledge がある | 蒸留設定または review inbox |
| `ready` | active rule が一件以上ある | 一致ルールを利用し、一致がなければ正常な空結果として扱う |
| `empty` | 同期済みだが再利用可能な候補がない | 現時点で利用できるルールがないことを通知 |

`matched_count: 0` だけでは、正常な不一致と初期設定不足を区別できない。

そのため、active rule がない場合も `state` と `next_action` を返す。

### M3-FR-004 信頼対象の選択

利用者は、GitHub login または actor ID を使って trusted human を選択する。

setup は、同一人物の alias と bot identity を区別し、未知 bot と外部コントリビューターを信頼候補へ含めない。

信頼設定は利用者のローカル config にだけ保存する。

### M3-FR-005 安全な自動 active 化

`trust.autoActivateTrustedHuman` の出荷既定値は `false` のまま維持する。

thread 正規化時の initial knowledge status は `proposed` に固定する。

独立した auto activation policy は、最終 candidate の severity と最新 thread 全体がそろう finalize 時にだけ初期 status を決定する。

利用者は、M2 pilot が go 判定され、live measurement に基づく quality gate が通過している場合に限り、自分の config で自動 active 化を有効にできる。

この前提は、pilot report、live baseline、gate report の digest と gate が参照した trust policy digest を含む operator-local eligibility として記録する。

自動 active 化の対象は、originator が trusted human であり、thread 内の全 comment が trusted human に分類され、severity が `must` ではない候補に限定する。

AI reviewer、未知 bot、外部コントリビューター、複数の trust class が混在する thread、severity が `must` の候補は review inbox へ送る。

quality gate の失敗または trust policy generation の変更を検出した場合、新しい候補の自動 active 化を停止する。

停止は既存 active rule の status を変更しない。

### M3-FR-006 Review inbox

review inbox は、proposed knowledge と pending revision proposal を利用者向けの同じ一覧として表示する。

各項目は、ルール本文、severity、scope、由来、信頼区分、根拠 URL、既存ルールとの関係を含む。

inbox が未処理でも、既存の active rule の検索と利用を妨げない。

### M3-FR-007 Batch review

`repo-knowledge review` は、review inbox の項目を一つの TTY セッションで順に表示する。

利用者は各項目を approve、reject、skip、edit のいずれかで処理し、途中終了後に未処理項目から再開できる。

knowledge candidate の edit は候補本文を更新して未処理状態を維持する。
revision proposal の edit は pending patch を更新し、reject は対象の active knowledge を変更せず proposal だけを解決する。
各判断は表示した knowledge の revision / ETag と proposal の ETag に束縛し、競合時は最新内容を再表示する。

review の表示は、session の pending / resolved / edited / skipped、rule と説明、適用範囲と信頼情報、evidence、possible match、内部 metadata の順で情報階層を分ける。
inbox 読み込みと approve / reject / edit の更新中は、setup と同じ stderr progress を表示する。
外部由来の rule、detail、scope、login、URL、ID、metadata は terminal control sequence を無害化してから表示する。

MCP plane は status を active または rejected へ変更しない。

### M3-FR-008 npm 配布

公開 package はnpm organization `tamat-llc`が所有し、package名を`@tamat-llc/repo-knowledge-mcp`とする。

公開 package は、Node.js 22 と 24 の対応環境で `npx -y @tamat-llc/repo-knowledge-mcp@<version>` から起動できる。

公開 package だけを使って guided setup、stdio MCP server、既存 CLI command を実行できる。

release workflow は version、Git tag、commit、main への到達性、clean working tree、Node.js、npm、registry 上の version 未使用を公開前に検査する。

公開 tarball は明示 allowlist に一致し、local knowledge、review content、fixture、database、credential を含まないことを dry-run と実 artifact の双方で検査する。

通常公開は GitHub Actions OIDC による npm trusted publishing と provenance を使い、長期 npm credential を repository secret に保存しない。

未作成packageの初回name reservationでは、実行コード、lifecycle script、dependencyを含まない`0.0.0-bootstrap.0`だけを2FA付きorganization memberから対話的に公開する。

Stable packageは初回の`0.3.0`からOIDCで公開し、GitHub Actionsへtraditional npm credentialを渡さない。

provenance を生成できない private repository からの公開は拒否する。

publish 後は registry の exact version から CLI と stdio MCP server を再検証する。

運用手順と rollback は [npm release runbook](../operations/npm-release-runbook.md) に定義する。

## 非機能要件

### M3-NFR-001 Privacy

GitHub token は保存せず、GitHub へのアクセスは `gh` CLI の認証へ委譲する。

review content と diff を LLM へ送る処理は、経路ごとの明示的な opt-in がない限り実行しない。

### M3-NFR-002 後方互換性

既存の `REPO_KNOWLEDGE_HOME`、repository registry、CLI、MCP tool の入力は維持する。

`get_rules` の readiness は既存出力に対する加算的な変更とし、既存 field の意味を変更しない。

### M3-NFR-003 空状態の説明

CLI と MCP は、初期設定不足、蒸留待ち、候補なし、検索不一致を異なる状態として報告する。

利用者に内部 ID だけを提示して操作を要求しない。

### M3-NFR-004 対応環境

保証範囲は、Node.js 22 または 24 を使う macOS と Linux のローカル filesystem とする。

Windows、network filesystem、同期フォルダは引き続き保証対象外とする。

### M3-NFR-005 対話状態の可視性

実 TTY で二秒を超える処理は、現在の phase と経過時間を利用者が確認できること。

activity renderer は成功、失敗、EOF、割り込み、所有者による close のすべてで timer と描画行を解放する。
progress と prompt は stderr、人間向けまたは JSON の最終結果は stdout に分離し、非対話 command と MCP stdio の既存 stdout 契約へ影響させない。

## 制約

- MCP server instructions だけでは、クライアントが必ず `get_rules` を呼ぶとは限らない。
- provider を無効にした利用者は raw review と pending job まで利用できるが、蒸留済みルールは生成されない。
- 個人利用モデルでは、異なる利用者の trust policy、蒸留結果、outcome によってルール集合と順位が異なり得る。
- admin plane は MCP tool 経由の偶発的な権限昇格を防ぐ運用境界であり、同じ OS user で任意 shell を実行できるプロセスに対するセキュリティ境界ではない。

## 決定事項

| ID | 論点 | 決定内容 | 影響 | 担当 | 決定日 | 状態 |
| --- | --- | --- | --- | --- | --- | --- |
| Q-001 | 初回同期の既定範囲 | 直近 90 日を既定とし、`--since` と `--all-history` を明示 override とする | Non-blocking | M3 implementation | 2026-08-09 | Decided |

## 受け入れ条件

| ID | 関連要件 | 条件 | 検証方法 |
| --- | --- | --- | --- |
| M3-AC-001 | M3-FR-001、M3-FR-002 | storage が存在しない環境で setup を実行すると、対象 repository を解決し、安全な既定 config と private storage を作成する | CLI E2E |
| M3-AC-002 | M3-FR-002、M3-NFR-001 | 外部送信へ同意しない setup では review content と diff を LLM へ送らず、raw 保存と job 化まで完了する | E2E と transmission spy |
| M3-AC-003 | M3-FR-003、M3-NFR-003 | active rule がなく pending job がある repository で `get_rules` を呼ぶと、`learning` と具体的な `next_action` を返す | MCP E2E |
| M3-AC-004 | M3-FR-003 | active rule は存在するが指定 file と task に一致しない場合、`ready` と空の rules を返す | MCP E2E |
| M3-AC-005 | M3-FR-004、M3-FR-005 | gate 条件を満たして opt-in した利用者では、全 comment が trusted human で severity が `must` ではない候補だけが active になる | policy unit test と product E2E |
| M3-AC-006 | M3-FR-005、M3-FR-006 | AI、未知 bot、外部 contributor、mixed trust、severity `must` の候補は active にならず review inbox に残る | policy matrix test |
| M3-AC-007 | M3-FR-006、M3-FR-007 | 一つの review session で approve、reject、skip、edit を実行でき、再起動後は未処理項目から再開する | PTY E2E |
| M3-AC-008 | M3-FR-008、M3-NFR-004 | clean environment の Node.js 22 と 24 で registry package から CLI help と stdio MCP server を起動できる | package smoke と CI matrix |
| M3-AC-009 | M3-NFR-002 | M2 config と local store を変更せずに更新しても、既存 repository と knowledge を読み取れる | upgrade E2E |
| M3-AC-010 | スコープ | M3 の全 E2E 実行後も対象 repository のワークツリーへ `.repo-knowledge/` が作成されない | filesystem assertion |
| M3-AC-011 | M3-FR-002、M3-FR-007、M3-NFR-005 | setup と review の実 TTY で phase と経過時間を確認でき、prompt 前と成功・失敗・EOF・割り込み後に描画が残らず、`setup --json` は ANSI を含まない JSON 1 document だけを stdout に返す | setup / review PTY E2E と renderer unit test |

## Issue への対応

| Issue | 対応範囲 |
| --- | --- |
| [#86](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/86) | M3 個人利用契約 |
| [#87](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/87) | Guided setup |
| [#88](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/88) | Repository readiness |
| [#89](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/89) | Trust setup と自動 active 化 |
| [#90](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/90) | Review inbox |
| [#91](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/91) | Batch review |
| [#92](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/92) | npm release workflow |
| [#93](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/93) | M3 受け入れと release |
| [#107](https://github.com/TamaT-LLC/repo-knowledge-mcp/issues/107) | TTY progress、setup summary、review 情報階層 |

## 関連ドキュメント

- [repo-knowledge-mcp 統合仕様書 v0.3](./repo-knowledge-mcp-v0.3.md)
- [M2 受け入れ matrix](../testing/m2-acceptance-matrix.md)
- [trusted-human auto activation runbook](../operations/trusted-human-auto-activation-runbook.md)
- [npm release runbook](../operations/npm-release-runbook.md)
- [M2 cron pilot plan](../operations/m2-cron-pilot-plan.md)
- [M2 cron pilot report template](../operations/m2-cron-pilot-report-template.md)
- [M3 acceptance matrix](../testing/m3-acceptance-matrix.md)
- [M3 release report template](../operations/m3-release-report-template.md)
