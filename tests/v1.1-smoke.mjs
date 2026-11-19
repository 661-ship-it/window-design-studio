import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(here, '..', 'index.html');
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const profilePrefix = path.join(os.tmpdir(), 'window-design-studio-v1.1-');
const profile = await mkdtemp(profilePrefix);
const downloadDir = path.join(profile, 'downloads');
await mkdir(downloadDir);

let browser;
let server;
let page;
const consoleErrors = [];

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.onEvent(message);
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  close() { this.ws.close(); }
}

async function waitFor(read, predicate, label, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function evaluate(expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Page evaluation failed');
  return result.result.value;
}

async function click(selector) {
  const clicked = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);
  assert.equal(clicked, true, `missing clickable element: ${selector}`);
}

async function setField(key, value) {
  return evaluate(`(()=>{const e=document.querySelector('[data-key="${key}"]');if(!e)return false;e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
}

async function main() {
  const source = await readFile(htmlPath, 'utf8');
  new Function(source.match(/<script>([\s\S]*?)<\/script>/)[1]);
  server = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(source);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--disable-background-networking',
    '--remote-allow-origins=*', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, url
  ], { stdio: 'ignore', windowsHide: true });
  const activePortPath = path.join(profile, 'DevToolsActivePort');
  const activePort = await waitFor(async () => {
    try { return (await readFile(activePortPath, 'utf8')).split(/\r?\n/)[0]; }
    catch { return ''; }
  }, value => /^\d+$/.test(value), 'isolated Chrome DevTools port');
  const version = await (await fetch(`http://127.0.0.1:${activePort}/json/version`)).json();
  const browserCdp = new CDP(version.webSocketDebuggerUrl);
  await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });

  const targets = await waitFor(async () => (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json(), list => list.some(t => t.type === 'page'), 'Chrome page target');
  const target = targets.find(t => t.type === 'page');
  page = new CDP(target.webSocketDebuggerUrl);
  page.onEvent = message => {
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails?.text || 'uncaught exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args?.map(a => a.value).join(' '));
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url });
  await waitFor(() => evaluate('document.readyState'), value => value === 'complete', 'page load');

  assert.match(await evaluate('document.title'), /门窗二维设计与出图工作台 \| Window Design Studio/);
  assert.equal(await evaluate('defs.filter(d=>d.cat==="window"||d.cat==="door").length'), 14, 'the original 14 component IDs remain available');

  if(process.env.V1_2_SCREENSHOT_DIR)await mkdir(process.env.V1_2_SCREENSHOT_DIR,{recursive:true});
  for (const id of await evaluate('defs.filter(d=>d.cat==="window"||d.cat==="door").map(d=>d.id)')) {
    if(process.env.V1_2_SCREENSHOT_DIR)await evaluate('scene={objects:[],groups:[],erasures:[]};selected=[];render()');
    const rendered = await evaluate(`(()=>{const d=defs.find(x=>x.id===${JSON.stringify(id)});document.querySelector('.tab[data-cat="'+d.cat+'"]').click();document.querySelector('.item[data-id="'+d.id+'"]').click();const o=scene.objects.at(-1),g=document.querySelector('.obj[data-id="'+o.id+'"]');return !!g&&g.children.length>0})()`);
    assert.equal(rendered, true, `${id} can be created and rendered`);
    if(process.env.V1_2_SCREENSHOT_DIR){await evaluate('selected=[];render();document.querySelector("#toast").style.display="none"');const image=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(process.env.V1_2_SCREENSHOT_DIR,`${id}.png`),Buffer.from(image.data,'base64'))}
  }
  await evaluate('window.confirm=()=>true;document.querySelector("#newBtn").click()');

  // V1.2: louver controls must affect real SVG geometry and keep a separate glass-boundary switch.
  await click('.tab[data-cat="window"]');
  await click('.item[data-id="W008"]');
  const louverId = await evaluate('scene.objects.at(-1).id');
  assert.equal(await evaluate('!!document.querySelector("[data-key=bladeCount]")'), true, 'W008 exposes blade count');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${louverId}").bladeCount`), 6, 'W008 defaults to six blades');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${louverId}").showGlassBoundary`), false, 'W008 glass boundary defaults off');
  assert.equal(await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${louverId}");return o.fillColor==="#005BAC"&&o.joint==="45_degree"&&o.layers.joint.show})()`),true,'V1.1 blue fill and joint defaults are preserved');
  for (const count of [3, 8, 12, 20]) {
    assert.equal(await setField('bladeCount', count), true);
    assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${louverId}"] [data-layer="sash"]').length`), count, `W008 renders ${count} horizontal blades`);
    assert.equal(await evaluate(`(()=>{const r=[...document.querySelectorAll('.obj[data-id="${louverId}"] rect[data-layer="sash"]')],centers=r.map(e=>+e.getAttribute('y')+ +e.getAttribute('height')/2),g=componentMetrics(scene.objects.find(o=>o.id==="${louverId}"));return centers.every((y,i)=>y>=scene.objects.find(o=>o.id==="${louverId}").h*g.bladeTop&&y<=scene.objects.find(o=>o.id==="${louverId}").h*(1-g.bladeBottom))&&centers.slice(2).every((y,i)=>Math.abs((y-centers[i+1])-(centers[1]-centers[0]))<.01)})()`),true,`W008 ${count} blades are evenly spaced within the inner area`);
  }
  await setField('bladeCount',21);
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${louverId}").bladeCount`),20,'W008 rejects values above the safe maximum');
  await click('#undoBtn');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${louverId}").bladeCount`),12,'W008 blade-count change participates in undo');
  await click('#redoBtn');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${louverId}").bladeCount`),20,'W008 blade-count change participates in redo');
  await click(`[data-id="${louverId}"]`);
  await click('[data-key="showGlassBoundary"]');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${louverId}").showGlassBoundary`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${louverId}"] [data-layer="glass"][data-kind="boundary"]').length`), 1, 'W008 glass-boundary switch adds one independent boundary');
  for(const [w,h] of [[600,1200],[1200,1200],[3000,1200]]){
    await setField('w',w);await setField('h',h);
    assert.equal(await evaluate(`(()=>{const r=[...document.querySelectorAll('.obj[data-id="${louverId}"] rect[data-layer="sash"]')],o=scene.objects.find(o=>o.id==="${louverId}"),c=r.map(x=>+x.getAttribute('y')+ +x.getAttribute('height')/2),p=(h=>h*(1-.16)/20)(o.h);return r.length===20&&c.every((y,i)=>y>=0&&y<=o.h)&&c.every((y,i)=>i===0||Math.abs((y-c[i-1])-p)<.01)})()`),true,`W008 20 blades remain evenly spaced at ${w}×${h}`);
  }

  // Two-track front elevations need two genuinely overlapping sash outlines and outward motion.
  for (const id of ['W010', 'D006']) {
    await evaluate('scene={objects:[],groups:[],erasures:[]};selected=[];render()');
    const def = await evaluate(`defs.find(d=>d.id===${JSON.stringify(id)})`);
    await click(`.tab[data-cat="${def.cat}"]`);
    await click(`.item[data-id="${id}"]`);
    const objectId = await evaluate('scene.objects.at(-1).id');
    assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${objectId}").overlapRatio`), 0.025, `${id} stores the front-elevation visual overlap ratio`);
    assert.equal(await evaluate(`(()=>{const r=[...document.querySelectorAll('.obj[data-id="${objectId}"] rect[data-layer="sash"]')];return r.length===2&&+r[0].getAttribute('x')+ +r[0].getAttribute('width')>+r[1].getAttribute('x')})()`), true, `${id} renders two overlapping sash outlines`);
    assert.equal(await evaluate(`(()=>{const lines=[...document.querySelectorAll('.obj[data-id="${objectId}"] line[data-layer="opening"][marker-end]')];return lines.length===2&&+lines[0].getAttribute('x2')<+lines[0].getAttribute('x1')&&+lines[1].getAttribute('x2')>+lines[1].getAttribute('x1')})()`), true, `${id} renders outward left/right movement arrows`);
    const aspectSizes=id==='W010'?[[700,1400],[1500,1500],[4000,1600]]:[[1200,2400],[1800,1800],[4500,1800]];
    for (const [w, h] of aspectSizes) {
      await evaluate(`(()=>{const o=scene.objects.find(x=>x.id==="${objectId}");o.w=${w};o.h=${h};render()})()`);
      assert.equal(await evaluate(`(()=>{const r=[...document.querySelectorAll('.obj[data-id="${objectId}"] rect[data-layer="sash"]')];return r.length===2&&+r[0].getAttribute('x')+ +r[0].getAttribute('width')>+r[1].getAttribute('x')})()`), true, `${id} keeps sash overlap at ${w}/${h} aspect ratio`);
      assert.equal(await evaluate(`(()=>{const g=document.querySelector('.obj[data-id="${objectId}"]');return [...g.querySelectorAll('[data-layer="sash"], [data-layer="glass"]')].every(e=>{const b=e.getBBox();return b.x>=-1&&b.y>=-1&&b.x+b.width<=${w}+1&&b.y+b.height<=${h}+1})&&[...g.querySelectorAll('line[data-layer="opening"]')].every(e=>{const x1=+e.getAttribute('x1'),x2=+e.getAttribute('x2'),y1=+e.getAttribute('y1'),y2=+e.getAttribute('y2');return Math.min(x1,x2)>=-1&&Math.max(x1,x2)<=${w}+1&&Math.min(y1,y2)>=-1&&Math.max(y1,y2)<=${h}+1})})()`), true, `${id} keeps internal geometry inside the frame at ${w}/${h}`);
    }
  }
  await evaluate('scene={objects:[],groups:[],erasures:[]};selected=[];render()');
  await click('.tab[data-cat="door"]');
  await click('.item[data-id="D004"]');
  let slidingDoorId=await evaluate('scene.objects.at(-1).id');
  assert.equal(await evaluate(`(()=>{const g=document.querySelector('.obj[data-id="${slidingDoorId}"]'),a=g.querySelector('line[data-layer="opening"]');return +a.getAttribute('x2')<+a.getAttribute('x1')})()`),true,'D004 left setting moves left');
  await setField('opening','right');
  assert.equal(await evaluate(`(()=>{const a=document.querySelector('.obj[data-id="${slidingDoorId}"] line[data-layer="opening"]');return +a.getAttribute('x2')>+a.getAttribute('x1')})()`),true,'D004 right setting moves right');
  await evaluate('scene={objects:[],groups:[],erasures:[]};selected=[];render()');
  await click('.item[data-id="D005"]');
  slidingDoorId=await evaluate('scene.objects.at(-1).id');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${slidingDoorId}").overlapRatio`),0.05,'D005 keeps its 5% visual overlap');
  assert.equal(await evaluate(`(()=>{const r=[...document.querySelectorAll('.obj[data-id="${slidingDoorId}"] rect[data-layer="sash"]')];return r.length===2&&+r[0].getAttribute('x')+ +r[0].getAttribute('width')>+r[1].getAttribute('x')})()`),true,'D005 sash outlines overlap visibly');
  assert.equal(await evaluate(`(()=>{const a=[...document.querySelectorAll('.obj[data-id="${slidingDoorId}"] line[data-layer="opening"]')];return a.length===6&&+a[0].getAttribute('x2')<+a[0].getAttribute('x1')&&+a[3].getAttribute('x2')>+a[3].getAttribute('x1')})()`),true,'D005 left/right movement arrows match its two sash directions');
  await evaluate('window.confirm=()=>true;document.querySelector("#newBtn").click()');

  // Remaining component elevations: distinct semantics, proportional fit and door glazing.
  for (const id of ['W001','W002','W003','W004','W005','W006','W007','D001','D003']) {
    await evaluate('scene={objects:[],groups:[],erasures:[]};selected=[];render()');
    const def=await evaluate(`defs.find(d=>d.id===${JSON.stringify(id)})`);
    await click(`.tab[data-cat="${def.cat}"]`);
    await click(`.item[data-id="${id}"]`);
    const objectId=await evaluate('scene.objects.at(-1).id');
    for(const [w,h] of [[def.minW,def.minH],[def.maxW,def.maxH]]){
      await evaluate(`(()=>{const o=scene.objects.find(x=>x.id==="${objectId}");o.w=${w};o.h=${h};render()})()`);
      assert.equal(await evaluate(`(()=>{const b=document.querySelector('.obj[data-id="${objectId}"]').getBBox();return b.x>=-1&&b.y>=-1&&b.x+b.width<=${w}+1&&b.y+b.height<=${h}+1})()`),true,`${id} remains inside its elevation bounds at ${w}×${h}`);
    }
    await click(`[data-id="${objectId}"]`);
    assert.equal(await setField('rotation',30),true);
    assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${objectId}").rotation`),30,`${id} accepts rotation`);
    await click('#flipXBtn');await click('#flipYBtn');
    assert.equal(await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${objectId}");return o.scaleX<0&&o.scaleY<0})()`),true,`${id} supports both flips`);
    await click('#undoBtn');await click('#undoBtn');await click('#undoBtn');
    assert.equal(await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${objectId}");return o.rotation===0&&o.scaleX===1&&o.scaleY===1})()`),true,`${id} restores rotation and flips with undo`);
    await click(`.tree-item[data-id="${objectId}"]`);
    if(id==='W001'){
      assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${objectId}"] [data-layer="opening"]').length`),0,'W001 has no opening symbol');
      assert.equal(await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${objectId}");o.layers.joint.color="#FF0000";render();return o.layers.joint.color==="#FF0000"&&document.querySelector('.obj[data-id="${objectId}"] path[data-layer="joint"]').getAttribute('stroke')==="#FF0000"})()`),true,'custom joint-layer color survives render and is applied to geometry');
      await click('.layer-prop[data-layer="joint"][data-key="show"]');
      assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${objectId}"] [data-layer="joint"]').length`),0,'joint layer visibility switch removes joint geometry');
      await click('.layer-prop[data-layer="joint"][data-key="show"]');
      assert.equal(await evaluate(`document.querySelector('.obj[data-id="${objectId}"] path[data-layer="joint"]').getAttribute('stroke')`),'#FF0000','joint visibility toggle preserves the custom layer color');
      assert.equal(await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${objectId}");return o.fillColor==="#005BAC"&&document.querySelector('.obj[data-id="${objectId}"] rect[data-kind="fill"]').getAttribute('fill')==="#FFFFFF"})()`),true,'blue frame fill default and separate white glass region remain intact');
    }
    if(id==='W002'){
      assert.equal(await evaluate(`!!document.querySelector('[data-key="opening"]')`),true,'W002 exposes left/right only');
      assert.equal(await evaluate(`!!document.querySelector('[data-key="openingType"]')`),false,'W002 does not expose unrelated top/bottom modes');
      assert.equal(await evaluate(`document.querySelector('#properties').innerText.includes('从室内侧看')`),true,'W002 opening direction states its indoor viewing side');
    }
    if(id==='W003'||id==='W004')assert.notEqual(await evaluate(`componentSVG(scene.objects.find(o=>o.id==="${objectId}"))`),await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${objectId}");return componentSVG({...o,defId:"${id==='W003'?'W004':'W003'}"})})()`),`${id} retains its own hinge-edge symbol`);
    if(id==='W005')assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${objectId}"] line[data-layer="opening"]').length`),3,'W005 has one upward movement arrow');
    if(id==='W007')assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${objectId}"] line[data-layer="opening"]').length`),6,'W007 has two opposing vertical movement arrows');
    if(['W005','W007','W010','D005','D006'].includes(id))assert.equal(await evaluate(`document.querySelector('#properties').innerText.includes('立面运动方向')`),true,`${id} explains its elevation movement direction`);
    if(id==='W006'||id==='D003')assert.equal(await evaluate(`document.querySelectorAll('.obj[data-id="${objectId}"] rect[data-layer="sash"]').length`),2,`${id} has two separate sash outlines`);
    if(id==='D001'||id==='D003')for(const glass of ['single','double','tempered'])assert.equal(await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${objectId}");o.glass=${JSON.stringify(glass)};return componentSVG(o).includes('data-kind="boundary"')})()`),true,`${id} displays a glass boundary for ${glass} configuration`);
  }
  await evaluate('window.confirm=()=>true;document.querySelector("#newBtn").click()');

  // Width/height dimensions must bind to the selected component and remain in step with edits.
  await click('.tab[data-cat="window"]');
  await click('.item[data-id="W001"]');
  const targetId = await evaluate('scene.objects[0].id');
  const glassRectsBefore = await evaluate(`document.querySelector('.obj[data-id="${targetId}"]').querySelectorAll('rect').length`);
  await evaluate('document.querySelector(".layer-prop[data-layer=glass][data-key=show]").click()');
  assert.equal(await evaluate(`scene.objects.find(o=>o.id==="${targetId}").layers.glass.show`), false, 'component layer visibility updates from the properties panel');
  assert.ok(await evaluate(`document.querySelector('.obj[data-id="${targetId}"]').querySelectorAll('rect').length`)<glassRectsBefore, 'hidden glass layer is removed from the SVG');
  assert.equal(await evaluate('document.querySelectorAll("[data-dimension-axis]").length'), 2, 'separate width and height dimension controls exist');
  await click('[data-dimension-axis="width"]');
  await click(`[data-id="${targetId}"]`);
  await click('[data-dimension-axis="height"]');
  assert.equal(await evaluate('scene.objects.filter(o=>o.type==="dimension").length'), 2);
  assert.equal(await evaluate(`scene.objects.filter(o=>o.type==="dimension").every(d=>d.refId==="${targetId}")`), true, 'both dimensions reference the component');
  assert.equal(await evaluate(`scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="width").w===scene.objects.find(o=>o.id==="${targetId}").w`), true);
  assert.equal(await evaluate(`scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="height").w===scene.objects.find(o=>o.id==="${targetId}").h`), true);

  await click(`[data-id="${targetId}"]`);
  await click('#copyBtn');
  assert.equal(await evaluate('scene.objects.length'), 6, 'copying a component also copies its associated dimensions');
  assert.equal(await evaluate(`scene.objects.filter(o=>o.type==="dimension").length`), 4);
  assert.equal(await evaluate('scene.objects.filter(o=>o.type==="component").length'), 2);
  assert.equal(await evaluate('scene.objects.filter(o=>o.type==="dimension").every(d=>scene.objects.some(c=>c.id===d.refId&&c.type==="component"))'), true, 'copied dimensions point to an existing component');
  await click('#undoBtn');
  assert.equal(await evaluate('scene.objects.length'), 3);

  await click(`[data-id="${targetId}"]`);
  await click('#flipXBtn');
  assert.equal(await evaluate(`scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="width").reverse`), true, 'width dimension reverses with horizontal component flip');
  assert.equal(await evaluate(`scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="height").reverse`), false);
  assert.ok(await evaluate(`objectSVG(scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="width")).includes('x2="-1500"')`), 'flipped width dimension spans back toward the component');
  await click('#flipYBtn');
  assert.equal(await evaluate(`scene.objects.filter(o=>o.type==="dimension").every(d=>d.reverse)`), true, 'both dimensions reverse with vertical component flip');
  assert.ok(await evaluate(`objectSVG(scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="height")).includes('y2="-1800"')`), 'flipped height dimension spans back toward the component');
  await click('#undoBtn');
  await click('#undoBtn');
  assert.equal(await evaluate(`scene.objects.filter(o=>o.type==="dimension").every(d=>!d.reverse)`), true, 'undo restores normal dimension orientation');

  await click(`[data-id="${targetId}"]`);
  assert.equal(await setField('rotation', 90), true);
  assert.equal(await evaluate('scene.objects.filter(o=>o.type==="dimension").every(d=>d.rotation===90)'), true, 'linked dimensions follow component rotation');
  assert.equal(await setField('rotation', 0), true);
  await click(`[data-id="${targetId}"]`);
  assert.equal(await setField('w', 800), true);
  assert.equal(await setField('h', 1400), true);
  assert.equal(await evaluate(`scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="width").text`), '800');
  assert.equal(await evaluate(`scene.objects.find(o=>o.type==="dimension"&&o.dimensionAxis==="height").text`), '1400');
  assert.equal(await setField('x', 250), true);
  assert.equal(await evaluate(`scene.objects.filter(o=>o.type==="dimension").every(d=>d.x!==0)`), true, 'linked dimensions follow component movement');

  await click(`[data-id="${targetId}"]`);
  await click('#deleteBtn');
  assert.equal(await evaluate('scene.objects.length'), 0, 'deleting the component removes its linked dimensions');
  await click('#undoBtn');
  assert.equal(await evaluate('scene.objects.length'), 3, 'undo restores the component and both linked dimensions');

  // Basic canvas drawing, selection, copy, layer edit, rotation, flip and history remain available.
  await evaluate('addObject("rect",{x:1200,y:0})');
  await click('#copyBtn');
  assert.equal(await evaluate('scene.objects.length'), 5, 'copying a component also preserves its two linked dimensions');
  await click('#flipXBtn');
  await click('#undoBtn');
  await click('#redoBtn');
  await evaluate('selected=scene.objects.filter(o=>o.type==="rect").map(o=>o.id);render()');
  await click('#groupBtn');
  assert.ok(await evaluate('scene.objects.filter(o=>o.group).length>=2'));
  await click('#ungroupBtn');
  assert.equal(await evaluate('scene.objects.some(o=>o.group)'), false);
  await click('[data-tool="pixelEraser"]');
  assert.ok(await evaluate('!!document.querySelector("#eraserSize")'));
  await click('#undoBtn');
  await click('#redoBtn');

  // SVG and PNG downloads plus browser-generated PDF.
  await evaluate('addObject("W010",{x:2500,y:0})');
  const finalTarget = await evaluate('scene.objects.at(-1).id');
  await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${finalTarget}");o.x=0;o.y=0;scene.objects=[o];scene.groups=[];scene.erasures=[];selected=[];scale=.18;pan={x:0,y:0};render()})()`);
  const exportGeometry = await evaluate(`(()=>{const o=scene.objects.find(o=>o.id==="${finalTarget}"),s=componentSVG(o);return{sashes:(s.match(/data-layer="sash"/g)||[]).length,arrows:(s.match(/marker-end="url\\(#arrow\\)"/g)||[]).length,fill:s.includes('fill="#005BAC"')}})()`);
  assert.deepEqual(exportGeometry,{sashes:2,arrows:2,fill:true},'canvas and shared export renderer use the same two-sash W010 geometry and blue fill');
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  const narrowLayout=await evaluate('(()=>{render();const r=document.querySelector("#scene").getBoundingClientRect();return{stageWidth:r.width,stageHeight:r.height,svgWidth:+document.querySelector("#svg").getAttribute("viewBox").split(" ")[2],bodyWidth:document.body.scrollWidth}})()');
  assert.ok(narrowLayout.stageWidth>0&&narrowLayout.stageHeight>0&&narrowLayout.svgWidth>0,'narrow viewport keeps the drawing stage and SVG active');
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await click(`[data-id="${finalTarget}"]`);
  await click('#svgExportBtn');
  await click('#exportBtn');
  await click('#transparentBtn');
  const downloaded = await waitFor(async () => readdir(downloadDir), list => list.some(n => n.endsWith('.svg')) && list.some(n => n.includes('白底') && n.endsWith('.png')) && list.some(n => n.includes('透明') && n.endsWith('.png')), 'SVG and both PNG downloads');
  const svgName = downloaded.find(n => n.endsWith('.svg'));
  const svgText = await readFile(path.join(downloadDir, svgName), 'utf8');
  assert.match(svgText, /<svg\b/);
  assert.equal((svgText.match(/data-layer="sash"/g)||[]).length,2,'downloaded SVG retains both W010 sash boundaries');
  assert.equal((svgText.match(/marker-end="url\(#arrow\)"/g)||[]).length,2,'downloaded SVG retains both W010 movement arrows');
  assert.ok(downloaded.some(n => n.includes('白底') && n.endsWith('.png')));
  assert.ok(downloaded.some(n => n.includes('透明') && n.endsWith('.png')));
  const pngBackgrounds = await evaluate(`(async()=>{async function pixel(transparent){const markup=serializeExportSvg(transparent),url=URL.createObjectURL(new Blob([markup],{type:'image/svg+xml'})),img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);const p=[...c.getContext('2d').getImageData(0,0,1,1).data];URL.revokeObjectURL(url);return p}return{white:await pixel(false),transparent:await pixel(true)}})()`);
  assert.equal(pngBackgrounds.white[3], 255, 'white-background export raster is opaque');
  assert.equal(pngBackgrounds.transparent[3], 0, 'transparent export raster keeps alpha');
  const pdf = await page.send('Page.printToPDF', { printBackground: true });
  const pdfBytes = Buffer.from(pdf.data, 'base64');
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  await writeFile(process.env.V1_2_PDF_PATH||path.join(downloadDir, 'smoke-print.pdf'), pdfBytes);

  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual(consoleErrors, [], 'browser console has no uncaught errors');
  console.log(`PASS: browser title, all 14 component renderings, min/max dimensions, per-component rotation/flips and undo, W008 counts/boundary, sliding overlap/movement, joint/color preservation, linked dimensions, narrow viewport (${narrowLayout.stageWidth}px stage, ${narrowLayout.bodyWidth}px page), SVG/PNG geometry and alpha, PDF generation, and console check.`);
}

try {
  await main();
} finally {
  page?.close();
  server?.close();
  if (browser && browser.exitCode === null) {
    const exited = once(browser, 'exit').catch(() => {});
    browser.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  const resolvedProfile = path.resolve(profile);
  if (resolvedProfile.startsWith(path.resolve(os.tmpdir()) + path.sep) && resolvedProfile.startsWith(path.resolve(profilePrefix))) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await rm(resolvedProfile, { recursive: true, force: true }); break; }
      catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }
}

