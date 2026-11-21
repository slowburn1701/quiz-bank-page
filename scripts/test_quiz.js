#!/usr/bin/env node
/**
 * 刷题页端到端自检（无头 Chrome，CDP 直连，无第三方依赖）。
 *
 * 用法:
 *   node test_quiz.js <页面.html> <questions.json> [截图输出目录]
 *
 * 检查：题库数量、选项乱序、整套作答/提交/计分、导出 txt、错题卷、
 *       逐题闯关 + 键盘、刷新持久化、移动端布局、控制台报错。
 * 需要 Chrome；Windows 默认路径见下，可用环境变量 CHROME 覆盖。
 * 注意：在 DSH 的 workspace-write 沙箱里 Chrome 可能起不来，需用 danger-full-access。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 0); // 0 = 随机端口，避免撞上残留的调试实例

const [, , HTML_ARG, BANK_ARG, OUT_ARG] = process.argv;
if (!HTML_ARG || !BANK_ARG) {
  console.error('usage: node test_quiz.js <page.html> <questions.json> [outDir]');
  process.exit(2);
}
const HTML = path.resolve(HTML_ARG);
const OUT = path.resolve(OUT_ARG || path.join(path.dirname(HTML), 'quiz-test'));
const DL = path.join(OUT, 'downloads');
const DATA = JSON.parse(fs.readFileSync(BANK_ARG, 'utf8'));
const BANK = DATA.questions.map(q => ({
  id: q.id, q: q.q, opts: q.opts.slice(), ans: q.ans
}));
const META = DATA.meta || {};
const N = BANK.length;
const BY_ID = new Map(BANK.map(q => [q.id, q]));
const TOTAL_OPTS = BANK.reduce((a, q) => a + q.opts.length, 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));
function jget(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else { fails++; console.log('  FAIL ' + msg); }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  const profile = path.join(OUT, 'chrome-profile');

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-allow-origins=*',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1280,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let port = PORT;
  if (!port) {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      if (fs.existsSync(portFile)) {
        const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
        if (first) { port = Number(first); break; }
      }
    }
  }
  let target = null;
  for (let i = 0; i < 100 && port; i++) {
    await sleep(150);
    try {
      const list = await jget('http://127.0.0.1:' + port + '/json/list');
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch (e) {}
  }
  if (!target) { console.log('FAIL: chrome did not start（沙箱内需 danger-full-access）'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) {
      events.push(msg);
      if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
    }
  };
  function send(method, params = {}) {
    const id = ++seq;
    return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evalJS(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) throw new Error('EVAL: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result.result.value;
  }
  async function shot(name) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, 'base64'));
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await send('Page.navigate', { url: pathToFileURL(HTML).href });
  await sleep(900);
  await evalJS('localStorage.clear(); true');
  await send('Page.reload');
  await sleep(900);

  const viewState = () => evalJS(`(() => {
    const pv = document.getElementById('paperView');
    return {
      paperVisible: !pv.hidden,
      drillVisible: !document.getElementById('drillView').hidden,
      paperCount: document.querySelectorAll('#paperList .pq').length,
      head: document.getElementById('paperHead').innerText,
      bar: (document.querySelector('#paperBar .pinfo') || {}).textContent || '',
      score: (document.querySelector('#paperHead .scorebox') || {}).innerText || '',
      tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent + ':' + t.classList.contains('on')),
      wrongN: document.getElementById('wrongCount').textContent,
      drillQ: document.getElementById('qText').textContent,
      title: document.title,
      h1: document.getElementById('examTitle').textContent,
      countChip: document.getElementById('bankCount').textContent
    };
  })()`);

  const paperStructure = () => evalJS(`(() => {
    const out = [];
    document.querySelectorAll('#paperList .pq').forEach(a => {
      out.push({ id: Number(a.getAttribute('data-id')), texts: [...a.querySelectorAll('.pqopt')].map(b => b.lastElementChild.textContent.trim()) });
    });
    return out;
  })()`);

  async function pick(id, correct) {
    const q = BY_ID.get(id);
    return evalJS(`(() => {
      const art = document.querySelector('.pq[data-id="${id}"]');
      if (!art) return 'no-art';
      const opts = [...art.querySelectorAll('.pqopt')];
      const want = ${JSON.stringify(q.opts[q.ans])};
      const b = opts.find(x => { const t = x.lastElementChild.textContent.trim(); return ${correct} ? t === want : t !== want; });
      if (!b) return 'no-opt';
      b.click();
      return 'ok';
    })()`);
  }

  async function fillPaper(correctPredicate) {
    for (let i = 0; i < BANK.length; i++) {
      const q = BANK[i];
      const r = await pick(q.id, correctPredicate(q));
      if (r !== 'ok') return '#' + q.id + ':' + r;
    }
    return 'ok';
  }

  console.log('\n[0] 单文件与标题');
  const pageSrc = fs.readFileSync(HTML, 'utf8');
  ok(!/(?:src|href)\s*=\s*["']https?:\/\//i.test(pageSrc), '无外链资源（可离线打开）');
  ok(!pageSrc.includes('__BANK__') && !pageSrc.includes('__META__'), '占位符已替换');
  let v = await viewState();
  ok(v.paperVisible && !v.drillVisible, '默认显示整套试卷');
  ok(v.countChip === String(N), '题量显示 ' + N);
  if (META.title) ok(v.title.includes(META.title) && v.h1.includes(META.title), '标题注入：' + v.title);

  console.log('\n[1] 试卷结构');
  ok(v.paperCount === N, '试卷包含 ' + N + ' 题：' + v.paperCount);
  ok(new RegExp('第 1 套 · 全题库 · ' + N + ' 题').test(v.head), '卷头：' + (v.head.split('\n')[0] || ''));
  ok(v.bar.includes('已答 0 / ' + N), '底部未答计数：' + v.bar);

  let struct = await paperStructure();
  ok(new Set(struct.map(x => x.id)).size === N, '题号不重复');
  ok(struct.every(x => x.texts.length === BY_ID.get(x.id).opts.length), '每题选项数与题库一致');
  const identity = struct.filter(x => x.texts.length >= 3 && x.texts.every((t, i) => t === BY_ID.get(x.id).opts[i]));
  ok(identity.length === 0, '没有一题保持原选项顺序' + (identity.length ? '（相同：' + identity.map(x => x.id).join(',') + '）' : ''));
  console.log('\n[1b] 试卷总览');
  ok(!(await evalJS('document.getElementById("paperNavPanel").hidden')), '总览面板随试卷显示');
  ok((await evalJS('document.querySelectorAll("#paperNav button").length')) === N, '总览题号数 = ' + N);
  const navTexts = await evalJS('[...document.querySelectorAll("#paperNav button")].map(b => b.textContent)');
  ok(navTexts.join(',') === Array.from({ length: N }, (_, i) => String(i + 1)).join(','), '题号按 1..N 排列');
  ok((await evalJS('document.querySelectorAll("#paperNav button.ok, #paperNav button.bad").length')) === 0, '未答时题号无彩色');
  await shot('shot-paper-top.png');

  console.log('\n[2] 整套全对 + 刷新保留');
  let r = await fillPaper(() => true);
  ok(r === 'ok', '全部作答' + (r === 'ok' ? '' : '：' + r));
  v = await viewState();
  ok(v.bar.includes('已答 ' + N + ' / ' + N), '已全部作答：' + v.bar);
  await send('Page.reload');
  await sleep(900);
  v = await viewState();
  ok(v.bar.includes('已答 ' + N + ' / ' + N), '刷新后作答保留');
  ok(/第 1 套/.test(v.head), '刷新后仍是第 1 套');
  ok((await evalJS('document.querySelectorAll("#paperNav button.ok").length')) === N, '答对题号全部变绿');
  await evalJS('document.querySelectorAll("#paperNav button")[2].click(); true');
  await sleep(300);
  ok((await evalJS('document.querySelectorAll("#paperNav button.cur").length')) === 1 &&
     (await evalJS('document.querySelectorAll("#paperNav button")[2].classList.contains("cur")')), '点总览题号有高亮');
  ok((await evalJS('document.querySelectorAll("#paperNav button.ok").length')) === N, '跳转不改变对错颜色');

  console.log('\n[3] 提交与计分');
  await evalJS('document.getElementById("submitPaperBtn").click(); true');
  await sleep(500);
  v = await viewState();
  ok(v.score.includes(N + '/' + N) && /100%/.test(v.score), '满分：' + v.score.replace(/\n/g, ' '));
  ok(v.bar.includes('已提交 · 得分 ' + N), '底部已提交态：' + v.bar);
  ok((await evalJS('document.querySelectorAll(".pqans").length')) === N, '每题给出正确答案');
  ok((await evalJS('document.querySelectorAll(".pqopt:disabled").length')) === TOTAL_OPTS, '提交后选项锁定');
  ok((await evalJS('document.querySelectorAll(".pqopt.correct").length')) === N, '正确项全部标绿');
  ok((await evalJS('document.querySelectorAll(".pqopt.wrong").length')) === 0, '无错选标红');
  await shot('shot-paper-result.png');

  console.log('\n[4] 导出答题情况');
  await evalJS('document.getElementById("exportBtn").click(); true');
  await sleep(1500);
  const files = fs.readdirSync(DL).filter(f => f.endsWith('.txt'));
  ok(files.length === 1, '导出 1 个 txt：' + files.join(','));
  const txt = files.length ? fs.readFileSync(path.join(DL, files[0]), 'utf8') : '';
  ok(txt.includes('得分：' + N + '/' + N), 'txt 含得分');
  ok(txt.includes('错题ID：无'), 'txt 含“错题ID：无”');
  ok(/【错题明细】/.test(txt) && /【全部作答/.test(txt), 'txt 含错题明细与全部作答');
  if (META.title) ok(txt.startsWith(META.title), 'txt 标题：' + txt.split('\n')[0]);
  await evalJS('document.getElementById("copyBtn").click(); true');
  await sleep(400);
  ok(((await evalJS('(document.getElementById("toast") || {}).className')) || '').indexOf('on') !== -1, '复制按钮给出提示（无头下失败属正常）');

  console.log('\n[5] 重新开一套 + 错题卷');
  await evalJS('document.getElementById("newPaperBtn").click(); true');
  await sleep(500);
  v = await viewState();
  ok(/第 2 套/.test(v.head) && v.bar.includes('已答 0 / ' + N), '进入第 2 套且清空作答');
  const wrongIds = [BANK[0].id, BANK[Math.min(1, N - 1)].id];
  r = await fillPaper(q => wrongIds.indexOf(q.id) === -1);
  ok(r === 'ok', '第 2 套作答完成');
  await evalJS('document.getElementById("submitPaperBtn").click(); true');
  await sleep(500);
  v = await viewState();
  const line = v.score.replace(/\n/g, ' ');
  ok(line.includes((N - 2) + '/' + N), '第 2 套得分 ' + (N - 2) + '/' + N + '：' + line);
  ok(v.wrongN === '2', '错题本 2 题：' + v.wrongN);
  ok((await evalJS('document.querySelectorAll(".pqopt.wrong").length')) === 2, '2 个错选标红');
  ok((await evalJS('document.querySelectorAll("#paperNav button.bad").length')) === 2, '总览里 2 个题号变红');
  ok((await evalJS('document.querySelectorAll("#paperNav button.ok").length')) === N - 2, '其余题号保持绿色');
  await shot('shot-paper-wrong.png');
  const before = fs.readdirSync(DL).filter(f => f.endsWith('.txt')).length;
  await evalJS('document.getElementById("exportBtn").click(); true');
  await sleep(1500);
  ok(fs.readdirSync(DL).filter(f => f.endsWith('.txt')).length === before + 1, '错题卷另存一份 txt');

  console.log('\n[6] 再练错题');
  await evalJS('document.getElementById("retryWrongBtn").click(); true');
  await sleep(500);
  v = await viewState();
  ok(v.paperCount === 2, '错题卷只有 2 题：' + v.paperCount);
  ok(/错题专练 · 2 题/.test(v.head), '卷头为错题专练');
  struct = await paperStructure();
  ok(struct.map(x => x.id).sort().join(',') === wrongIds.slice().sort().join(','), '错题卷题号正确');
  for (const id of wrongIds) await pick(id, true);
  await evalJS('document.getElementById("submitPaperBtn").click(); true');
  await sleep(500);
  v = await viewState();
  ok(v.score.replace(/\n/g, ' ').includes('2/2'), '错题重练 2/2');

  async function answerDrillCorrect() {
    const info = await evalJS(`(() => ({
      q: document.getElementById('qText').textContent,
      opts: [...document.querySelectorAll('#opts .opt')].map(b => b.querySelector('.otext').textContent.trim())
    }))()`);
    const q = BANK.find(x => x.q === info.q);
    if (!q) return null;
    const pos = info.opts.findIndex(t => t === q.opts[q.ans]);
    await evalJS(`document.querySelectorAll('#opts .opt')[${pos}].click(); true`);
    return q.id;
  }

  console.log('\n[7] 逐题闯关 + 键盘 + 回看');
  await evalJS('document.getElementById("tabDrill").click(); true');
  await sleep(400);
  v = await viewState();
  ok(!v.paperVisible && v.drillVisible, '切到逐题闯关');
  const drill = await evalJS(`(() => {
    const opts = [...document.querySelectorAll('#opts .opt')].map(b => ({ t: b.querySelector('.otext').textContent.trim(), l: b.querySelector('.letter').textContent.trim() }));
    return { q: document.getElementById('qText').textContent, opts };
  })()`);
  const dm = String(await evalJS('document.getElementById("qId").textContent') || '').match(/(\d+)/);
  const bankQ = dm ? BY_ID.get(Number(dm[1])) : null;
  ok(!!bankQ && drill.q.length > 0, '题目来自题库：' + (dm ? dm[0] : '?'));
  ok(!!bankQ && drill.opts.length === bankQ.opts.length, '选项数与题库一致：' + drill.opts.length);
  if (bankQ) {
    const pos = drill.opts.findIndex(o => o.t === bankQ.opts[bankQ.ans]);
    ok(pos >= 0, '正确选项已渲染');
    const letter = 'abcdefgh'[pos];
    await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${letter}', bubbles: true })); true`);
    const fb = await evalJS('document.getElementById("fb").hidden ? "" : document.getElementById("fb").innerText');
    ok(/回答正确/.test(fb), '键盘作答判定：' + fb.split('\n')[0]);
  }
  ok((await evalJS('document.getElementById("prevBtn").hidden')) === true, '第一题时没有上一题');
  await evalJS('document.getElementById("nextBtn").click(); true');
  await sleep(300);
  const secondText = await evalJS('document.getElementById("qText").textContent');
  await answerDrillCorrect();
  ok((await evalJS('document.getElementById("prevBtn").hidden')) === false, '第二题答完后出现上一题');
  const firstText = drill.q;
  await evalJS('document.getElementById("prevBtn").click(); true');
  await sleep(300);
  const back = await evalJS(`(() => ({
    q: document.getElementById('qText').textContent,
    fb: document.getElementById('fb').hidden ? '' : document.getElementById('fb').innerText,
    disabled: document.querySelectorAll('#opts .opt:disabled').length
  }))()`);
  ok(back.q === firstText, '上一题回到上一道题');
  ok(/回看模式/.test(back.fb), '回看显示当时的判题结果');
  ok(back.disabled > 0, '回看时选项锁定');
  await evalJS('document.getElementById("nextBtn").click(); true');
  await sleep(300);
  ok((await evalJS('document.getElementById("qText").textContent')) === secondText, '下一题回到刚才那题');

  await send('Page.reload');
  await sleep(900);
  v = await viewState();
  ok(v.drillVisible && !v.paperVisible, '刷新后保持逐题闯关');

  console.log('\n[8] 移动端与控制台');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalJS('document.getElementById("tabPaper").click(); true');
  await sleep(500);
  await shot('shot-mobile.png');
  const noOverflow = await evalJS('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2');
  ok(noOverflow, '移动端无横向溢出');

  const errors = events.filter(e => e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
  ok(errors.length === 0, '无 JS/控制台错误（' + errors.length + '）');
  errors.slice(0, 3).forEach(e => console.log(JSON.stringify(e).slice(0, 400)));

  console.log('\n截图: ' + OUT);
  console.log('RESULT: ' + (fails ? fails + ' failure(s)' : 'ALL PASS'));
  ws.close();
  chrome.kill();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
