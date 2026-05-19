# webrtc-video-chat-workers

Cloudflare Workers + Durable Objects で構築する 2人用ビデオチャットの開発リポジトリです。

## Session 1（最小アプリ）
- 開始ページでルーム作成
- 参加URL発行
- 参加ページで名前（任意） + パスワード入力して参加
- 参加URLコピー
- 退室とハートビートによるルーム寿命管理（全員退室後60秒で削除）

## 開発
```bash
npm install
npm run dev
```

## デプロイ
```bash
npm run deploy
```
