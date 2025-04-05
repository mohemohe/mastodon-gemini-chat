# Mastodon Gemini Chat Bot

MastodonでGemini 2.0 Flashのチャット機能を利用できるボットです。メンションを送ると、Gemini AIが自然な会話で応答します。連続した会話も可能です。

※ 人間注: このbotはCursorとClaude 3.7 Sonnetによって全てのコードが生成されています。

## 機能

- megalodonライブラリを使用したMastodon APIクライアント
- Gemini 2.0 Flash APIを使用した応答生成
- 会話コンテキストの維持（連続した会話が可能）
- 特定の形式のメンションをスキップする機能（`@username !` で始まるメンション）
- 元の投稿の公開範囲（visibility）を引き継いだ返信

## セットアップ

### 前提条件

- Node.js (v14以上、v18以上推奨)
- Mastodonアカウントとアクセストークン
- Google AI (Gemini) APIキー

### インストール

1. リポジトリをクローン
```
git clone https://github.com/yourusername/mastodon-gemini-chat.git
cd mastodon-gemini-chat
```

2. 必要なパッケージをインストール
```
npm install
```

3. 環境変数の設定
`.env.example` ファイルを `.env` としてコピーし、必要な情報を入力します。
```
cp .env.example .env
```

以下の環境変数を設定してください:
- `MASTODON_SERVER`: MastodonインスタンスのURL (例: https://mastodon.social)
- `MASTODON_ACCESS_TOKEN`: Mastodonのアクセストークン
- `GEMINI_API_KEY`: Gemini APIキー
- `GEMINI_MODEL`: 使用するGeminiモデル (デフォルト: gemini-2.0-flash)
- `MAX_CONTEXT_LENGTH`: 保持する会話履歴の最大長さ (デフォルト: 10)

### 依存関係について

このプロジェクトは以下の主要な依存関係を使用しています:
- `@google/generative-ai`: Gemini APIとの通信
- `megalodon`: MastodonやMisskeyなど複数のプラットフォームに対応した統一クライアント
- `dotenv`: 環境変数の管理
- `node-fetch`: Node.js v18未満で使用されるfetch API互換ライブラリ

### Mastodonアクセストークンの取得方法

1. Mastodonインスタンスにログイン
2. 設定 > 開発 > 新規アプリから新しいアプリケーションを作成
3. 以下の権限を設定:
   - `read:statuses`
   - `write:statuses`
   - `read:notifications`
4. 生成されたアクセストークンをコピー

## 使い方

ボットを起動するには:

```
npm start
```

開発モード（ファイル変更時に自動再起動）で実行するには:

```
npm run dev
```

### ボットとの会話方法

1. ボットのアカウントにメンションを送信
   例: `@botname こんにちは！`

2. ボットがGemini AIを使用して応答

3. 続けて返信することで会話を継続できます

### 会話をスキップする方法

メンションの直後に `!` を付けると、ボットは応答しません。
例: `@botname !これはスキップされます`

## Geminiモデルの変更

デフォルトでは `gemini-2.0-flash` モデルが使用されますが、`.env` ファイルの `GEMINI_MODEL` を設定することで他のモデルを使用できます。

使用可能なモデル例:
- `gemini-2.0-flash` (デフォルト - 高速)
- `gemini-1.5-flash` (高速)
- `gemini-1.5-pro` (高品質)
- `gemini-1.0-pro` (古いバージョン)

## Dockerでの実行

DockerとDocker Composeを使用してボットを実行することもできます。

### Dockerを使用した実行方法

1. `.env` ファイルを設定
```
cp .env.example .env
```
必要な環境変数を編集してください。

2. Docker Composeでビルドと実行
```
docker-compose up -d
```

3. ログの確認
```
docker-compose logs -f
```

4. ボットの停止
```
docker-compose down
```

### Dockerボリュームについて

`docker-compose.yml` では以下のボリュームがマウントされます:
- `./src:/app/src`: ソースコードディレクトリ
- `./index.js:/app/index.js`: メインファイル
- `./.env:/app/.env`: 環境変数ファイル

これによりコードを変更しても再ビルドせずに反映されます。

## 技術的な詳細

このボットは以下の技術を使用しています：

- **megalodon** - Mastodon・Misskey・Pleroma・Frendica向けの統一クライアントライブラリ。ストリーミングAPIを使用して通知をリアルタイムに処理します。
- **Gemini 2.0 Flash** - Google AIのLLMモデル。会話コンテキストを維持しながら自然な応答を生成します。

## トラブルシューティング

- ボットが応答しない場合は、環境変数が正しく設定されているか確認してください
- ストリーミングAPI接続エラーが発生する場合は、MastodonサーバーのURLとアクセストークンを確認してください
- Gemini APIエラーが発生する場合は、APIキーが有効か確認してください
- Node.js v18未満を使用している場合、`node-fetch`パッケージが正しくインストールされているか確認してください
