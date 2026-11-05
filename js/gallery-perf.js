// 갤러리 성능 배지: 예제마다 "이 컴퓨터에서 1920×1080 한 프레임을 그리는 데 걸리는 시간"을 어림해 단계로 보여 준다.
// 재는 법(동기식, 간단하지만 GPU 시간을 꽤 잘 따라간다):
//  · 작은 오프스크린 버퍼(W×H)에 예제 패스를 여러 번 그리고 readPixels(1픽셀)로 GPU가 끝날 때까지 기다린 시간을 잰다.
//  · 아무것도 안 하는 셰이더로 같은 방법을 써서 고정 비용(호출·동기화)을 빼고, 픽셀 수 비율로 1080p 시간으로 늘린다.
//  · 패스는 실제로 칠하는 픽셀 수로 따진다(scale·고정 크기). 다중 패스 예제는 패스 시간을 더한다.
// 같은 GPU에서도 드라이버·발열·다른 탭에 따라 값이 흔들리므로 "대략적인 단계"로만 보여 준다.
// 렌더링 상태는 건드린 것을 되돌리지 않는다 — 갤러리 썸네일 전용 임시 컨텍스트에서만 쓴다.
// readPixels는 같은 GPU를 쓰는 다른 그리기(메인 뷰포트)까지 기다리므로, 재는 동안 메인 미리보기를 잠깐 멈춘다(gallery.js).
const REFERENCE = { width: 1920, height: 1080 };
const REFERENCE_PIXELS = REFERENCE.width * REFERENCE.height;
// 단계 기준(ms/프레임, 1080p): 60fps = 16.7ms 예산 안에서 여유 있게 / 빠듯하게 / 넘침.
const LEVELS = Object.freeze([
  { max: 4, id: "light", label: "가벼움" },
  { max: 12, id: "medium", label: "보통" },
  { max: 33, id: "heavy", label: "무거움" },
  { max: Infinity, id: "extreme", label: "매우 무거움" },
]);
const levelOf = ms => LEVELS.find(level => ms < level.max);
// 패스 하나가 1080p 화면 기준으로 칠하는 픽셀 수(Image는 화면 전체).
const passPixels = (pass = {}) =>
  Array.isArray(pass.size) ? pass.size[0] * pass.size[1] : REFERENCE_PIXELS * (pass.scale ?? 1) ** 2;
// samples: [{ ms: 한 번 그리는 시간, measured: 잰 픽셀 수, pixels: 1080p에서 칠할 픽셀 수 }], baseline: 빈 셰이더 시간
const estimateFrameMs = (samples, baseline = 0) =>
  samples.reduce((total, s) => total + (Math.max(0, s.ms - baseline) * s.pixels) / s.measured, 0);
const isSoftware = renderer => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer || "");
const describe = ms => {
  const level = levelOf(ms),
    fps = ms > 0 ? Math.min(999, Math.round(1000 / ms)) : 999;
  return {
    level: level.id,
    label: level.label,
    title:
      `성능: ${level.label} — 이 컴퓨터에서 ${REFERENCE.width}×${REFERENCE.height} 한 프레임 약 ${ms < 0.1 ? "0.1" : ms.toFixed(ms < 10 ? 1 : 0)}ms` +
      ` (약 ${fps}fps 상당, 갤러리를 열 때 잰 어림값)`,
  };
};
// 측정기: 같은 GL 컨텍스트에서 프로그램 하나를 W×H로 그리는 시간을 잰다.
const createMeter = (gl, { width = 640, height = 360, now = () => performance.now(), budgetMs = 8 } = {}) => {
  const target = gl.createTexture(),
    framebuffer = gl.createFramebuffer(),
    dummy = gl.createTexture(),
    pixel = new Uint8Array(4);
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  // iChannel 자리에 꽂을 1×1 검은 텍스처(버퍼·키보드·이미지 입력 대신)
  gl.bindTexture(gl.TEXTURE_2D, dummy);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  // prepare(): useProgram·Uniform 설정. 처음 두 번은 버린다(드라이버가 첫 실행 때 셰이더를 마저 준비하는 비용이 섞인다).
  // 그다음 예산(budgetMs) 안에서 여러 번 그린 평균을 두 번 재 작은 쪽을 쓴다(다른 일이 끼어든 쪽을 버린다).
  const time = prepare => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, width, height);
    for (let unit = 0; unit < 4; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, dummy);
    }
    gl.activeTexture(gl.TEXTURE0);
    prepare({ width, height });
    const round = count => {
      const start = now();
      for (let i = 0; i < count; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
      sync();
      return (now() - start) / count;
    };
    round(1);
    round(1);
    const once = round(1),
      count = Math.max(1, Math.min(64, Math.floor(budgetMs / Math.max(once, 0.02))));
    const ms = Math.min(once, round(count), round(count));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ms;
  };
  const dispose = () => {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(target);
    gl.deleteTexture(dummy);
  };
  return { time, dispose, pixels: width * height };
};
export { REFERENCE, LEVELS, levelOf, passPixels, estimateFrameMs, isSoftware, describe, createMeter };
