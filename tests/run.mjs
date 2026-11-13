#!/usr/bin/env node
// 통합 테스트 실행기. 세 종류의 테스트를 한 명령으로 돌린다.
//
//   node   tests/*.js 중 require()를 쓰는 것   — Node만 있으면 된다(모의 DOM/GPU).
//   browser tests/*.js 중 나머지(개발자 콘솔용) — 실제 앱(index.html)을 Playwright Chromium에서 열고 붙여 넣듯 실행한다.
//          + tests/gpu-validation.html        — 실제 WebGL2 검사(SwiftShader). 기존 콘솔 사용법은 그대로 둔다.
//   py     tests/*-regression.py              — Python + Playwright(python 패키지)로 실행한다.
//
// 사용법
//   npm test                      세 묶음 모두
//   npm run test:node             node 묶음만 (설치 없이 바로 됨)
//   node tests/run.mjs browser py 고른 묶음만
//   node tests/run.mjs --grep=undo  파일 이름에 undo가 들어간 테스트만
//   --strict   준비되지 않아 건너뛴 묶음(SKIP)도 실패로 친다(CI용)
//   --jobs=N   동시에 돌릴 개수(기본: node 묶음은 CPU 수, 브라우저 묶음은 3)
//   --list     실행하지 않고 분류만 보여 준다
//
// 콘솔용 테스트는 끝날 때까지 console.error나 잡히지 않은 오류(pageerror)가 한 번이라도 나오면 실패로 친다.
// 콘솔용 테스트는 테스트마다 새 브라우저 컨텍스트(빈 localStorage·IndexedDB)에서 돌므로 사용자의 작업 초안을 건드리지 않는다.
import {spawn} from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");
const SUITES = ["node", "browser", "py"];
// 테스트가 아니라 다른 파일이 불러 쓰는 도우미
const HELPERS = new Set(["gpu-validation.js", "run.mjs", "esm-vm-bridge.cjs", "esm_for_browser.py"]);

// ---- 인자 ----
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const chosen = argv.filter(a => !a.startsWith("--"));
for(const name of chosen) if(!SUITES.includes(name)) { console.error(`알 수 없는 묶음: ${name} (가능: ${SUITES.join(", ")})`); process.exit(2); }
const suites = chosen.length ? chosen : SUITES;
const grep = option("grep"), strict = flag("strict"), jobs = Number(option("jobs")) || 0;

// ---- 분류 ----
const files = fs.readdirSync(TESTS).filter(name => !HELPERS.has(name)).sort();
const matches = name => !grep || name.includes(grep);
const nodeTests = [], consoleTests = [];
for(const name of files.filter(n => n.endsWith(".js"))) {
  (/\brequire\(/.test(fs.readFileSync(path.join(TESTS, name), "utf8")) ? nodeTests : consoleTests).push(name);
}
const pyTests = files.filter(n => n.endsWith("-regression.py"));
const plan = {
  node: nodeTests.filter(matches),
  browser: [...consoleTests, "gpu-validation.html"].filter(matches),
  py: pyTests.filter(matches)
};

if(flag("list")) {
  for(const suite of SUITES) console.log(`${suite} (${plan[suite].length})\n${plan[suite].map(n => `  ${n}`).join("\n")}`);
  process.exit(0);
}

// ---- 결과 기록 ----
const results = [];   // {suite, name, status:"PASS"|"FAIL"|"SKIP", ms, output}
const record = (suite, name, status, ms, output = "") => {
  results.push({suite, name, status, ms, output});
  const time = ms == null ? "" : ` (${(ms / 1000).toFixed(1)}s)`;
  console.log(`  ${status} ${name}${time}`);
  if(status === "FAIL" && output) console.log(indent(tail(output, 40)));
};
const tail = (text, lines) => { const rows = text.trimEnd().split(/\r?\n/); return (rows.length > lines ? ["…", ...rows.slice(-lines)] : rows).join("\n"); };
const indent = text => text.split("\n").map(line => `      ${line}`).join("\n");
const skipSuite = (suite, reason) => { console.log(`  SKIP ${suite} 묶음 전체 — ${reason}`); for(const name of plan[suite]) results.push({suite, name, status:"SKIP", ms:null, output:reason}); };

// 정해진 개수만큼 동시에 돌린다. 출력 순서는 끝난 순서.
const pool = async (items, size, work) => {
  let next = 0;
  await Promise.all(Array.from({length:Math.max(1, Math.min(size, items.length))}, async () => { while(next < items.length) await work(items[next++]); }));
};

// 프로세스를 띄워 출력과 종료 코드를 모은다.
const run = (command, args, {timeout = 180_000, env = {}} = {}) => new Promise(resolve => {
  const started = Date.now(); let output = "", timedOut = false, done = false, child = null, timer = null;
  const finish = code => { if(done) return; done = true; clearTimeout(timer);
    resolve({code:timedOut ? -1 : code, output:timedOut ? `${output}\n시간 초과(${timeout / 1000}s)` : output, ms:Date.now() - started}); };
  try { child = spawn(command, args, {cwd:ROOT, env:{...process.env, ...env}, windowsHide:true}); }
  catch(error) { output = String(error); finish(-1); return; }
  timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
  child.stdout?.on("data", d => output += d); child.stderr?.on("data", d => output += d);
  // 실행 파일이 없으면(ENOENT) close 없이 error만 올 수 있다.
  child.on("error", error => { output += String(error); finish(-1); });
  child.on("close", code => finish(code ?? -1));
});

// ---- node 묶음 ----
const runNode = async () => {
  await pool(plan.node, jobs || Math.min(os.cpus().length, 8), async name => {
    const {code, output, ms} = await run(process.execPath, [path.join("tests", name)]);
    record("node", name, code === 0 ? "PASS" : "FAIL", ms, output);
  });
};

// ---- browser 묶음 ----
const TYPES = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".mjs":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon"};
const serve = () => new Promise(resolve => {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.resolve(ROOT, "." + (url.endsWith("/") ? url + "index.html" : url));
    if(file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (error, data) => {
      if(error) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {"Content-Type":TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control":"no-store"}); res.end(data);
    });
  });
  server.listen(0, "127.0.0.1", () => resolve(server));
});

