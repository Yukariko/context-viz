import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const outDir = path.resolve("external/context-viz/assets");
const pngPath = path.join(outDir, "context-viz-preview.png");
const webmPath = path.join(outDir, "context-viz-preview.webm");
const mp4Path = path.join(outDir, "context-viz-preview.mp4");
const htmlPath = path.join(outDir, "context-viz-preview.html");

const snapshot = {
  model: "openai-codex/gpt-5.4",
  usage: "24,122 tok / 400,000",
  systemChars: 7812,
  turns: [
    {
      index: 0,
      userText: "Read the trace renderer and explain how flow edges are grouped before drawing.",
      answerSummary: "A:1 · tools:3 (read×2, bash×1)",
      files: ["src/lib/trace.ts", "src/lib/render.ts"],
    },
    {
      index: 1,
      userText: "Now open context-viz and prune everything unrelated to the renderer bug.",
      answerSummary: "A:1 · tools:2 (read×1, edit×1)",
      files: ["extensions/context-viz.ts"],
    },
    {
      index: 2,
      userText: "Keep only the turns needed to debug the Next footer regression.",
      answerSummary: "A:1 · tools:4 (read×2, bash×1, edit×1)",
      files: ["src/app/page.tsx", ".pi/extensions/gpt-usage-status.ts"],
    },
  ],
  files: [
    "src/lib/trace.ts",
    "src/lib/render.ts",
    "extensions/context-viz.ts",
    "src/app/page.tsx",
    ".pi/extensions/gpt-usage-status.ts",
  ],
  commands: [
    'rg -n "context" src .pi --hidden',
    "pi /context-viz",
    "git diff --stat",
  ],
};

function estimateTokens(chars) {
  return Math.max(1, Math.ceil(chars / 4));
}

function compactText(text, max) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

function buildRows(selectedTurns) {
  const rows = [];
  rows.push({ kind: "meta", label: "SYSTEM", value: `${estimateTokens(snapshot.systemChars)} tok` });
  rows.push({ kind: "spacer" });
  rows.push({ kind: "meta", label: "TURNS", value: `${snapshot.turns.length}` });
  for (const turn of snapshot.turns) {
    rows.push({
      kind: "turn",
      checked: selectedTurns.has(turn.index),
      title: compactText(turn.userText, 80),
      summary: turn.answerSummary,
    });
  }
  rows.push({ kind: "spacer" });
  rows.push({ kind: "meta", label: "FILES", value: `${snapshot.files.length}` });
  for (const file of snapshot.files) {
    const checked = snapshot.turns.some((turn) => selectedTurns.has(turn.index) && turn.files.includes(file));
    rows.push({ kind: "file", checked, title: file });
  }
  rows.push({ kind: "spacer" });
  rows.push({ kind: "meta", label: "RECENT BASH", value: "" });
  for (const command of snapshot.commands) {
    rows.push({ kind: "command", title: `$ ${command}` });
  }
  return rows;
}

function pageHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
:root {
  --bg: #0b1020;
  --panel: rgba(15, 23, 42, 0.96);
  --panel2: rgba(2, 6, 23, 0.92);
  --text: #e2e8f0;
  --muted: #94a3b8;
  --dim: #64748b;
  --accent: #7dd3fc;
  --success: #86efac;
  --warning: #fde68a;
  --border: rgba(148,163,184,.22);
  --selected: rgba(56, 189, 248, .16);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(circle at top left, #111827, var(--bg) 55%);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--text);
}
.wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}
.terminal {
  width: 1440px;
  height: 900px;
  border-radius: 22px;
  overflow: hidden;
  background: rgba(2,6,23,.98);
  border: 1px solid rgba(148,163,184,.16);
  box-shadow: 0 30px 90px rgba(0,0,0,.5);
  position: relative;
}
.topbar {
  height: 44px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
}
.dot { width: 11px; height: 11px; border-radius: 50%; }
.red { background: #f87171; } .yellow { background: #fbbf24; } .green { background: #34d399; }
.shell {
  display: flex;
  height: calc(100% - 44px);
}
.main {
  flex: 1;
  padding: 24px 28px 56px;
  position: relative;
}
.line { white-space: pre; font-size: 17px; line-height: 1.7; color: var(--text); }
.dim { color: var(--dim); } .accent { color: var(--accent); } .success { color: var(--success); } .warning { color: var(--warning); }
.overlay {
  width: 46%;
  min-width: 560px;
  max-width: 640px;
  margin: 14px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(15,23,42,.96), rgba(2,6,23,.98));
  box-shadow: -8px 0 28px rgba(0,0,0,.25);
  overflow: hidden;
}
.ov-head, .ov-foot { padding: 14px 18px; border-bottom: 1px solid var(--border); }
.ov-foot { border-top: 1px solid var(--border); border-bottom: 0; color: var(--muted); font-size: 14px; }
.ov-title { font-family: Inter, system-ui, sans-serif; font-weight: 800; color: var(--accent); font-size: 22px; }
.ov-sub { margin-top: 8px; color: var(--muted); font-size: 14px; }
.meta { padding: 12px 18px; border-bottom: 1px solid rgba(148,163,184,.1); }
.meta .row { display: flex; justify-content: space-between; margin: 6px 0; color: var(--muted); font-size: 14px; }
.rows { padding: 10px 10px 12px; }
.item { padding: 10px 12px; border-radius: 12px; margin-bottom: 6px; }
.item.turn.active { background: var(--selected); outline: 1px solid rgba(56,189,248,.22); }
.item.turn .t { color: var(--text); font-size: 14px; }
.item .s { color: var(--muted); font-size: 13px; margin-top: 5px; }
.item.meta2 { color: var(--accent); font-weight: 700; font-size: 13px; letter-spacing: .04em; }
.item.file, .item.command { color: var(--muted); font-size: 13px; }
.check { color: var(--success); margin-right: 8px; }
.footer {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 14px;
  white-space: pre;
}
</style>
</head>
<body>
<div class="wrap">
  <div class="terminal">
    <div class="topbar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div>
    <div class="shell">
      <div class="main">
        <div class="line dim">/Users/igangmin/study/llm-game</div>
        <div class="line"><span class="accent">/context-viz</span></div>
        <div class="line">Show current LLM context as a right-side overlay</div>
        <div class="line"> </div>
        <div class="line"><span class="success">✓</span> Overlay opened</div>
        <div class="line"> </div>
        <div class="line dim">Use Space to toggle turns/files, then press p to prune.</div>
        <div class="line"> </div>
        <div class="line"><span class="warning">Files touched</span>: src/lib/trace.ts, src/lib/render.ts, extensions/context-viz.ts</div>
        <div class="line"><span class="warning">Recent bash</span>: rg -n "context" src .pi --hidden</div>
        <div class="footer">↑12.4k ↓2.1k R8.9k $0.000 24.1%/400k                    gpt-5.4 ⏱ 5h 16%·4h56m  📅 1w 11%·6d16h</div>
      </div>
      <div class="overlay">
        <div class="ov-head">
          <div class="ov-title">Context Visualizer</div>
          <div class="ov-sub">Current LLM context grouped by user turn</div>
        </div>
        <div class="meta">
          <div class="row"><span>Model</span><span>${snapshot.model}</span></div>
          <div class="row"><span>Usage</span><span>${snapshot.usage}</span></div>
          <div class="row"><span>System prompt</span><span>${snapshot.systemChars.toLocaleString()} chars</span></div>
        </div>
        <div class="rows" id="rows"></div>
        <div class="ov-foot">Space toggle • p prune • q close • 3/3 turns</div>
      </div>
    </div>
  </div>
</div>
<script>
const frames = [
  ${JSON.stringify(buildRows(new Set([0,1,2])))},
  ${JSON.stringify(buildRows(new Set([0,2])))},
  ${JSON.stringify(buildRows(new Set([2])))},
  ${JSON.stringify(buildRows(new Set([0,1,2])))}
];
let idx = 0;
function render() {
  const rows = document.getElementById('rows');
  const frame = frames[idx % frames.length];
  rows.innerHTML = frame.map((row, i) => {
    if (row.kind === 'spacer') return '<div class="item"></div>';
    if (row.kind === 'meta') return '<div class="item meta2">' + row.label + (row.value ? ' ' + row.value : '') + '</div>';
    if (row.kind === 'turn') return '<div class="item turn ' + (i===3 ? 'active' : '') + '"><div class="t"><span class="check">' + (row.checked ? '☑' : '☐') + '</span>Q ' + row.title + '</div><div class="s">A ' + row.summary + '</div></div>';
    if (row.kind === 'file') return '<div class="item file"><span class="check">' + (row.checked ? '☑' : '☐') + '</span>' + row.title + '</div>';
    if (row.kind === 'command') return '<div class="item command">' + row.title + '</div>';
    return '';
  }).join('');
  idx++;
}
render();
setInterval(render, 900);
</script>
</body>
</html>`;
}

await fs.mkdir(outDir, { recursive: true });
const html = pageHtml();
await fs.writeFile(htmlPath, html, 'utf8');

const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto(`file://${htmlPath}`);
await page.screenshot({ path: pngPath, type: 'png' });

const stream = await page.evaluateHandle(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const ctx = canvas.getContext('2d');
  const html = document.documentElement;
  document.body.appendChild(canvas);
  canvas.style.display = 'none';
  let recorder;
  let chunks = [];
  return new Promise(async (resolve) => {
    const stream = canvas.captureStream(12);
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      resolve(Array.from(buf));
    };
    recorder.start();
    const target = document.querySelector('.wrap');
    let frame = 0;
    const draw = async () => {
      const rows = document.getElementById('rows');
      const list = Array.from(document.querySelectorAll('.item.turn'));
      list.forEach((el) => el.classList.remove('active'));
      if (list[frame % Math.max(1, list.length)]) list[frame % list.length].classList.add('active');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(target)}</foreignObject></svg>`;
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img, 0, 0);
        frame++;
        if (frame < 24) setTimeout(draw, 120);
        else recorder.stop();
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    };
    draw();
  });
});
const bytes = await stream.jsonValue();
await fs.writeFile(webmPath, Buffer.from(bytes));
await browser.close();
console.log(JSON.stringify({ pngPath, webmPath, mp4Path }));
