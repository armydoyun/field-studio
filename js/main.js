import * as CustomSelect from "./custom-select.js";
// 앱 조립 진입점. 범용 기본 GLSL과 Ray Marching 프리셋은 shader.js, GPU 렌더링은 renderer.js가 담당한다.
import * as Renderer from "./renderer.js";
import Shader from "./shader.js";
import * as UI from "./ui.js";
import * as Input from "./input.js";
import * as Settings from "./settings.js";
import * as Studio from "./studio.js";
import * as Profiler from "./profiler.js";
import * as Gallery from "./gallery.js";
import * as Guide from "./guide.js";
import * as Reference from "./glsl-reference.js";
import * as Snippets from "./snippets.js";
import * as Theme from "./theme.js";
import * as Popout from "./popout.js";
import * as WorkspaceLayout from "./workspace-layout.js";

// 테마는 WebGL 초기화와 무관하게 먼저 연결한다(렌더러가 실패해도 화면 테마 전환은 동작해야 한다).
window.shaderTheme = Theme.mount();
// 미리보기 분리 창(캔버스·상단 도구의 원본을 옮기므로 렌더러보다 먼저 연결해도 된다).
window.shaderPopout = Popout.mount();
// 설정 패널 자리·너비(렌더러와 무관하게 먼저 적용해 첫 화면부터 저장한 배치로 그린다).
window.shaderWorkspace = WorkspaceLayout.mount();

// 편집기 시그니처 힌트용 사전: "sin · cos · tan", "atan (2인수)"처럼 묶인 항목을 함수 이름별로 펼치고 같은 이름은 합친다.
const builtinDocs = new Map();
for (const item of Reference.ALL)
  for (const raw of item.name.split("·")) {
    const name = raw.replace(/\(.*\)/, "").trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const entry = builtinDocs.get(name);
    if (entry) {
      if (!entry.sig.includes(item.sig)) entry.sig += ` · ${item.sig}`;
    } else builtinDocs.set(name, { sig: item.sig, desc: item.desc });
  }
const lookup = name => builtinDocs.get(name) || null;
const builtins = [...builtinDocs].map(([name, doc]) => ({ name, ...doc }));
// 자동 완성에서 고를 수 있는 코드 조각 함수: 전역 함수 조각마다 마지막에 정의되는 함수(대표 함수) 이름으로 제안한다.
const libraryItems = Snippets.ALL.filter(item => !item.replace && (item.scope || "global") === "global")
  .map(item => {
    const names = Snippets.definedNames(item.code);
    return names.length ? { id: item.id, name: names[names.length - 1], title: item.title, desc: item.desc } : null;
  })
  .filter(Boolean);

const canvas = document.getElementById("screen"),
  status = document.getElementById("status");
let renderer = null,
  ui = null,
  input = null,
  settings = null,
  studio = null,
  profiler = null,
  gallery = null,
  guide = null;
const initialize = async () => {
  try {
    renderer = Renderer.createRenderer(canvas, Shader, message => {
      status.textContent = message;
      if (message) console.warn(message);
    });
    input = Input.mount(canvas, renderer);
    settings = Settings.mount(renderer);
    settings.load(); // 저장 설정의 사용자 Uniform 복원
    // 프로젝트 채널 연결을 복원하기 전에 지금 작업이 쓰는 이미지만 먼저 복구한다. 나머지는 앱이 뜬 뒤 이어서 복구한다.
    await renderer.restoreTextures({
      priority: Studio.savedTextureIds(),
      onProgress: detail => document.dispatchEvent(new CustomEvent("shader-textures-restored", { detail })),
    });
    ui = UI.mount(renderer, input, settings);
    studio = Studio.mount(renderer, Shader, settings, {
      lookup,
      builtins,
      snippets: { items: libraryItems, plan: Snippets.plan },
    });
    profiler = Profiler.mount(renderer);
    // 갤러리가 예제 성능을 재는 동안 메인 미리보기를 멈춘다(같은 GPU를 나눠 쓰면 측정이 크게 부푼다).
    gallery = Gallery.mount({
      studio,
      Shader,
      preview: {
        pause: () => {
          if (!renderer.getStats().running) return false;
          renderer.stop();
          return true;
        },
        resume: () => renderer.start(),
        // 성능 배지를 환산할 크기: 미리보기가 지금 실제로 그리는 크기(해상도 배율 반영)
        size: () => {
          const { width, height } = renderer.getStats();
          return { width, height };
        },
      },
    });
    guide = Guide.mount({ studio, gallery });
    renderer.start();
    status.textContent = "";
    // HTML 패널 없이도 사용자 설정과 키 이벤트를 직접 제어할 수 있다.
    window.shaderPlayground = renderer;
    window.shaderInput = input;
    window.shaderSettings = settings;
    window.shaderStudio = studio;
    window.addEventListener(
      "beforeunload",
      () => {
        guide?.dispose();
        gallery?.dispose();
        profiler?.dispose();
        studio?.dispose();
        settings?.dispose();
        ui?.dispose();
        input?.dispose();
        renderer?.dispose();
        delete window.shaderPlayground;
        delete window.shaderInput;
        delete window.shaderSettings;
        delete window.shaderStudio;
      },
      { once: true }
    );
  } catch (error) {
    guide?.dispose();
    gallery?.dispose();
    profiler?.dispose();
    studio?.dispose();
    settings?.dispose();
    ui?.dispose();
    input?.dispose();
    renderer?.dispose();
    console.error(error);
    status.textContent = error.message;
  }
};
initialize();

CustomSelect.mount();
