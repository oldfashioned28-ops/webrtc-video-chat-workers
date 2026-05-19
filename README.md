# webrtc-video-chat-workers


Cloudflare Workers + Durable Objects で動く 2人用ビデオチャットです。

## 実装済み
- ルーム作成 + 参加URL発行
- パスワード付き参加（2人上限）
- 退室 + heartbeat + 60秒TTL削除
- WebSocketシグナリング + WebRTC P2P
- ミュートON/OFF
- カメラON/OFF
- カメラ切り替え（順次）
- ミラーON/OFF
- 正方形トリミング表示（`object-fit: cover`）
=======
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
