# repo-knowledge-mcp 紹介動画

PRレビューの知見を次の実装で再利用する流れを紹介するRemotion動画です。
このディレクトリには2種類の動画を収録しています。

| 動画 | 尺 | 出力 | 音声 |
| --- | --- | --- | --- |
| ナレーション付き紹介動画（新作） | 約55秒 | 16:9（1920×1080）と9:16（1080×1920） | 日本語AIナレーション、BGM、効果音 |
| 42秒版・60秒版（既存） | 42秒 / 60秒 | 1920×1080 | BGMのみ、ナレーションなし |

いずれも30 fps、日本語テロップ付きです。

## 再生・編集・書き出し

このディレクトリで依存関係をインストールすると、Remotion Studioで編集できます。
動画用の依存関係は、MCPサーバーのパッケージから独立しています。

```sh
cd video
npm ci --ignore-scripts
npm run studio
```

MP4、サムネイル、確認用の静止画は次のコマンドで生成します。
初回の書き出しでは、RemotionがChrome Headless Shellをダウンロードします。
フォントと音源は同梱しているため、素材取得のための外部通信は不要です。

```sh
npm run check
npm run render:quick
npm run poster:quick
npm run stills:quick
```

元の60秒版は次のコマンドで再現できます。

```sh
npm run render
npm run poster
npm run stills
```

| 出力 | 保存先 |
| --- | --- |
| 42秒版 / H.264 + AAC | `out/repo-knowledge-intro-quick.mp4` |
| 42秒版のサムネイル | `out/poster-quick.png` |
| 42秒版の確認画像 | `out/stills-quick/` |
| 元の60秒版 | `out/repo-knowledge-intro.mp4` |
| 元の60秒版のサムネイル・確認画像 | `out/poster.png`、`out/stills/` |

