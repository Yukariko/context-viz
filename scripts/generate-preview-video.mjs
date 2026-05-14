import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const htmlPath = path.resolve("external/context-viz/assets/context-viz-preview.html");
const mp4Path = path.resolve("external/context-viz/assets/context-viz-preview.mp4");

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await page.goto(`file://${htmlPath}`);

const bytes = await page.evaluate(async () => {
  const { Muxer, ArrayBufferTarget } = await import('https://esm.sh/mp4-muxer');
  const width = 1280;
  const height = 800;
  const fps = 12;
  const frames = 24;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; },
  });

  encoder.configure({ codec: 'avc1.640028', width, height, bitrate: 4_000_000, framerate: fps });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const wrap = document.querySelector('.wrap');
  const turnSelector = '.item.turn';

  for (let frame = 0; frame < frames; frame++) {
    const turns = Array.from(document.querySelectorAll(turnSelector));
    turns.forEach((el) => el.classList.remove('active'));
    if (turns.length) turns[frame % turns.length].classList.add('active');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrap)}</foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);

    const videoFrame = new VideoFrame(canvas, { timestamp: Math.round((frame / fps) * 1_000_000) });
    encoder.encode(videoFrame, { keyFrame: frame % fps === 0 });
    videoFrame.close();
  }

  await encoder.flush();
  muxer.finalize();
  return Array.from(new Uint8Array(target.buffer));
});

await fs.writeFile(mp4Path, Buffer.from(bytes));
await browser.close();
console.log(mp4Path);
