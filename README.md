# 画像報告アプリ（PWA）

報告内容を選び、写真を添えて Google Chat に送信するアプリです。PWA対応なので、スマホのホーム画面に追加してアプリのように使えます。

## 構成

```
image-report/
├── app.js              # アプリ本体（Node.js のみで動作、依存ライブラリ不要）
├── package.json
├── public/
│   ├── manifest.json   # PWA定義（アイコン・テーマ色）
│   ├── sw.js           # Service Worker（画面キャッシュ・オフライン表示）
│   └── icons/          # アプリアイコン（192px / 512px）
└── README.md
```

## 起動方法

1. このリポジトリをクローン

   ```
   git clone https://github.com/<ユーザー名>/image-report.git
   cd image-report
   ```

2. Node.js（v18以上）が入ったPCで起動

   ```
   node app.js        # または: npm start
   ```

3. ブラウザで **http://localhost:3000** を開く
4. スマホから使う場合（PWAとしてホーム画面に追加）は **HTTPS が必要**です:
   - 同じWi-Fi運用なら: `npx localtunnel --port 3000` などでHTTPS化するか、Cloudflare Tunnel / Render / Railway などにデプロイ（`node app.js` だけで動くのでそのまま載せられます）
   - PCのブラウザ（localhost）なら追加設定なしでインストール可能

## PWAとしての使い方

1. スマホのブラウザ（Chrome / Safari）でアプリを開く
2. 「ホーム画面に追加」/「インストール」を選ぶ
3. 以後はホーム画面のアイコンから全画面で起動できます（画面はキャッシュされ、オフラインでも起動します。報告の送信はオンライン時のみ）

## 使い方

1. 「報告内容」のプルダウンから選択（看板報告 / ソフトクリーム報告 / グリスト報告 / ビール報告）
   → 送信先チャンネルが自動で切り替わります
2. 画像を選択（スマホならカメラ撮影も可）
3. 一言コメント（任意）を入力
4. 「📤 報告する」ボタンを押す → 選択した報告先の Google Chat にカード形式で投稿されます

## 仕組み・注意点

- Google Chat の Webhook は画像ファイル本体を直接受信できないため、
  **画像を外部の画像ホストにアップロードし、そのURLを Chat のカードに載せて送信**します。
- アップロード先は以下の順で自動試行されます（最初に成功したものを使用）:

  | ホスト | 保持期間 |
  |---|---|
  | catbox.moe | 無期限 |
  | litterbox | 72時間 |
  | uguu.se | 24〜48時間 |
  | tmpfiles.org | 60分 |

  ※ 画像は**URLを知っていれば誰でも見られる公開状態**になります。社外秘の画像は送らないでください。
- Webhook URL を変更する場合は `app.js` 上部の `REPORT_TYPES` を編集してください。
  ※ Webhook URL は秘密情報（トークン付き）です。**リポジトリを公開する場合は必ずプライベートリポジトリにするか、URLを環境変数化してください。**

## GitHubで管理する

コミット済みのリポジトリをそのまま push するだけです:

```bash
# GitHubで空のリポジトリ image-report を作成してから:
git remote add origin https://github.com/<ユーザー名>/image-report.git
git push -u origin main

# GitHub CLI でログイン済みなら、リポジトリ作成もまとめて:
# gh auth login
# gh repo create image-report --private --source=. --push
```
