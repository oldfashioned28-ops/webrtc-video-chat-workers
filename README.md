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

## 開発
```bash
npm install
npm run dev
```

## デプロイ
```bash
npm run deploy
```


## セッション進捗
- Session 1: Cloudflare 最小構成確認 ✅
- Session 2: ビデオチャット機能追加 ✅
- Session 3: セキュリティレビュー（初回）✅ `SECURITY_REVIEW.md`
- Session 4: エッジケースレビュー（初版）✅ `EDGE_REVIEW.md`
