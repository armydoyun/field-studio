// 지연 렌더링 도우미: 갤러리 썸네일·성능 배지와 코드 조각 미리보기가 같이 쓴다.
// 예제·조각이 많아지면 "목록을 여는 순간 전부 컴파일하고 그리기"가 브라우저를 멈추게 한다. 그래서
//  · 화면에 보이는(또는 곧 보일) 카드만 그린다 — IntersectionObserver
//  · 셰이더 컴파일은 브라우저가 뒤에서 하게 두고 끝났는지만 프레임마다 확인한다 — KHR_parallel_shader_compile
//    (없는 브라우저는 컴파일을 기다리지만, 프레임당 하나만 처리해 한 번에 길게 멈추지 않는다)
//  · 한 프레임에 하나씩 처리한다 — nextFrame()
const nextFrame = () =>
  new Promise(resolve =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => resolve()) : setTimeout(resolve, 16)
  );
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// 셰이더 프로그램을 비동기로 만든다. 성공하면 { program }, 실패하면 { program: null, log }.
// getProgramParameter(LINK_STATUS)는 컴파일이 끝날 때까지 메인 스레드를 막으므로, 끝났다고 알려 줄 때(COMPLETION_STATUS)만 묻는다.
const compileProgram = async (gl, vertexShader, fragment, { signal } = {}) => {
  const parallel = gl.getExtension("KHR_parallel_shader_compile"),
    fs = gl.createShader(gl.FRAGMENT_SHADER),
    program = gl.createProgram();
  gl.shaderSource(fs, fragment);
  gl.compileShader(fs);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (parallel)
    while (!gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
      if (signal?.aborted || gl.isContextLost()) break;
      await wait(16);
    }
  const ok = !signal?.aborted && !gl.isContextLost() && gl.getProgramParameter(program, gl.LINK_STATUS),
    log = ok ? "" : gl.getProgramInfoLog(program) || gl.getShaderInfoLog(fs) || "";
  gl.deleteShader(fs);
  if (ok) return { program };
  gl.deleteProgram(program);
  return { program: null, log };
};

// 보일 때만 일을 하는 대기열. add(element, job)로 넣으면, element가 화면 근처(margin)에 들어온 것부터 한 프레임에 하나씩
// job()을 기다리며(await) 처리한다. 화면 밖으로 나간 것은 처리하지 않고 다시 보일 때까지 남겨 둔다.
// add는 element를 DOM에 붙이기 전에 불러도 된다(다음 프레임에 붙었는지 보고 관찰을 시작한다).
// 처리했거나 DOM에서 떨어진(목록을 다시 그린) element는 관찰을 멈추고 버린다.
// pause()/resume()으로 멈추고 이어 갈 수 있다(갤러리를 닫았다 다시 열 때). onIdle(남은 수)은 보이는 일을 다 했을 때 부른다.
const createVisibleQueue = ({ margin = "200px", onIdle = () => {} } = {}) => {
  const jobs = new Map(), // element → job
    visible = new Set();
  let running = false,
    paused = false,
    disposed = false;
  const Observer = typeof IntersectionObserver === "function" ? IntersectionObserver : null;
  const observer = Observer
    ? new Observer(
        entries => {
          for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target);
            else visible.delete(entry.target);
          }
          pump();
        },
        { rootMargin: margin }
      )
    : null;
  const drop = element => {
    jobs.delete(element);
    visible.delete(element);
    observer?.unobserve(element);
  };
  // 화면 위쪽(문서 순서상 먼저)부터 처리한다.
  const nextJob = () => {
    let first = null;
    for (const element of visible) {
      if (!jobs.has(element)) continue;
      if (!element.isConnected) {
        drop(element);
        continue;
      }
      if (!first || first.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING) first = element;
    }
    return first;
  };
  const pump = async () => {
    if (running || paused || disposed) return;
    running = true;
    try {
      for (let element = nextJob(); element && !paused && !disposed; element = nextJob()) {
        const job = jobs.get(element);
        drop(element);
        try {
          await job();
        } catch (error) {
          console.warn("지연 렌더링 실패", error);
        }
        await nextFrame();
      }
    } finally {
      running = false;
    }
    if (paused || disposed) return;
    if (nextJob())
      pump(); // 마지막 일을 하는 동안 새로 보인 것
    else onIdle(jobs.size);
  };
  // DOM에 붙을 때까지 몇 프레임 기다렸다 관찰한다. 끝내 붙지 않으면 버린다.
  const watch = (element, tries = 30) => {
    if (disposed || !jobs.has(element)) return;
    if (element.isConnected) {
      if (observer) observer.observe(element);
      else {
        visible.add(element); // IntersectionObserver가 없으면 모두 보이는 것으로 본다
        pump();
      }
    } else if (tries > 0) requestAnimationFrame(() => watch(element, tries - 1));
    else jobs.delete(element);
  };
  const add = (element, job) => {
    if (disposed) return;
    jobs.set(element, job);
    watch(element);
  };
  return {
    add,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      pump();
    },
    get pending() {
      return jobs.size;
    },
    get busy() {
      return running;
    },
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      jobs.clear();
      visible.clear();
    },
  };
};
export { nextFrame, wait, compileProgram, createVisibleQueue };
