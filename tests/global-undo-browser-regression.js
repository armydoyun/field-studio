// Ctrl+Z · Ctrl+Y는 편집기 밖에서도 앱의 되돌리기 기록을 쓴다(편집 › 되돌리기 Ctrl+Z, 파라미터 안내 'Ctrl+Z로 되돌리기').
//  · 파라미터 값을 바꾼 뒤 바탕에서 Ctrl+Z → 이전 값, Ctrl+Y · Ctrl+Shift+Z → 다시 바꾼 값
//  · 글 입력 칸(파라미터 찾기)에서의 Ctrl+Z는 그 칸의 것이라 앱 기록을 건드리지 않는다
(async () => {
  const studio = window.shaderStudio,
    renderer = window.shaderPlayground,
    $ = id => document.getElementById(id);
  const test = (ok, label) => {
    if (!ok) throw new Error(`FAIL: ${label}`);
    console.log(`PASS: ${label}`);
  };
  const frames = (n = 2) => new Promise(resolve => { const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step)); step(); });
  const value = () => renderer.getUserUniforms().find(item => item.name === "uAmount")?.value;
  const press = (target, key, options = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true, ...options }));
  const before = studio.getProject();
  try {
    test(studio.setProject({ image: "#version 300 es\nprecision highp float;\nuniform float uAmount; // @range 0 1 @default 0.25\nout vec4 o;\nvoid main() { o = vec4(uAmount); }\n", passes: [], imageChannels: {} }), "파라미터 하나 있는 장면");
    await frames(4);
    test(value() === 0.25, "처음 값 0.25");
    studio.setParameterValues([{ ...renderer.getUserUniforms().find(item => item.name === "uAmount"), value: 0.75 }]);
    await frames(2);
    test(value() === 0.75, "값을 0.75로 바꿈");
    document.activeElement?.blur?.();
    press(document.body, "z");
    await frames(2);
    test(value() === 0.25, `바탕에서 Ctrl+Z → 이전 값(${value()})`);
    press(document.body, "y");
    await frames(2);
    test(value() === 0.75, `Ctrl+Y → 다시 바꾼 값(${value()})`);
    press(document.body, "z");
    await frames(2);
    press(document.body, "Z", { shiftKey: true });
    await frames(2);
    test(value() === 0.75, `Ctrl+Shift+Z도 다시 실행(${value()})`);
    const search = $("uniformSearch");
    if (search) {
      press(search, "z");
      await frames(2);
      test(value() === 0.75, "글 입력 칸의 Ctrl+Z는 앱 기록을 건드리지 않는다");
    }
  } finally {
    studio.setProject(before);
  }
  console.log("편집기 밖 되돌리기 검사 통과");
})();
