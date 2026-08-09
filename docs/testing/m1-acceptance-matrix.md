# M1 acceptance traceability matrix

M1 の完了条件と受け入れテスト 1〜63 を、実行可能な test または再現可能な smoke gate へ対応付ける。
`npm run check` は automated 欄の test と Node 22/24 の CI を実行し、実 GitHub データが必要な項目だけ [real PR smoke runbook](./m1-smoke-runbook.md) で確認する。

## Architecture criteria 1〜12

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| 1 | 実 PR 10 件を取り込める | [smoke gate test](../../test/m1-smoke-gate.test.ts)、[manifest](./m1-smoke-manifest.json)、[記録結果](./m1-smoke-results.json) | real smoke |
| 2 | 同一 PR の反復 ingest で evidence が増えない | [GitHub ingest test](../../test/github-ingest-service.test.ts)、[product E2E](../../test/m1-product-e2e.test.ts)、実 smoke の idempotency | automated + real smoke |
| 3 | comment 編集・reply 追加時だけ再蒸留する | [GitHub ingest test](../../test/github-ingest-service.test.ts)、[snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |
| 4 | 1 thread から 0〜N rule を抽出できる | [provider boundary test](../../test/provider-distillation-service.test.ts)、[pipeline test](../../test/provider-distillation-pipeline.test.ts) | automated |
| 5 | 未知 bot 由来 rule を自動 active にしない | [GitHub ingest test](../../test/github-ingest-service.test.ts)、[snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |
| 6 | index.sqlite を削除して完全再構築できる | [knowledge search test](../../test/knowledge-search.test.ts)、[canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 7 | Claude Code / Cursor 相当の stdio client から get_rules を呼べる | [real stdio E2E](../../test/mcp-stdio-e2e.test.ts)、[MCP server test](../../test/mcp-server.test.ts) | automated |
| 8 | get_rules が id、matched_scopes、truncated を返す | [knowledge read test](../../test/knowledge-read-service.test.ts)、[MCP server test](../../test/mcp-server.test.ts) | automated |
| 9 | LLM 未設定でも raw 保存と job 化が完了する | [product E2E](../../test/m1-product-e2e.test.ts)、[provider service test](../../test/provider-distillation-service.test.ts) | automated |
| 10 | cloud 送信は明示 opt-in の場合だけ行う | [config test](../../test/config.test.ts)、[provider service test](../../test/provider-distillation-service.test.ts)、[doctor test](../../test/doctor-service.test.ts) | automated |
| 11 | MCP と CLI の同時実行で canonical store が破損しない | [product E2E](../../test/m1-product-e2e.test.ts) | automated |
| 12 | Node.js 22 と 24 で全 check が通る | [CI workflow](../../.github/workflows/ci.yml) | CI matrix |

## Mutation path criteria 13〜24

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| 13 | canonical commit の各工程で kill しても完全復旧する | [canonical transaction kill-point test](../../test/canonical-transaction-store.test.ts) | automated process E2E |
| 14 | canonical commit 後かつ SQLite 更新前の kill から index を修復する | [canonical transaction kill-point test](../../test/canonical-transaction-store.test.ts) | automated process E2E |
| 15 | Markdown 手編集後は古い ETag の更新を拒否する | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 16 | MCP から rule を active 化できない | [MCP mutation test](../../test/mcp-mutation-tools.test.ts)、[model-plane test](../../test/model-plane-knowledge-service.test.ts) | automated |
| 17 | expired lease の遅延 worker commit を STALE_LEASE で拒否する | [job coordinator test](../../test/distill-job-coordinator.test.ts) | automated |
| 18 | resolved / outdated だけの変更では evidence と job を増やさない | [GitHub ingest test](../../test/github-ingest-service.test.ts)、[snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |
| 19 | 撤回 thread の evidence を withdrawn、rule を stale にする | [canonical finalize test](../../test/canonical-finalize-service.test.ts)、[GitHub ingest test](../../test/github-ingest-service.test.ts) | automated |
| 20 | unknown bot を設定追加後、GitHub 再取得なしで redistill する | [CLI maintenance test](../../test/cli-maintenance-service.test.ts) | automated |
| 21 | repository rename 後も同じ repo ID store を使う | [repository registry test](../../test/repository-registry.test.ts)、[repository resolver test](../../test/repository-resolver.test.ts) | automated |
| 22 | 複数語 query を literal-safe な term 検索にし、FTS operator を user 構文として実行せず、全候補の順位付け前に有限 limit で切らない | [knowledge search test](../../test/knowledge-search.test.ts)、[knowledge read test](../../test/knowledge-read-service.test.ts) | automated |
| 23 | proposed rule を通常検索と get_rules に混入させない | [knowledge read test](../../test/knowledge-read-service.test.ts)、[model-plane test](../../test/model-plane-knowledge-service.test.ts) | automated |
| 24 | 不完全な GraphQL pagination から job を作らない | [GitHub client test](../../test/github-pull-request-client.test.ts)、[GitHub ingest test](../../test/github-ingest-service.test.ts) | automated |

## Write path criteria 25〜38

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| 25 | prepared 後・append 前の kill を staged payload から復旧する | [canonical transaction kill-point test](../../test/canonical-transaction-store.test.ts) | automated process E2E |
| 26 | staged payload 欠損を UNRECOVERABLE_TRANSACTION で fail-closed にする | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 27 | commit 中の read が新旧混在 snapshot を返さない | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 28 | 2 repository の同時初回登録で両 entry を保持する | [repository registry test](../../test/repository-registry.test.ts) | automated |
| 29 | finalize response 消失後の retry で同じ receipt を返す | [submit finalize test](../../test/submit-finalize-service.test.ts) | automated |
| 30 | 同じ submission_id の異なる payload を拒否する | [request integrity test](../../test/request-integrity.test.ts)、[submit distillation test](../../test/submit-distillation-service.test.ts) | automated |
| 31 | extract 後に merge target が変われば MERGE_TARGET_CHANGED にする | [submit finalize test](../../test/submit-finalize-service.test.ts)、[finalize guard test](../../test/finalize-guard.test.ts) | automated |
| 32 | complete snapshot から消えた thread の evidence を withdrawn にする | [GitHub ingest test](../../test/github-ingest-service.test.ts)、[canonical finalize test](../../test/canonical-finalize-service.test.ts) | automated |
| 33 | 同一 thread の candidate が同一 knowledge に集約されても active evidence は 1 件にする | [canonical finalize test](../../test/canonical-finalize-service.test.ts)、[domain projection test](../../test/domain-projection.test.ts) | automated |
| 34 | Markdown 手編集後も新しい evidence event を記録する | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 35 | prompt bytes の変更を version 据え置きでも digest へ反映する | [config test](../../test/config.test.ts)、[snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |
| 36 | registry 更新と repo write の並行実行で deadlock しない | [repository registry test](../../test/repository-registry.test.ts)、[repository application test](../../test/repository-application.test.ts)、[product concurrency E2E](../../test/m1-product-e2e.test.ts) | automated |
| 37 | unresolved prepared transaction 中に古い SQLite read を返さない | [canonical transaction recovery test](../../test/canonical-transaction-store.test.ts)、[doctor test](../../test/doctor-service.test.ts) | automated |
| 38 | GraphQL comment 順が変わっても content fingerprint を維持する | [snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |

## Write path criteria 39〜54

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| 39 | extract receipt に plaintext finalize token を保存しない | [domain schema test](../../test/domain-schemas.test.ts)、[job coordinator test](../../test/distill-job-coordinator.test.ts) | automated |
| 40 | extract 後の再起動から新 token で finalize できる | [submit distillation test](../../test/submit-distillation-service.test.ts)、[host-assisted test](../../test/host-assisted-distillation-service.test.ts) | automated |
| 41 | token 期限切れ後も finalize receipt を同じ結果で replay する | [submit finalize test](../../test/submit-finalize-service.test.ts) | automated |
| 42 | Markdown の active → rejected 手編集を次の read へ反映する | [knowledge file-state test](../../test/knowledge-file-state.test.ts)、[knowledge read test](../../test/knowledge-read-service.test.ts) | automated |
| 43 | duplicate ID / invalid YAML で古い SQLite を返さず fail-closed にする | [doctor test](../../test/doctor-service.test.ts)、[knowledge file-state test](../../test/knowledge-file-state.test.ts) | automated |
| 44 | JSONL partial append を末尾修復して完全行を再 append する | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated process E2E |
| 45 | 同じ record_id の異なる line hash を RECORD_ID_CONFLICT にする | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 46 | staged append の line hash 不一致を適用しない | [canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |
| 47 | extract 後の match set 追加を MERGE_CANDIDATES_CHANGED にする | [canonical finalize test](../../test/canonical-finalize-service.test.ts)、[submit finalize test](../../test/submit-finalize-service.test.ts) | automated |
| 48 | definitive 0 candidate の再蒸留で旧 evidence を withdrawn にする | [submit distillation test](../../test/submit-distillation-service.test.ts)、[canonical finalize test](../../test/canonical-finalize-service.test.ts) | automated |
| 49 | finalize decision の不足・重複・余分な candidate ID を拒否する | [submit finalize test](../../test/submit-finalize-service.test.ts)、[host-assisted test](../../test/host-assisted-distillation-service.test.ts) | automated |
| 50 | thread 外の evidence_comment_ids を拒否する | [provider boundary test](../../test/provider-distillation-service.test.ts)、[canonical finalize test](../../test/canonical-finalize-service.test.ts) | automated |
| 51 | JSON key 順を変えても JCS digest を維持する | [canonical test](../../test/canonical.test.ts) | automated |
| 52 | set 扱い config の配列順を変えても trust digest を維持する | [config test](../../test/config.test.ts) | automated |
| 53 | prepared manifest 後の COMMITTED marker 作成中 kill から復旧する | [canonical transaction kill-point test](../../test/canonical-transaction-store.test.ts) | automated process E2E |
| 54 | GraphQL 順・actor login・association 変化を distillation key へ正しく反映する | [snapshot normalizer test](../../test/github-snapshot-normalizer.test.ts) | automated |

## Errata criteria 55〜63

| # | 受け入れ条件 | 検証根拠 | 種別 |
|---:|---|---|---|
| 55 | extract receipt replay が新 token と最新 possible_matches を返す | [receipt replay test](../../test/receipt-replay.test.ts) | automated |
| 56 | 0 candidate receipt を skipped として token なしで replay する | [receipt replay test](../../test/receipt-replay.test.ts) | automated |
| 57 | submission_id だけが違う同一 request の hash を一致させる | [request integrity test](../../test/request-integrity.test.ts) | automated |
| 58 | 同一 submission_id で decision を変えると IDEMPOTENCY_KEY_REUSED にする | [request integrity test](../../test/request-integrity.test.ts) | automated |
| 59 | extract 後の comment 編集を DISTILLATION_SOURCE_CHANGED にする | [finalize guard test](../../test/finalize-guard.test.ts) | automated |
| 60 | extract 後の prompt / trust policy 変更を DISTILLATION_CONTEXT_CHANGED にする | [finalize guard test](../../test/finalize-guard.test.ts) | automated |
| 61 | locale を変えても set、comment 順、JCS digest を維持する | [canonical test](../../test/canonical.test.ts) | automated |
| 62 | insufficient_context で active evidence を withdrawn にしない | [evidence policy test](../../test/evidence-policy.test.ts) | automated |
| 63 | 同一 byte size の Markdown 編集でも projection 失効を検出する | [knowledge file-state test](../../test/knowledge-file-state.test.ts)、[canonical transaction test](../../test/canonical-transaction-store.test.ts) | automated |

## Cross-cutting M1 gates

- 匿名化 50 fixture と抽出・category・severity・merge・scope・search 指標は [golden runbook](./m1-golden-runbook.md) と [golden evaluator test](../../test/golden-evaluator.test.ts) で再現する。
- provider disabled、fake Anthropic adapter、host-assisted の 3 経路は [product E2E](../../test/m1-product-e2e.test.ts) で canonical ingest から approval、get_rules まで確認する。
- real stdio child process は [stdio E2E](../../test/mcp-stdio-e2e.test.ts) で全 tool（M2 追加分を含む 11 tool）の list/call と stdout の JSON-RPC 純度を確認する。
- LLM 待機中の lock 解放、lease expiry、遅延 worker fencing は [provider service test](../../test/provider-distillation-service.test.ts) と [job coordinator test](../../test/distill-job-coordinator.test.ts) で確認する。
- Markdown 手編集、kill-point recovery、MCP + CLI concurrent write は上表の 13〜15、34、53、11 で明示的に追跡する。