生成物の`out/`はGit管理から除外しています。
書き出しのオプションは[Remotion公式ドキュメント](https://www.remotion.dev/docs/cli/render)を参照してください。

## ナレーション付き紹介動画（新作）

repo-knowledge-mcpの紹介動画（ナレーション付き、約55秒）です。
PRに残った一行のレビューコメントが、蒸留と承認を経てruleになり、3つのエージェントで使われるまでを一本のthread上で描きます。
画面に出す機能とコマンドは、v0.4.2時点の[プロジェクトのREADME](../README.md)に基づいています。
画面に出すPR、レビューコメント、ルール、`get_rules`の応答はREADMEの例をもとにした説明用の例で、実画面の録画ではありません。

### 書き出し

```sh
npm run render:promo
npm run render:promo:vertical
npm run poster:promo
npm run poster:promo:vertical
npm run stills:promo
```

| 出力 | 保存先 |
| --- | --- |
| 16:9（1920×1080） | `out/repo-knowledge-promo.mp4` |
| 9:16（1080×1920） | `out/repo-knowledge-promo-vertical.mp4` |
| 16:9のサムネイル | `out/poster-promo.png` |
| 9:16のサムネイル | `out/poster-promo-vertical.png` |
| 確認画像（両方の向き） | `out/stills-promo/` |

### シーン構成

コンポジションIDは16:9が`RepoKnowledgePromo`、9:16が`RepoKnowledgePromoVertical`です（[src/Root.tsx](src/Root.tsx)）。
時間は[src/promo/timeline.json](src/promo/timeline.json)の実測値です。

| 時間 | シーン | 内容 |
| --- | --- | --- |
| 0.00–6.47秒 | s01-hook：一行のレビューが、ルールになるまで。 | PRのレビューコメントを1文字ずつ表示し、threadの起点ノード「PR」を灯す |
| 6.47–12.40秒 | s02-product：repo-knowledge-mcp | 主役トークンがカメラに追従し、これから通るステーション名をルートマップとして示す |
| 12.40–18.33秒 | s03-local：根拠は、手元に。 | `gh`バッジを通過し、`~/.repo-knowledge/`にraw evidenceとして保存する |
| 18.33–26.13秒 | s04-optin：送るかどうかは、自分で決める。 | 外部送信のトグルをONにする操作を朱色で示す |
| 26.13–33.27秒 | s05-approval：決めるのは、人間。 | 人間がTTYで根拠を確認し、承認のリングを朱色で示す |
| 33.27–39.83秒 | s06-rules：変更の前に、get_rules。 | エージェントが`get_rules`を呼び、対象ファイルに合うルールが返る |
| 39.83–47.70秒 | s07-agents：ひとつの知見を、3つのエージェントで。 | Codex、Claude Code、Cursorに同じルール文を並べ、元のレビューへ光を逆流させる |
| 47.70–54.70秒 | s08-cta：一行のレビューから、はじめる。 | セットアップコマンドとリポジトリへの案内を表示する |

### 仕組み

台本からナレーション、timeline.json、動画までは次の順で作ります。

```text
台本（src/promo/script.json）
  ↓ ナレーション生成（Higgsfield、手動）
生のナレーションwav
  ↓ npm run timeline:promo -- --raw <dir>
timeline.jsonとナレーションm4a
  ↓ npm run audio:promo
BGMと効果音（timeline.jsonのシーン尺・キューから生成）
  ↓ npm run render:promo / render:promo:vertical
動画（尺・字幕・キューはtimeline.jsonから導出）
```

台本やナレーションを差し替えたときは、timeline → audio → renderの順に実行し直します。

```sh
npm run timeline:promo -- --raw <dir>
npm run audio:promo
npm run render:promo
npm run render:promo:vertical
```

`--raw <dir>`には、シーンID（`s01-hook`など）を名前にしたナレーションのwavファイルを置きます。
timeline.jsonのシーン尺が変わるため、ナレーションを差し替えたら`audio:promo`も実行し直します。
台本本体は[src/promo/script.json](src/promo/script.json)、演出とアートディレクションは[docs/promo-script.md](docs/promo-script.md)、ナレーション生成の記録は[docs/promo-narration.md](docs/promo-narration.md)を参照してください。

### 素材と音源

ナレーションは、Higgsfield経由のtext2speech_v2（エンジンはElevenLabs、声はQuinn、女性）で生成したAI音声です。
声優や実在の人物の声ではなく、利用はHiggsfieldの利用規約に従います。
声の選定、読み上げテキスト、検証、再生成の手順は[docs/promo-narration.md](docs/promo-narration.md)にまとめています。

BGMと効果音は、この動画用にNumPyで合成したシンセ音源です。
市販の楽曲やサンプル音源は使用していません。
音源のコードは[scripts/generate-promo-audio.py](scripts/generate-promo-audio.py)（実装は`scripts/promo_audio/`）です。

音源を作り直す場合は、PythonのNumPyとFFmpegが必要です。

```sh
python3 -m pip install numpy
npm run audio:promo
```

この環境では`python3`がNumPy未インストールの別のPythonに解決されることがあります。
`python3 -m pip show numpy`などで確認し、NumPyが入ったpython3を使ってください。

### 16:9 と 9:16

16:9（`RepoKnowledgePromo`）と9:16（`RepoKnowledgePromoVertical`）は、同じtimeline.jsonと同じ音声を使います。
違うのはthreadの向きとレイアウトだけです。
16:9はthreadが画面下部を横に流れ、9:16は左端を縦に流れます。
9:16は上に240px、下に400pxの余白を確保し、SNSアプリのUI（プロフィール表示や操作ボタンなど）と重ならないようにしています。
レイアウトの定義は[src/promo/layout.ts](src/promo/layout.ts)にあります。

## 動画の構成

開発者が「何を解決するツールか」「どう使うか」「どこから始めるか」を順に理解できる構成です。
機能とコマンドは[プロジェクトのREADME](../README.md)とv0.4.1の実装に基づいています（ナレーション付き新作はv0.4.2時点のREADMEに基づいています。前節を参照）。
PR番号、レビューカード、ルール応答は説明用の例で、実画面の録画ではありません。

| 42秒版 | 元の60秒版 | 内容 |
| --- | --- | --- |
| 0–4.5秒 | 0–7秒 | そのレビューを、次の実装へ |
| 4.5–9秒 | 7–14秒 | 同じ指摘を繰り返す課題 |
| 9–15秒 | 14–23秒 | 取得 → 蒸留 → 人間の承認 → 活用 |
| 15–23秒 | 23–35秒 | `get_rules`で対象ファイルに合うルールを取得 |
| 23–29秒 | 35–43秒 | ローカル保存、外部送信の許可、人による承認 |
| 29–35秒 | 43–51秒 | Codex、Claude Code、Cursorで同じ知見を利用 |
| 35–42秒 | 51–60秒 | セットアップコマンドとGitHubへの案内 |

42秒版では登場アニメーションを1.5倍の速さにし、場面ごとに読む時間を設定しています。
同じ指摘を繰り返す場面のレビュー文も短くしています。
コード例は8秒、最後の案内は7秒で、読み取りに必要な時間を残しています。

## テロップとモーションの変更

[src/Intro.tsx](src/Intro.tsx)の各場面コンポーネントで、テロップ、色、配置を変更できます。
場面の順序はファイル末尾の`scenes`、表示時間は[src/editions.json](src/editions.json)で定義しています。
場面の重なりは42秒版で12フレーム、60秒版で18フレームです。
全体の尺は各場面のフレーム数の合計から計算します。
解像度は[src/Root.tsx](src/Root.tsx)、画質は[remotion.config.ts](remotion.config.ts)で変更します。
Remotion Studioでは、`RepoKnowledgeIntroQuick`と`RepoKnowledgeIntro`を切り替えて比較できます。

すべての動きは`useCurrentFrame`から計算するため、同じフレームを再現できます。
フォントは全字形を含むローカルファイルで、テロップの編集時も日本語を追加できます。

## 素材と音源

BGMは、この動画用にプログラムで作ったシンセ音源です。
市販の楽曲やサンプル音源は使用していません。
42秒版は`public/audio/review-loop-quick.m4a`、60秒版は`public/audio/review-loop.m4a`を使います。
音源を作り直す場合だけ、PythonのNumPyとFFmpegが必要です。

```sh
python3 -m pip install numpy
npm run audio
npm run audio:quick
```

音源のコードは[scripts/generate-audio.py](scripts/generate-audio.py)です。
テンポは42秒版が132 BPM、60秒版が120 BPMです。
シンセ、軽いパーカッション、場面転換の音を各版の尺に合わせて生成します。
画面と音源が同じ時間設定を参照するため、場面転換の音も連動します。

フォントはGoogle Fontsから取得し、ライセンスを同梱しています。

- [Noto Sans JP](https://github.com/google/fonts/tree/main/ofl/notosansjp): [SIL Open Font License](public/fonts/NotoSansJP-OFL.txt)
- [Space Grotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk): [SIL Open Font License](public/fonts/SpaceGrotesk-OFL.txt)

分岐線のマークと図形は、この動画用に作成したSVGです。
Codex、Claude Code、Cursorの表示には、製品名と汎用記号を使用しています。
