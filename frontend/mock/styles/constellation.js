export default function draw(ctx, env) {
  const { width: W, height: H, random } = env;
  const p = Object.assign({ bg: ["#020617", "#172554"], star: "#f8fafc", link: "#93c5fd", accent: "#fda4af", stars: 70, reach: 0.17, dust: 500 }, env.params);
  const S = Math.min(W, H);
  const g = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.8);
  g.addColorStop(0, p.bg[1]);
  g.addColorStop(1, p.bg[0]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = p.star;
  for (let i = 0; i < p.dust; i++) {
    ctx.globalAlpha = 0.15 + random() * 0.35;
    ctx.fillRect(random() * W, random() * H, S / 500, S / 500);
  }
  const pts = [];
  for (let i = 0; i < p.stars; i++) pts.push({ x: random() * W, y: random() * H, r: S * (0.002 + random() * 0.006), hot: random() < 0.12 });
  ctx.strokeStyle = p.link;
  ctx.lineWidth = S / 900;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) / S;
      if (d < p.reach) {
        ctx.globalAlpha = (1 - d / p.reach) * 0.6;
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
  }
  for (const s of pts) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.hot ? p.accent : p.star;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.hot ? s.r * 2 : s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
