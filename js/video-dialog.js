// 영상 렌더링 대화상자: 캡처 메뉴의 "영상 렌더링…"으로 연다. 설정을 받아 video-render.js로 렌더링하고 파일을 내려받는다.
// 렌더링 중에는 설정을 잠그고 진행률·남은 시간을 보인다. Esc·취소는 렌더링을 멈추고(파일 없음) 대화상자는 열어 둔다.
import * as Video from "./video-render.js";
import * as PreviewDOM from "./preview-dom.js";

const formatTime = seconds => {
  const total = Math.max(0, Math.round(seconds)),
    m = Math.floor(total / 60),
    s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
};
const formatBytes = bytes =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : bytes >= 1e6
      ? `${(bytes / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

// renderer: renderer.js 공개 API · download(blob, name) · isBusy() → 녹화 중이면 이유 문자열 · onDone(message)
const mount = ({ renderer, download, isBusy = () => "", onDone = () => {}, signal }) => {
  const $ = PreviewDOM.createLookup();
  const dialog = $("videoRenderDialog"),
    fields = $("videoRenderFields"),
    summary = $("videoRenderSummary"),
    startButton = $("videoRenderStart"),
    cancelButton = $("videoRenderCancel");
  const listen = (el, type, fn) => el.addEventListener(type, fn, { signal });
  let running = null, // AbortController
    supported = { "mp4-h264": null, "webm-vp9": null, "webm-vp8": null, png: "png" },
    probed = false;
  const hasBuffers = () => (renderer.getShaderReflection?.().passes?.length || 0) > 0;
  const gpuLimit = () => {
    const caps = renderer.getCapabilities?.();
    return Math.min(caps?.maxTextureSize || 4096, caps?.maxRenderbufferSize || 4096, 8192);
  };
  const screenSize = () => {
    const { width, height } = renderer.getStats();
    return { width: width - (width % 2), height: height - (height % 2) };
  };
  const size = () => {
    const choice = $("videoSize").value;
    if (choice === "screen") return screenSize();
    if (choice === "custom") return { width: Number($("videoWidth").value), height: Number($("videoHeight").value) };
    const [width, height] = choice.split("x").map(Number);
    return { width, height };
  };
  const read = () =>
    Video.normalizeSettings(
      {
        start: $("videoStart").value === "" ? 0 : Number($("videoStart").value),
        duration: Number($("videoDuration").value),
        fps: Number($("videoFps").value),
        format: $("videoFormat").value,
        quality: $("videoQuality").value,
        ...size(),
      },
      { limit: gpuLimit() }
    );
  // 설정이 바뀔 때마다 요약(프레임 수·크기·예상 용량)을 다시 쓰고, 잘못되면 이유를 보이고 시작을 막는다.
  const refresh = () => {
    if (running) return;
    const custom = $("videoSize").value === "custom";
    for (const node of dialog.querySelectorAll(".video-custom-size")) node.hidden = !custom;
    $("videoQualityField").hidden = $("videoFormat").value === "png";
    const screen = screenSize();
    $("videoSize").options[0].textContent = `지금 화면 · ${screen.width} × ${screen.height}`;
    const busy = isBusy();
    try {
      const s = read();
      const unsupported = s.format !== "png" && probed && !supported[s.format];
      // 시작 전 비용: 결과 크기 · 출력 프레임 · 버퍼 준비 프레임(시작 시간 × fps). 한도를 넘으면 시작하지 않는다.
      const budget = Video.assessBudget(s, { hasBuffers: hasBuffers() }),
        blocked = budget.problems.length > 0;
      const base = `${s.frames.toLocaleString("ko-KR")}프레임 · ${s.width} × ${s.height} · ${s.fps}fps · ${formatTime(s.duration)} · 예상 ${s.format === "png" ? "약 " : ""}${formatBytes(budget.bytes)}${s.format === "png" ? "(그림에 따라 다름)" : ""}`;
      const warmupText = budget.warmup
        ? ` · 버퍼 준비 ${budget.warmup.toLocaleString("ko-KR")}프레임을 먼저 그림(저장 안 함)`
        : "";
      const notes = [...budget.problems, ...budget.warnings].map(item =>
        item.code === "bytes"
          ? budget.problems.includes(item)
            ? `결과가 ${formatBytes(item.limit)}를 넘어 렌더링할 수 없습니다. 길이·크기·FPS를 줄이거나 시작 시간을 나눠 여러 번 렌더링하세요.`
            : `결과가 ${formatBytes(item.limit)}를 넘습니다. 끝날 때까지 메모리에 모았다가 내려받으므로 메모리가 부족할 수 있습니다.`
          : budget.problems.includes(item)
            ? `버퍼 준비 프레임이 한도 ${item.limit.toLocaleString("ko-KR")}개를 넘습니다. 시작 시간이나 FPS를 줄이세요.`
            : "시작 시간이 길어 버퍼 준비에 시간이 걸립니다."
      );
      summary.classList.toggle("is-invalid", unsupported || !!busy || blocked);
      summary.textContent = busy
        ? busy
        : unsupported
          ? `이 브라우저는 ${Video.FORMATS[s.format].label} 인코딩(WebCodecs)을 지원하지 않습니다. PNG 연속 이미지를 고르세요.`
          : `${base}${warmupText}${notes.length ? `\n${notes.join(" ")}` : ""}`;
      startButton.disabled = unsupported || !!busy || blocked;
      return blocked ? null : s;
    } catch (error) {
      summary.classList.add("is-invalid");
      summary.textContent = error.message;
      startButton.disabled = true;
      return null;
    }
  };
  const probe = async () => {
    try {
      supported = await Video.probeFormats();
    } catch (_) {
      supported = { "mp4-h264": null, "webm-vp9": null, "webm-vp8": null, png: "png" };
    }
    probed = true;
    dialog.dataset.probed = "true"; // 인코더 지원 조사가 끝났다(테스트 · 확장이 형식 목록을 믿고 읽을 수 있다)
    for (const option of $("videoFormat").options) {
      const ok = !!supported[option.value];
      option.disabled = !ok;
      option.textContent = option.textContent.replace(/ · 지원 안 됨$/, "") + (ok ? "" : " · 지원 안 됨");
    }
    // 고른 형식을 쓸 수 없으면 쓸 수 있는 첫 형식으로 바꾼다.
    if (!supported[$("videoFormat").value])
      $("videoFormat").value = [...$("videoFormat").options].find(o => !o.disabled)?.value || "png";
    refresh();
  };
  const setRunning = on => {
    fields.disabled = on;
    dialog.dataset.state = on ? "running" : "idle";
    startButton.disabled = on;
    startButton.textContent = on ? "렌더링 중…" : "렌더링 시작";
    cancelButton.firstChild.textContent = on ? "렌더링 취소 " : "닫기 ";
  };
  const showProgress = (fraction, text) => {
    $("videoRenderProgressBox").hidden = false;
    $("videoRenderProgress").value = fraction;
    $("videoRenderStatus").textContent = text;
  };
  const start = async () => {
    const s = refresh();
    if (!s || running) return;
    const controller = new AbortController(),
      began = performance.now();
    running = controller;
    setRunning(true);
    showProgress(0, "준비 중…");
    let renderStarted = 0;
    try {
      const result = await Video.render({
        renderer,
        settings: s,
        hasBuffers: hasBuffers(),
        signal: controller.signal,
        onProgress: ({ phase, done, total, tiles = 1 }) => {
          if (phase === "warmup") showProgress(0, `버퍼 준비 중 · 0초부터 시작 시간까지 ${done} / ${total}프레임`);
          else if (phase === "render") {
            renderStarted ||= performance.now();
            const elapsed = (performance.now() - renderStarted) / 1000,
              left = done > 1 ? (elapsed / done) * (total - done) : NaN;
            showProgress(
              done / total,
              `${done.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}프레임 · 경과 ${formatTime((performance.now() - began) / 1000)}${Number.isFinite(left) ? ` · 남은 약 ${formatTime(left)}` : ""}${tiles > 1 ? ` · 프레임마다 타일 ${tiles}개로 나눠 그림` : ""}`
            );
          } else showProgress(1, "파일 만드는 중…");
        },
      });
      download(result.blob, result.name);
      const message = `저장함: ${result.name} · ${formatBytes(result.blob.size)}${result.audio ? " · 소리 포함" : ""} · ${formatTime((performance.now() - began) / 1000)} 걸림`;
      showProgress(1, message);
      onDone(message);
    } catch (error) {
      if (error.name === "AbortError") showProgress(0, "렌더링을 취소했습니다. 파일은 만들지 않았습니다.");
      else {
        showProgress(0, `렌더링 실패: ${error.message}`);
        console.warn("영상 렌더링 실패", error);
      }
    } finally {
      running = null;
      setRunning(false);
      refresh();
    }
  };
  const open = () => {
    if (!dialog.open) {
      globalThis.shaderPopout?.place?.(dialog); // 분리 창이 열려 있으면 요청한 창에 띄운다
      dialog.showModal();
    }
    $("videoRenderProgressBox").hidden = true;
    refresh();
    if (!probed) probe();
    startButton.focus();
  };
  const close = () => {
    if (running) running.abort();
    else dialog.close();
  };
  listen($("videoRenderOpen"), "click", open);
  listen($("videoRenderForm"), "submit", event => {
    event.preventDefault();
    start();
  });
  listen($("videoRenderForm"), "input", refresh);
  listen($("videoRenderForm"), "change", refresh);
  listen($("videoSize"), "change", () => {
    if ($("videoSize").value !== "custom") return;
    // 직접 입력으로 바꾸면 지금 화면 크기로 채워 둔다.
    const screen = screenSize();
    $("videoWidth").value = String(screen.width);
    $("videoHeight").value = String(screen.height);
    refresh();
  });
  listen(cancelButton, "click", close);
  listen($("videoRenderClose"), "click", close);
  // Esc: 렌더링 중이면 취소만 하고 닫지 않는다(진행 결과를 볼 수 있게).
  listen(dialog, "cancel", event => {
    if (!running) return;
    event.preventDefault();
    running.abort();
  });
  signal?.addEventListener("abort", () => running?.abort());
  return { open, close, isRunning: () => !!running };
};

export { mount, formatTime, formatBytes };
