# Node API と公開境界

`@tamat-llc/repo-knowledge-mcp` の package root は、CLI を Node.js から実行するための最小 API だけを安定公開します。
MCP server と CLI の通常利用では Node API を import せず、`repo-knowledge` command または stdio MCP command を使います。

## 公開 entry point

| entry point | 利用者 | 安定性 | 用途 |
| --- | --- | --- | --- |
| package root | Node.js 利用者 | stable | documented CLI runner |
| `./experimental` | source checkout 利用者と移行中の実装 | experimental | 旧 root barrel への一時的な互換経路 |
| `repo-knowledge` / `repo-knowledge-mcp` | CLI と MCP client | stable | CLI と stdio MCP server |
| その他の package subpath | repository 内部 | internal | package の `exports` で import を拒否 |

package root の inventory は次の二つで固定します。
正本は `scripts/public-api-inventory.mjs` であり、artifact gate が runtime と declaration の両方を照合します。

| symbol | kind | 利用者と用途 | repository 内 consumer |
| --- | --- | --- | --- |
| `runDefaultRepoKnowledgeCli` | value | CLI command を Node.js から実行する | packed package smoke |
| `RunDefaultRepoKnowledgeCliOptions` | type | argument、I/O、runtime option を型付けする | packed TypeScript smoke |

次の例は、storage を初期化せずに CLI help を Node.js から表示します。

```js
import { runDefaultRepoKnowledgeCli } from "@tamat-llc/repo-knowledge-mcp";

const exitCode = await runDefaultRepoKnowledgeCli({ argv: ["--help"] });
process.exitCode = exitCode;
```

## Inventory の判断

整理前の `src/index.ts` は 80 module から 532 value と 530 type、合計 1,062 symbol を再 export していました。
production module はこの barrel を import しておらず、repository 内の主な consumer は 70 test file と package smoke でした。

このため、documented CLI runner だけを stable root に残しました。
旧 root の service、schema、store、evaluation helper は stable API ではありません。
repository 内 test と source checkout 利用者の移行を可能にするため、旧 barrel は `./experimental` に移しています。
それ以外の module は internal とし、package 名からの deep import を許可しません。

## 互換性と versioning

stable root の symbol 削除、改名、または互換性のない型変更には major version を使います。
後方互換な追加には minor version、互換性を保つ修正には patch version を使います。

`./experimental` は SemVer の互換性保証と deprecation 期間の対象外です。
minor または patch release でも変更・削除される可能性があるため、新しい integration は stable root、CLI、または MCP tool を使ってください。
internal subpath は公開 API ではなく、存在していても import できることを保証しません。

この整理時点では README に記載のとおり機能版 `v0.3.0` は npm registry へ未公開であり、公開済みの v0.3 Node API consumer は存在しません。
そのため root に旧 symbol の deprecated alias は残さず、初回 v0.3 公開前に安定境界を確定しました。

source checkout で旧 root symbol を使っていた場合は、次のように import 先を変更できます。

```js
// Before: v0.3 公開前の source checkout だけで利用できた import
import { CanonicalTransactionStore } from "@tamat-llc/repo-knowledge-mcp";

// Migration escape hatch: SemVer の保証はない
import { CanonicalTransactionStore } from "@tamat-llc/repo-knowledge-mcp/experimental";
```

長期利用する integration は experimental symbol へ依存せず、CLI または MCP protocol の境界へ移行してください。

## Release gate

`npm run package:gate` は package entry point、root runtime export、生成 declaration を inventory と照合します。
`npm run package:smoke` は tarball を空の一時 project へ install し、次を検証します。

- package 名から stable root と `./experimental` を import できる
- stable root の runtime export が inventory と完全一致する
- TypeScript consumer が stable function と option type を利用できる
- internal symbol を stable root から type import できない
- CLI と stdio MCP server が installed package から動作する

inventory にない internal symbol を root へ追加すると、source test と artifact gate の両方が失敗します。
