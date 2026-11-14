export default function draw(ctx, env) {
  const { width: W, height: H, random } = env;
  const p = Object.assign(
    { sky: ["#1e1b4b", "#f97316"], sun: "#fde68a", near: "#0f172a", far: "#c4b5fd", layers: 6, rough: 1, sunY: 0.42 },
    env.params,
  );
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(1, p.sky[1]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const S = Math.min(W, H);
  ctx.fillStyle = p.sun;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(W * (0.3 + random() * 0.4), H * p.sunY, S * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  const mix = (c1, c2, t) => {
    const h = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const [a, b] = [h(c1), h(c2)];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
  };
  for (let l = 0; l < p.layers; l++) {
    const t = l / Math.max(1, p.layers - 1);
    const base = H * (0.45 + t * 0.45);
    const amp = H * (0.16 - t * 0.07) * p.rough;
    const f1 = 1 + random() * 2, f2 = 3 + random() * 4, f3 = 9 + random() * 8;
    const o1 = random() * 9, o2 = random() * 9, o3 = random() * 9;
    ctx.fillStyle = mix(p.far, p.near, t);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += W / 240) {
      const u = (x / W) * Math.PI * 2;
      const y = base - amp * (0.6 * Math.sin(u * f1 + o1) + 0.3 * Math.sin(u * f2 + o2) + 0.1 * Math.sin(u * f3 + o3));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
}
