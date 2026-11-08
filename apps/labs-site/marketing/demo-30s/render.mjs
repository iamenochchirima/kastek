import { chromium } from "/home/enoch/aworkspace/kasitek-labs/kastek/products/agents/web/node_modules/@playwright/test/index.mjs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const framesDir = join(root, "frames");
const build = join(root, ".build");
const out = join(root, "out");
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const BEATS = [
  { id: "hook", start: 0, end: 90 },
  { id: "agents", start: 90, end: 270 },
  { id: "growth", start: 270, end: 450 },
  { id: "agency", start: 450, end: 630 },
  { id: "proof", start: 630, end: 810 },
  { id: "end", start: 810, end: 900 },
];
const FADE = 10;

async function dataUrl(path, mime) {
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

const image = async (name) => dataUrl(join(framesDir, name), "image/png");
const font = await dataUrl(join(root, "geist.woff2"), "font/woff2");
const [agents, growth, agency] = await Promise.all([image("agents-window.png"), image("growth-window.png"), image("agency-window.png")]);

const mark = `<svg viewBox="41 47 364 364" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs><linearGradient id="rise" x1="0%" y1="100%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0E1C2F"/><stop offset="100%" stop-color="#2A5080"/></linearGradient></defs>
<rect x="161" y="167" width="234" height="234" rx="14" fill="#7E93AF" opacity="0.18"/>
<rect x="106" y="112" width="234" height="234" rx="14" fill="#A9B8CC" opacity="0.3"/>
<rect x="51" y="57" width="234" height="234" rx="14" fill="url(#rise)"/>
<rect x="51" y="57" width="46" height="46" rx="8" fill="#C9A84C"/>
</svg>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(${font}) format("woff2");font-weight:100 900;font-display:block}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#070B12}
body{font-family:Geist,system-ui,sans-serif;color:#F7F5ED;-webkit-font-smoothing:antialiased}
#stage{position:absolute;inset:0;overflow:hidden;background:
 radial-gradient(120% 90% at 78% 8%, #16304F 0%, #0B1522 42%, #070B12 78%)}
#grain{position:absolute;inset:0;opacity:.05;pointer-events:none;background-image:radial-gradient(#fff .6px, transparent .7px);background-size:3px 3px}
.beat{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;will-change:opacity,transform}
.shot{position:relative;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.16);
 box-shadow:0 60px 120px -40px rgba(0,0,0,.85), 0 18px 40px -24px rgba(0,0,0,.7);will-change:transform}
.shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
.caption{position:absolute;left:96px;bottom:70px;max-width:1300px;z-index:3}
.scrim-b{position:absolute;left:0;right:0;bottom:0;height:320px;z-index:2;background:linear-gradient(180deg,rgba(7,11,18,0) 0%,rgba(7,11,18,.82) 55%,#070B12 100%);pointer-events:none}
.rule{width:64px;height:3px;background:#C9A84C;margin-bottom:22px;transform-origin:left}
.caption h2{font-size:52px;line-height:1.12;font-weight:500;letter-spacing:-.02em}
.caption p{font-size:20px;color:#9FB0C6;margin-top:14px;letter-spacing:-.005em}
/* hook */
#beat-hook .cut{position:absolute;inset:0;opacity:0}
#beat-hook .cut img{width:100%;height:100%;object-fit:cover}
#beat-hook .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(7,11,18,.15) 0%,rgba(7,11,18,.55) 62%,rgba(7,11,18,.92) 100%)}
/* proof */
#beat-proof{flex-direction:column;padding-bottom:120px}
#beat-proof .stack{display:flex;align-items:center;justify-content:center;gap:34px;width:1500px;height:560px}
#beat-proof .card{border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,.18);box-shadow:0 40px 90px -34px rgba(0,0,0,.85)}
#beat-proof .card img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}
#beat-proof .col{display:flex;flex-direction:column;align-items:center;gap:18px}
#beat-proof figcaption{font-size:19px;letter-spacing:.14em;text-transform:uppercase;color:#9FB0C6}
#beat-proof .c1{width:430px;height:330px;transform:rotate(-3deg)}
#beat-proof .c2{width:470px;height:360px;transform:rotate(0.6deg)}
#beat-proof .c3{width:390px;height:344px;transform:rotate(3deg)}
/* end */
#beat-end{flex-direction:column;justify-content:center}
#beat-end .mark{width:104px;height:104px;margin-bottom:34px}
#beat-end h1{font-size:74px;line-height:1.04;letter-spacing:-.035em;font-weight:500;text-align:center}
#beat-end h1 em{font-style:italic;color:#C9A84C}
#beat-end .cta{margin-top:44px;display:flex;align-items:center;gap:16px;font-size:24px;color:#C6D2E2}
#beat-end .dot{width:5px;height:5px;border-radius:50%;background:#C9A84C}
</style></head><body>
<div id="stage">
  <div class="beat" id="beat-hook">
    <div class="cut" id="cut-0"><img src="${agents}" alt=""></div>
    <div class="cut" id="cut-1"><img src="${growth}" alt=""></div>
    <div class="cut" id="cut-2"><img src="${agency}" alt=""></div>
    <div class="scrim"></div>
    <div class="caption" id="cap-hook"><div class="rule"></div><h2>Your customer work is scattered.</h2></div>
  </div>
  <div class="beat" id="beat-agents">
    <div class="shot" id="shot-agents" style="width:1010px;height:772px"><img src="${agents}" alt=""></div>
    <div class="scrim-b"></div>
    <div class="caption" id="cap-agents"><div class="rule"></div><h2>Agents answer, qualify and hand off.</h2></div>
  </div>
  <div class="beat" id="beat-growth">
    <div class="shot" id="shot-growth" style="width:1130px;height:762px"><img src="${growth}" alt=""></div>
    <div class="scrim-b"></div>
    <div class="caption" id="cap-growth"><div class="rule"></div><h2>Growth keeps the work in one place.</h2></div>
  </div>
  <div class="beat" id="beat-agency">
    <div class="shot" id="shot-agency" style="width:880px;height:784px"><img src="${agency}" alt=""></div>
    <div class="scrim-b"></div>
    <div class="caption" id="cap-agency"><div class="rule"></div><h2>Agency puts your name on it.</h2></div>
  </div>
  <div class="beat" id="beat-proof">
    <div class="scrim-b"></div>
    <div class="stack">
      <figure class="col"><div class="card c1"><img src="${agents}" alt=""></div><figcaption>Agents</figcaption></figure>
      <figure class="col"><div class="card c2"><img src="${growth}" alt=""></div><figcaption>Growth</figcaption></figure>
      <figure class="col"><div class="card c3"><img src="${agency}" alt=""></div><figcaption>Agency</figcaption></figure>
    </div>
    <div class="caption" id="cap-proof"><div class="rule"></div><h2>Built and run by KasiTek Labs.</h2></div>
  </div>
  <div class="beat" id="beat-end">
    <div class="mark">${mark}</div>
    <h1>Good ideas.<br><em>Real working tools.</em></h1>
    <div class="cta"><span>Book a 15-minute walkthrough.</span><span class="dot"></span><span>kasitek.co.za</span></div>
  </div>
  <div id="grain"></div>
</div>
<script>
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const ease=p=>1-Math.pow(1-p,3);
window.setFrame=(frame)=>{
  const beats=${JSON.stringify(BEATS)};
  for(const b of beats){
    const el=document.getElementById("beat-"+b.id);
    const local=frame-b.start, len=b.end-b.start;
    if(local<0||local>=len){el.style.opacity="0";continue;}
    let opacity=1;
    if(b.id!=="hook"&&local<${FADE}) opacity=local/${FADE};
    const tail=b.end-frame;
    if(tail<${FADE}) opacity*=clamp(tail/${FADE});
    el.style.opacity=String(clamp(opacity));
    if(el.style.opacity==="0"){continue;}
    const p=ease(clamp(local/len));
    if(b.id==="agents"||b.id==="growth"||b.id==="agency"){
      const shot=document.getElementById("shot-"+b.id);
      shot.style.transform="scale("+(1.015+0.055*p)+") translateY("+(-8*p)+"px)";
    }
    if(b.id==="hook"){
      for(let c=0;c<3;c++){
        const seg=len/3, o=local-c*seg;
        const cut=document.getElementById("cut-"+c);
        cut.style.opacity=String(o>=0&&o<seg?1:0);
        const ip=ease(clamp(o/seg));
        cut.querySelector("img").style.transform="scale("+(1.06-0.05*ip)+")";
      }
      const cap=document.getElementById("cap-hook");
      cap.style.opacity=String(ease(clamp((local-8)/14)));
      cap.style.transform="translateY("+((1-ease(clamp((local-8)/14)))*14)+"px)";
    } else if(b.id!=="end"){
      const cap=document.getElementById("cap-"+b.id);
      const t=ease(clamp((local-12)/16));
      cap.style.opacity=String(t);
      cap.style.transform="translateY("+((1-t)*16)+"px)";
      const rule=cap.querySelector(".rule");
      rule.style.transform="scaleX("+t+")";
    }
    if(b.id==="proof"){
      document.querySelectorAll("#beat-proof .card").forEach((card,i)=>{
        const t=ease(clamp((local-6-i*7)/20));
        card.style.opacity=String(t);
        card.style.transform=card.style.transform.replace(/ ?translateY\\([^)]*\\)/,"")+" translateY("+((1-t)*30)+"px)";
      });
    }
    if(b.id==="end"){
      const t=ease(clamp(local/26));
      el.style.transform="scale("+(0.985+0.015*t)+")";
    }
  }
};
window.setFrame(0);
</script></body></html>`;

await rm(build, { recursive: true, force: true });
await mkdir(build, { recursive: true });
await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

const total = BEATS.at(-1).end;
for (let frame = 0; frame < total; frame += 1) {
  await page.evaluate((index) => window.setFrame(index), frame);
  await page.screenshot({ path: join(build, `frame-${String(frame).padStart(4, "0")}.png`) });
  if (frame % 150 === 0) process.stdout.write(`frame ${frame}/${total}\n`);
}
await browser.close();

const args = [
  "-y", "-framerate", String(FPS), "-i", join(build, "frame-%04d.png"),
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", "-an", join(out, "kasitek-labs-demo-16x9.mp4"),
];
await new Promise((resolve, reject) => {
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  ff.stderr.on("data", chunk => { err += chunk.toString(); });
  ff.on("exit", code => code === 0 ? resolve() : reject(new Error(err.split("\n").slice(-12).join("\n"))));
});
const size = (await readFile(join(out, "kasitek-labs-demo-16x9.mp4"))).length;
await writeFile(join(out, "REPORT.txt"), `frames=${total} fps=${FPS} duration=${(total / FPS).toFixed(2)}s size=${(size / 1e6).toFixed(2)}MB\n`);
console.log(`rendered ${total} frames -> out/kasitek-labs-demo-16x9.mp4 (${(size / 1e6).toFixed(2)} MB)`);
