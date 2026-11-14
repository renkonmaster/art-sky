let rings = null;
export default function draw(ctx, env) {
  const { width: W, height: H, random, time } = env;
  const p = Object.assign(
    { bg: "#020617", ring: "#334155", palette: ["#f472b6", "#38bdf8", "#facc15", "#a3e635"], count: 9, speed: 1, tilt: 0.55 },
    env.params,
  );
  const S = Math.min(W, H);
  if (!rings) {
    rings = [];
    for (let i = 0; i < p.count; i++) {
      rings.push({
        r: S * (0.08 + (0.4 * (i + 1)) / p.count),
        phase: random() * Math.PI * 2,
        speed: (0.15 + random() * 0.5) * (random() < 0.5 ? -1 : 1),
        size: S * (0.008 + random() * 0.018),
        color: p.palette[Math.floor(random() * p.palette.length)],
        moons: 1 + Math.floor(random() * 3),
      });
    }
  }
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.fillStyle = "#fef3c7";
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.035, 0, Math.PI * 2);
  ctx.fill();
  for (const ring of rings) {
    ctx.strokeStyle = p.ring;
    ctx.lineWidth = S / 700;
    ctx.beginPath();
    ctx.ellipse(0, 0, ring.r, ring.r * p.tilt, 0, 0, Math.PI * 2);
    ctx.stroke();
    for (let m = 0; m < ring.moons; m++) {
      const a = ring.phase + time * ring.speed * p.speed + (m * Math.PI * 2) / ring.moons;
      const x = Math.cos(a) * ring.r, y = Math.sin(a) * ring.r * p.tilt;
      ctx.fillStyle = ring.color;
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(a);
      ctx.beginPath();
      ctx.arc(x, y, ring.size * (1 + 0.3 * Math.sin(a)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
