let drops = null;
export default function draw(ctx, env) {
  const { width: W, height: H, random, time } = env;
  const p = Object.assign({ top: "#0c1a2e", bottom: "#1e293b", lights: ["#fbbf24", "#f472b6", "#60a5fa"], count: 140, speed: 1, glow: 9 }, env.params);
  const S = Math.min(W, H);
  if (!drops) {
    drops = { rain: [], lamps: [] };
    for (let i = 0; i < p.count; i++) drops.rain.push({ x: random(), y: random(), len: 0.03 + random() * 0.07, v: 0.5 + random() * 0.9 });
    for (let i = 0; i < p.glow; i++) drops.lamps.push({ x: random(), r: 0.03 + random() * 0.06, c: p.lights[Math.floor(random() * p.lights.length)], ph: random() * 6 });
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, p.top);
  g.addColorStop(1, p.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const horizon = H * 0.62;
  for (const l of drops.lamps) {
    const x = l.x * W, r = l.r * S, flick = 0.75 + 0.25 * Math.sin(time * 1.3 + l.ph);
    const halo = ctx.createRadialGradient(x, horizon, 0, x, horizon, r * 3);
    halo.addColorStop(0, l.c);
    halo.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.55 * flick;
    ctx.fillStyle = halo;
    ctx.fillRect(x - r * 3, horizon - r * 3, r * 6, r * 6);
    ctx.globalAlpha = 0.28 * flick;
    ctx.fillStyle = l.c;
    for (let k = 0; k < 14; k++) {
      const yy = horizon + (k / 14) * (H - horizon);
      const w = r * (0.5 + 0.5 * Math.sin(time * 2 + k * 1.1 + l.ph)) * (1 + k * 0.12);
      ctx.fillRect(x - w / 2, yy, w, (H - horizon) / 28);
    }
  }
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = S / 600;
  ctx.beginPath();
  for (const d of drops.rain) {
    const y = ((d.y + time * d.v * p.speed) % 1.1) * H;
    const x = d.x * W;
    ctx.moveTo(x, y);
    ctx.lineTo(x - d.len * H * 0.15, y + d.len * H);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}