const withTimeout = (promise, ms, label) => {
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: 시간 초과(${ms / 1000}s)`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const MEDIA_BROWSER_TESTS = new Set(["toolbar-browser-regression.js", "video-render-browser-regression.js", "recorder-audio-browser-regression.js", "video-render-media-browser-regression.js"]);
const runBrowser = async () => {
  let chromium;
  try { ({chromium} = await import("playwright")); }
  catch { skipSuite("browser", "playwright가 없습니다. `npm install` 후 `npx playwright install chromium`"); return; }
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || undefined,
      // 가짜 카메라 · 마이크(권한 창 없이 허용)와 사용자 동작 없는 재생: 미디어 입력 채널 테스트용(media-browser-regression.js)
      args:["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]});
  } catch(error) { skipSuite("browser", `Chromium을 띄우지 못했습니다(\`npx playwright install chromium\`): ${String(error.message).split("\n")[0]}`); return; }
  const server = await serve(), base = `http://127.0.0.1:${server.address().port}/`;
  try {
    const runOne = async name => {
      const started = Date.now(), logs = [], errors = [];
      const context = await browser.newContext({viewport:{width:1440, height:900}});
      // 첫 실행 안내(갤러리)가 모달로 뜨지 않게 한다. 나머지 저장소는 비어 있는 새 상태.
      await context.addInitScript(() => { try { if(!localStorage.getItem("field.onboarded.v1")) localStorage.setItem("field.onboarded.v1", "1"); } catch(_) { /* 저장소가 막혀도 테스트는 계속 */ } });
      const page = await context.newPage();
      page.on("console", message => {
        logs.push(`[${message.type()}] ${message.text()}`);
        if(message.type() === "error") errors.push(`[console.error] ${message.text()}`);
      });
      page.on("pageerror", error => { logs.push(`[pageerror] ${error.message}`); errors.push(`[pageerror] ${error.message}`); });
      try {
        if(name === "gpu-validation.html") {
          await page.goto(base + "tests/gpu-validation.html");
          await page.click("#run");
          await page.waitForFunction(() => !document.getElementById("run").disabled && /PASS \d+/.test(document.getElementById("summary").textContent), null, {timeout:300_000});
          const report = await page.inputValue("#report"), summary = await page.textContent("#summary");
          const failed = Number(/FAIL (\d+)/.exec(summary)?.[1] || 0);
          logs.push(report);
          if(failed) throw new Error(`${summary}\n${report.split("\n").filter(line => line.startsWith("FAIL")).join("\n")}`);
        } else {
          const source = fs.readFileSync(path.join(TESTS, name), "utf8");
          await page.goto(base + "index.html");
          await page.waitForFunction(() => window.shaderStudio && window.shaderPlayground, null, {timeout:30_000});
          // 개발자 콘솔에 붙여 넣은 것과 같게 전역 eval로 실행한다. async IIFE면 끝날 때까지 기다린다.
          await withTimeout(page.evaluate(async code => { await (0, eval)(code); }, source), 180_000, name);
          // 테스트가 실패를 .catch(console.error)로 삼키거나, 정리 단계의 실패를 console.error로만 남겨도 PASS가 되지 않게 한다.
          // 통과하는 테스트는 console.error를 내지 않는다(일부러 내는 경우가 생기면 console.warn을 쓴다).
          await page.waitForTimeout(50);
          if(errors.length) throw new Error(`테스트 중 오류 출력 ${errors.length}건:\n${errors.join("\n")}`);
        }
        record("browser", name, "PASS", Date.now() - started);
      } catch(error) {
        // 녹화 검사 실패는 영상 파일 자체를 남겨 외부 디코더로도 확인할 수 있게 한다.
        try {
          const recordings = await withTimeout(page.evaluate(async () => Promise.all((window.__recordingTestArtifacts || []).map(async ({blob, ...metadata}) => {
            const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = "";
            for(let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return {...metadata, type:blob.type, size:blob.size, base64:btoa(binary)};
          }))), 5000, "녹화 진단 저장");
          if(recordings.length) {
            const directory = path.join(ROOT, "test-results", "browser", `${path.basename(name, ".js")}-${Date.now()}`);
            fs.mkdirSync(directory, {recursive:true});
            recordings.forEach(({base64, type}, i) => fs.writeFileSync(path.join(directory, `recording-${i}.${type.startsWith("video/mp4") ? "mp4" : "webm"}`), Buffer.from(base64, "base64")));
            fs.writeFileSync(path.join(directory, "diagnostics.json"), JSON.stringify({test:name, browser:browser.version(), error:error.message,
              recordings:recordings.map(({base64: _base64, ...metadata}) => metadata)}, null, 2));
            logs.push(`녹화 진단 파일: ${path.relative(ROOT, directory)}`);
          }
        } catch(diagnosticError) { logs.push(`녹화 진단 저장 실패: ${diagnosticError.message}`); }
        record("browser", name, "FAIL", Date.now() - started, `${logs.join("\n")}\n${error.message}`);
      } finally {
        await context.close();
      }
    };
    // 영상을 인코딩하는 테스트(녹화 MediaRecorder · 영상 렌더링 WebCodecs)는 같은 브라우저의 미디어 인코더를 나눠 쓰면
    // 서로 프레임을 빼앗겨 실패할 수 있다(녹화가 한 프레임만 담김). 나머지를 병렬로 돌린 뒤 하나씩 따로 돌린다.
    const serial = plan.browser.filter(name => MEDIA_BROWSER_TESTS.has(name));
    await pool(plan.browser.filter(name => !serial.includes(name)), jobs || 3, runOne);
    await pool(serial, 1, runOne);
  } finally {
    server.close(); await browser.close();
  }
};

