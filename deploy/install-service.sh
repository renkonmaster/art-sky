#!/usr/bin/env bash
# art-sky を systemd のユーザーサービスとして登録する。
# 落ちたら自動で再起動し、PC（WSL）の起動時にも自動で立ち上がるようになる。
#
#   pnpm build                      先に画面をビルドしておく
#   deploy/install-service.sh       サーバー（art-sky.service）を登録し、自動起動を有効にする
#   deploy/install-service.sh --tunnel <ngrok のドメイン>
#                                   ngrok のトンネル（art-sky-tunnel.service）も登録する
#
# 公開用の設定（PUBLIC_URL、COOKIE_SECRET）は backend/.env.production に書いておく。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
units="$HOME/.config/systemd/user"
# PATH の node がランチャーの場合に備えて、実際に動く実行ファイルを調べる。
node="$(node -e 'console.log(process.execPath)')"
mkdir -p "$units"

cat > "$units/art-sky.service" <<UNIT
[Unit]
Description=art-sky（API、生成ワーカー、投稿の監視、画面の配信）
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$root/backend
Environment=NODE_ENV=production
ExecStart=$node --env-file-if-exists=.env --env-file-if-exists=.env.production src/server.ts
# 落ちたら 3 秒後に再起動する。止めるときは処理中のジョブが PDS への保存を終えるのを待つ。
Restart=always
RestartSec=3
TimeoutStopSec=120
StandardOutput=append:$root/backend/data/server.log
StandardError=append:$root/backend/data/server.log

[Install]
WantedBy=default.target
UNIT

if [[ "${1:-}" == "--tunnel" ]]; then
  domain="${2:?ngrok のドメインを指定してください（例: example.ngrok-free.dev）}"
  cat > "$units/art-sky-tunnel.service" <<UNIT
[Unit]
Description=art-sky の ngrok トンネル（https://$domain → 3000）
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v ngrok) http 3000 --url=$domain --log stdout --log-format logfmt
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  echo "登録: art-sky-tunnel.service（https://$domain）"
fi

mkdir -p "$root/backend/data"
systemctl --user daemon-reload
systemctl --user enable art-sky.service
if [[ "${1:-}" == "--tunnel" ]]; then
  systemctl --user enable art-sky-tunnel.service
  echo "トンネルの起動: systemctl --user restart art-sky-tunnel"
fi
# ログインしていなくても（WSL の起動直後から）動くようにする。
loginctl enable-linger "$USER" 2>/dev/null || echo "（loginctl enable-linger に失敗しました。ログイン中だけ動きます）"
echo "登録: art-sky.service"
echo "起動: systemctl --user restart art-sky"
echo "状態: systemctl --user status art-sky"
echo "ログ: tail -f $root/backend/data/server.log"
