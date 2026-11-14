export default function draw(ctx, env) {
  const { width: W, height: H, random } = env;
  const p = Object.assign({ bg: "#fef3c7", palette: ["#b45309", "#0f766e", "#1e3a8a"], cells: 10, weight: 0.22, fillRate: 0.15 }, env.params);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  const size = Math.max(W, H) / p.cells;
  const cols = Math.ceil(W / size), rows = Math.ceil(H / size);
  ctx.lineCap = "round";
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * size, y = j * size;
      const color = p.palette[Math.floor(random() * p.palette.length)];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = size * p.weight;
      const flip = random() < 0.5;
      if (random() < p.fillRate) {
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(x + size / 2, y + size / 2, size * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      if (flip) {
        ctx.arc(x, y, size / 2, 0, Math.PI / 2);
        ctx.moveTo(x + size / 2, y + size);
        ctx.arc(x + size, y + size, size / 2, Math.PI, Math.PI * 1.5);
      } else {
        ctx.arc(x + size, y, size / 2, Math.PI / 2, Math.PI);
        ctx.moveTo(x, y + size / 2);
        ctx.arc(x, y + size, size / 2, Math.PI * 1.5, Math.PI * 2);
      }
      ctx.stroke();
    }
  }
}