// ---- py 묶음 ----
// python 실행 파일 후보 가운데 playwright를 import할 수 있는 첫 번째를 쓴다.
const findPython = async () => {
  const candidates = [process.env.PYTHON, "python3", "python", process.platform === "win32" ? "py" : null].filter(Boolean);
  let bare = null;
  for(const command of candidates) {
    const version = await run(command, ["--version"], {timeout:15_000});
    if(version.code !== 0) continue;
    bare ??= command;
    if((await run(command, ["-c", "import playwright"], {timeout:15_000})).code === 0) return {command};
  }
  return {missing:bare ? `${bare}에 playwright가 없습니다. \`${bare} -m pip install -r requirements-test.txt\` 후 \`${bare} -m playwright install chromium\`` : "Python을 찾지 못했습니다(PYTHON 환경 변수로 지정 가능)"};
};

const runPy = async () => {
  const python = await findPython();
  if(python.missing) { skipSuite("py", python.missing); return; }
  // 테스트가 read_text()를 인코딩 없이 쓰므로 Windows(cp949)에서도 UTF-8로 읽게 한다.
  const env = {PYTHONUTF8:"1", PYTHONIOENCODING:"utf-8"};
  await pool(plan.py, jobs || 3, async name => {
    const {code, output, ms} = await run(python.command, [path.join("tests", name)], {timeout:300_000, env});
    record("py", name, code === 0 ? "PASS" : "FAIL", ms, output);
  });
};

// ---- 실행 ----
const runners = {node:runNode, browser:runBrowser, py:runPy};
const started = Date.now();
for(const suite of suites) {
  if(!plan[suite].length) continue;
  console.log(`\n▶ ${suite} (${plan[suite].length})`);
  await runners[suite]();
}

const count = status => results.filter(r => r.status === status).length;
const failed = results.filter(r => r.status === "FAIL"), skipped = results.filter(r => r.status === "SKIP");
console.log(`\n결과: PASS ${count("PASS")} · FAIL ${count("FAIL")} · SKIP ${count("SKIP")} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
if(failed.length) console.log(`실패:\n${failed.map(r => `  ${r.suite}/${r.name}`).join("\n")}`);
if(skipped.length) console.log(`건너뜀: ${[...new Set(skipped.map(r => r.suite))].join(", ")}${strict ? " (--strict: 실패로 처리)" : ""}`);
if(!results.length) console.log("실행한 테스트가 없습니다.");
process.exit(failed.length || (strict && skipped.length) || !results.length ? 1 : 0);
