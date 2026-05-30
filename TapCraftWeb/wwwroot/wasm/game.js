export async function start(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return;
  }

  const width = window.innerWidth;
  const height = window.innerHeight;

  context.fillStyle = "#07111f";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#9ec4ff";
  context.font = "600 20px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.fillText("WASM entry module loaded", width / 2, height / 2 - 8);
  context.fillStyle = "#88a8d8";
  context.font = "400 14px Segoe UI, sans-serif";
  context.fillText("Replace wwwroot/wasm/game.js with your engine bootstrap.", width / 2, height / 2 + 22);
}
