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

  for (const id of await evaluate('defs.filter(d=>d.cat==="window"||d.cat==="door").map(d=>d.id)')) {
    const rendered = await evaluate(`(()=>{const d=defs.find(x=>x.id===${JSON.stringify(id)});document.querySelector('.tab[data-cat="'+d.cat+'"]').click();document.querySelector('.item[data-id="'+d.id+'"]').click();const o=scene.objects.at(-1),g=document.querySelector('.obj[data-id="'+o.id+'"]');return !!g&&g.children.length>0})()`);
    assert.equal(rendered, true, `${id} can be created and rendered`);
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
  const finalTarget = await evaluate('scene.objects.find(o=>o.type==="component").id');
  await click(`[data-id="${finalTarget}"]`);
  await click('#svgExportBtn');
  await click('#exportBtn');
  await click('#transparentBtn');
  const downloaded = await waitFor(async () => readdir(downloadDir), list => list.some(n => n.endsWith('.svg')) && list.some(n => n.includes('白底') && n.endsWith('.png')) && list.some(n => n.includes('透明') && n.endsWith('.png')), 'SVG and both PNG downloads');
  const svgName = downloaded.find(n => n.endsWith('.svg'));
  const svgText = await readFile(path.join(downloadDir, svgName), 'utf8');
  assert.match(svgText, /<svg\b/);
  assert.ok(downloaded.some(n => n.includes('白底') && n.endsWith('.png')));
  assert.ok(downloaded.some(n => n.includes('透明') && n.endsWith('.png')));
  const pngBackgrounds = await evaluate(`(async()=>{async function pixel(transparent){const markup=serializeExportSvg(transparent),url=URL.createObjectURL(new Blob([markup],{type:'image/svg+xml'})),img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);const p=[...c.getContext('2d').getImageData(0,0,1,1).data];URL.revokeObjectURL(url);return p}return{white:await pixel(false),transparent:await pixel(true)}})()`);
  assert.equal(pngBackgrounds.white[3], 255, 'white-background export raster is opaque');
  assert.equal(pngBackgrounds.transparent[3], 0, 'transparent export raster keeps alpha');
  const pdf = await page.send('Page.printToPDF', { printBackground: true });
  const pdfBytes = Buffer.from(pdf.data, 'base64');
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  await writeFile(path.join(downloadDir, 'smoke-print.pdf'), pdfBytes);

  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual(consoleErrors, [], 'browser console has no uncaught errors');
  console.log('PASS: browser title, all 14 component renderings, layer visibility, linked width/height updates, movement, delete+undo, copy, group, flip, history, SVG/PNG downloads and alpha, PDF generation, and console check.');
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

