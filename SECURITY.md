# Security policy

repo-knowledge-mcp は PR review という untrusted input を永続的な rule 候補へ変換します。
通常の MCP server より長期的な knowledge poisoning の影響を受けやすいため、data path と admin path の両方を security 対象として扱います。

## Vulnerability reporting

security issue は public issue に詳細を書かず、GitHub の [private vulnerability report](https://github.com/TamaT-LLC/repo-knowledge-mcp/security/advisories/new) から報告してください。
再現手順、影響範囲、対象 version、可能なら最小 fixture を含め、実 token、review 本文、個人情報は添付しないでください。

初回公開後の security update 対象は最新の `0.3.x` です。
未 release の main branch は best effort で修正します。

## Security boundary

MCP plane と admin plane の分離は、MCP tool 経由の承認、拒否、active 化、canonical 本文改稿を防ぐ運用境界です。
MCP tool は新規 knowledge と更新を proposal としてしか保存できず、admin operation は実 input/output TTY を要求します。
M1 は非対話承認用の `--yes` を提供しません。

この分離は、同一 OS user として任意の shell command を実行できる process や agent に対する security boundary ではありません。
同じ user は admin CLI を起動し、`~/.repo-knowledge` を直接編集し、process environment を読めます。
信頼できない agent には shell、storage directory、admin CLI への OS-level access を与えないでください。

repo-knowledge-mcp が防ぐ対象は次です。

- 未知 bot、外部 contributor、PR 本文からの自動的・永続的な knowledge activation
- model output だけを根拠にした source、actor、trust、evidence ID の偽装
- MCP tool による偶発的な active 化や status escalation
- stale lease、replay、重複 submission による二重 commit
- path traversal、symlink escape、不完全 canonical transaction の通常 read

次は防ぎません。

- 同一 OS user を侵害した process
- storage root を直接改変できる悪意ある local host
- GitHub、LLM provider、MCP host 自体の compromise
- operator が内容を確認せず proposed rule を承認すること
- review や diff に既に含まれている secret の外部送信

## Knowledge poisoning

手動 `add --active` を除き、蒸留結果はすべて `proposed` として作成されます。
未知 bot は raw-only、外部 contributor は既定で raw-only です。
設定済み AI reviewer も自動 active にはなりません。

### Auto activation の条件（M2）

`trust.autoActivateTrustedHuman` の出荷既定値は `false` で、テストで固定されています。
リポジトリ・パッケージ・設定例のどこにも `true` を既定として置きません。
有効化は operator が自分の config で行う明示 opt-in のみで、次の前提をすべて満たしてから検討します。

- `npm run quality:gate` が exit 0 で通過し続けていること
- 閾値が実 provider の live 実測に基づいて review 済みであること
- 実 PR 由来の proposed rule を人間が確認し、trusted human 由来 candidate の precision が十分であること
- cron 同期での 2 週間運用を経て、未解決の品質回帰がないこと

有効化後も auto active の対象は trusted human のコメントを evidence に含む candidate に限定され、
未知 bot・外部 contributor 由来は自動 active になりません。
gate 失敗や false positive の検出時は設定 1 行で即座に `false` へ戻します。
前提条件の詳細、合意手続き、rollback は
[trusted-human auto activation runbook](./docs/operations/trusted-human-auto-activation-runbook.md) を参照してください。

actor ID、login、association、provider alias、trust policy、prompt、schema は distillation digest に binding されます。
source、actor、trust、evidence comment ID は model 出力を信用せず、現在の complete GitHub snapshot から server が導出します。
same 判定で既存 active rule に evidence を追加できても、本文、scope、severity の変更は revision proposal になります。

承認前に少なくとも次を確認してください。

- rule が一つの PR にしか当てはまらない内容へ過剰適合していないか
- evidence URL と comment が rule を実際に支持しているか
- source と actor が期待した reviewer か
- scope が必要以上に広くないか
- `must` severity が repository の合意を反映しているか
- possible match との same / overlaps 判定が既存 rule を弱めていないか

## Prompt injection

PR title、review body、reply、diff hunk はすべて untrusted data です。
Provider Adapter はそれらを明示 tag 内の canonical JSON として system instruction から分離し、review 内の command、role change、tool request、output-format 指示に従わないよう model へ指示します。
出力は strict schema で検証し、evidence ID が現在の thread の comment subset であることを commit 前に再検証します。

これらは risk を減らしますが、model が adversarial content を誤って一般化しない保証ではありません。
永続的な防御は trust policy と人間の approval です。
prompt injection を含む repository で cloud distillation を有効にするときは、provider と host model の data handling policy も確認してください。

## Network and data transmission

GitHub への read は認証済み `gh api graphql` process へ委譲します。
repo-knowledge-mcp は GitHub token を config、canonical JSONL、log に保存しません。

LLM への外部送信は二つの独立経路があります。

- Provider Adapter は `llm.mode` に `anthropic`、`openai`、または `xai` を設定し、実効 `allowCloudTransmission: true` にする必要があります。
  server はログイン済みの Claude Code、Codex、または Grok CLI を headless mode で起動し、そのサブスクリプション session を使います。
  子 process の環境変数は実行・locale・proxy / custom CA・provider subscription 認証に必要な allowlist に限定し、Provider API key、GitHub token、cloud credential、その他の任意の親 process 環境変数を引き継ぎません。
  network bootstrap 用には `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` と lowercase 版、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS` だけを許可します。proxy URL に credential を埋め込む場合、その値も provider CLI process へ渡るため、OS permission と process trust boundary の内側で管理してください。
  Codex は user config と rule の読み込みを止め、shell、browser、computer、plugin 等の tool feature と web search を無効化した read-only mode で実行します。
- host-assisted は `hostAssistedDistillation.enabled: true` と `allowReviewContentTransmission: true` の両方が必要です。
  server 自身が provider API を呼ぶのでなく、normalized review content を MCP client へ返し、client が利用する model に渡します。

両経路は既定で無効です。
Provider Adapter は review comment、actor metadata、path、取得済み diff context、repository context、candidate、possible knowledge match を送信し得ます。
host-assisted は comment と actor metadata を返し、`includeDiffHunk: true` のときだけ diff hunk を含めます。

両経路は外部送信の直前に同じ sensitive-content scanner（機密情報検査）を実行します。
Provider Adapter では review body、diff hunk、actor、path、repository context、candidate、possible match を検査します。
host-assisted では `prepare_distillation` が返す comment、actor、path、任意の diff hunk、candidate、possible match を検査します。

scanner は provider key、GitHub / Slack token、AWS / Google key、private key、authorization header、secret の代入、メールアドレスを検出します。
送信 payload の文字列値だけでなく、JSON に含まれるプロパティ名も検査対象です。
検出時は fail-closed で送信を止め、`SENSITIVE_CONTENT_DETECTED` を返します。
scanner は検出値を error、log、telemetry、拒否結果の canonical record へ複製しません。
安全な finding には field path と kind だけが含まれます。
送信元の review と diff は、検査前の ingest で local canonical evidence に保存されている場合があります。

実在する credential を検出した場合は、まず失効または rotate してください。
その後、GitHub 上の review や diff などの送信元から値を削除または伏せ字にします。
再同期が完了してから蒸留を再実行してください。
false positive の場合は、検出された文字列を意味が変わらない表現へ書き換えます。
scanner を回避せず、書き換えられない場合は外部送信を無効のままにしてください。

scanner は既知形式の deny-list であり、すべての機密情報を検出する保証ではありません。
credential を review、diff、config へ貼らない運用は引き続き必要です。
機密 repository では provider と host-assisted の両方を無効のまま使用してください。

## Sync / outcome / provider 測定の data boundary（M2）

M2 で追加された経路が扱う data の境界は次のとおりです。

- **sync（CLI `sync` / MCP `sync_repo`）**: GitHub への read は ingest と同じ
  認証済み `gh` process へ委譲され、token は保存しません。checkpoint
  （`sync/checkpoint.json`）が持つのは PR 番号と `updatedAt` の resume 境界だけです。
  stdout の summary JSON は件数と PR 番号のみで、review 本文を含みません。
  cron のログにも review content は出ないため、summary をそのまま JSONL として
  保存できます。sync 自体は取得済み content を LLM へ送信しません。
  蒸留の外部送信可否は引き続き上記 opt-in だけで決まります。
- **record_outcome**: agent が提出した outcome（種別、任意の note、file path、
  task ID、PR 番号）は canonical event としてローカルに永続化され、外部へ
  送信されません。note と context は監査ログとして残るため、secret や
  機密情報を書かない運用にしてください。outcome は active な rule にしか
  記録できず、検索ランキングへの影響は上限付きです。
- **provider 測定（golden baseline の live 実測）**: 実測は匿名化 corpus 全文を
  ログイン済み Claude Code が使う model へ送るため、`--consent-cloud-transmission` フラグによる明示
  opt-in が必須で、CI 環境では fail-closed で拒否されます。corpus と生成
  artifact は保存前に secret scan（provider key、GitHub / Slack token、
  AWS key、private key、メールアドレス等）を通過する必要があり、検出時は
  値を出力せず失敗します。認証には Claude Code のサブスクリプション session を使います。
  CI と通常運用の gate は記録済み prediction の replay だけで動き、
  network にも credential にも触れません。手順は
  [golden baseline 測定 runbook](./docs/operations/golden-baseline-runbook.md) を参照してください。

## Local storage

canonical data は既定で `~/.repo-knowledge` に保存され、review 本文、diff context、actor metadata、rule、event history を含み得ます。
storage root は mode 700、config と data file は mode 600 に矯正されます。
Git repository へ誤って追加したり、広い user group と backup を共有したりしないでください。

M1 が保証するのは macOS / Linux のローカル filesystem だけです。
Windows、NFS、SMB、Dropbox、iCloud Drive、その他の network mount や同期領域では、permission、PID lock、atomic rename、append、fsync の前提が成立しないため使用しないでください。
symlink 化した config、canonical target、storage escape は拒否されます。

`index.sqlite` は派生 projection であり、canonical source ではありません。
破損や不整合が疑われる場合は process を止め、backup を取り、`repo-knowledge doctor` で診断してから `reindex` してください。
doctor は canonical data や registry identity を自動修復しません。

## Direct Markdown edits

Auditable Markdown は意図的な運用面ですが、external editor は repo-knowledge の writer lock を取得しません。

- ETag は update 開始前に存在した編集を検知します。
- stage 完了後にも precondition を再検証しますが、短い canonical commit 区間中の外部編集を完全な atomic CAS としては保証しません。
- CLI、MCP ingest、reindex、recovery の実行中は直接編集しないでください。
- tool 経由の update は frontmatter を再 serialize するため、YAML comment、key 順、quote style を保持しません。
- knowledge Markdown を直接削除すると active search から消えますが evidence event は残り、doctor が orphan として報告します。
  監査履歴を保つには削除でなく `status: rejected` を使用してください。
- duplicate ID、invalid YAML、repo ID 不一致を検出した read は古い SQLite を返さず fail-closed になります。

## Process output and logs

stdio server の stdout は JSON-RPC 専用です。
diagnostic、provider lifecycle、warning は stderr に出します。
stdout へ追加の log を書く wrapper や shell profile は MCP frame を破損するため使用しないでください。

log は review body や provider response を意図的に含めませんが、repository 名、job ID、provider、model、error classification は含み得ます。
support へ共有する前に組織名や identifier を確認してください。

## Operator checklist

- `gh auth status` の account と repository scope を確認する
- `repo-knowledge doctor <repo>` を実行し、fail を解消する
- unknown bot warning を確認し、信頼できる actor だけを `aiReviewers` に登録する
- cloud opt-in 前に review / diff の機密性と provider policy を確認する
- proposed rule の evidence、scope、severity を TTY 上で確認してから承認する
- storage を local filesystem に置き、permission と backup access を定期確認する
- MCP client に不要な shell access と admin CLI access を与えない
