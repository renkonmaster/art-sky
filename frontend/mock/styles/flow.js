export default function draw(ctx, env) {
  const { width: W, height: H, random } = env;
  const p = Object.assign(
    { bg: "#0b1020", palette: ["#7dd3fc", "#a78bfa", "#f0abfc", "#fde68a"], lines: 900, steps: 60, scale: 2.2, swirl: 1, weight: 1 },
    env.params,
  );
  const S = Math.min(W, H);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  const a = random() * 10, b = random() * 10, c = random() * 10;
  const angle = (x, y) => {
    const nx = (x / S) * p.scale, ny = (y / S) * p.scale;
    return (Math.sin(nx * 1.7 + a) + Math.cos(ny * 1.3 + b) + Math.sin((nx + ny) * 0.9 + c)) * Math.PI * p.swirl;
  };
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < p.lines; i++) {
    let x = random() * W, y = random() * H;
    ctx.strokeStyle = p.palette[Math.floor(random() * p.palette.length)];
    ctx.lineWidth = ((0.4 + random() * 1.4) * p.weight * S) / 700;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < p.steps; s++) {
      const t = angle(x, y);
      x += Math.cos(t) * S * 0.006;
      y += Math.sin(t) * S * 0.006;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
