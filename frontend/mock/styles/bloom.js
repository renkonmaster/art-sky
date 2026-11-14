export default function draw(ctx, env) {
  const { width: W, height: H, random } = env;
  const p = Object.assign({ bg: "#1c1917", palette: ["#fb7185", "#fdba74", "#fde047", "#f0abfc"], flowers: 7, petals: 12, spread: 1 }, env.params);
  const S = Math.min(W, H);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  for (let f = 0; f < p.flowers; f++) {
    const cx = W * (0.1 + random() * 0.8), cy = H * (0.1 + random() * 0.8);
    const R = S * (0.08 + random() * 0.2) * p.spread;
    const n = p.petals + Math.floor(random() * 6);
    const rot = random() * Math.PI * 2;
    for (let layer = 3; layer >= 1; layer--) {
      ctx.fillStyle = p.palette[(f + layer) % p.palette.length];
      ctx.globalAlpha = 0.22 + 0.12 * layer;
      const r = (R * layer) / 3;
      for (let k = 0; k < n; k++) {
        const a = rot + (k / n) * Math.PI * 2 + layer * 0.2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.ellipse(r * 0.55, 0, r * 0.5, r * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.bg;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }
}
