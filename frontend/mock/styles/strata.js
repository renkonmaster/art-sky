export default function draw(ctx, env) {
  const { width: W, height: H, random } = env;
  const p = Object.assign({ palette: ["#fef9c3", "#fdba74", "#f87171", "#a21caf", "#312e81", "#0f172a"], bands: 22, wobble: 1, grain: 2500 }, env.params);
  ctx.fillStyle = p.palette[0];
  ctx.fillRect(0, 0, W, H);
  for (let b = 0; b < p.bands; b++) {
    const t = b / p.bands;
    const y0 = H * t;
    const amp = (H / p.bands) * (0.4 + random() * 1.2) * p.wobble;
    const f = 0.5 + random() * 2.5, o = random() * 10, f2 = 3 + random() * 5, o2 = random() * 10;
    ctx.fillStyle = p.palette[Math.min(p.palette.length - 1, Math.floor(t * p.palette.length + random() * 0.9))];
    ctx.globalAlpha = 0.75 + random() * 0.25;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += W / 200) {
      const u = (x / W) * Math.PI * 2;
      ctx.lineTo(x, y0 + amp * (Math.sin(u * f + o) * 0.7 + Math.sin(u * f2 + o2) * 0.3));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = "#000";
  const s = Math.min(W, H) / 600;
  for (let i = 0; i < p.grain; i++) {
    ctx.globalAlpha = random() * 0.12;
    ctx.fillRect(random() * W, random() * H, s, s);
  }
  ctx.globalAlpha = 1;
}
