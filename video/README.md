# repo-knowledge-mcp 紹介動画

PRレビューの知見を次の実装で再利用する流れを紹介するRemotion動画です。
テンポを調整した42秒版と、GitHubで公開済みの60秒版を収録しています。
1920 × 1080、30 fps、日本語テロップとオリジナルBGMで構成しています。
ナレーションはありません。

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

## 動画の構成

開発者が「何を解決するツールか」「どう使うか」「どこから始めるか」を順に理解できる構成です。
機能とコマンドは[プロジェクトのREADME](../README.md)とv0.4.1の実装に基づいています。
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
