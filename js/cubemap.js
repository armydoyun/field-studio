// 큐브맵: 이미지 한 장을 6면 큐브맵(samplerCube)으로 바꾸는 규칙. GPU · DOM과 무관한 순수 함수라 node에서 검사한다.
// 이미지 비율로 배치를 알아본다.
//   4:3 가로 십자   ·  +Y  ·  ·        3:4 세로 십자   ·  +Y  ·
//                  -X  +Z  +X  -Z                    -X  +Z  +X
//                   ·  -Y  ·   ·                      ·  -Y  ·
//                                                     ·  -Z  ·   (-Z는 180° 돌려 놓인 것)
//   6:1 가로 띠 / 1:6 세로 띠: +X -X +Y -Y +Z -Z 차례
//   2:1 등장방형(360° 파노라마): 가운데가 -Z(앞), 오른쪽 1/4 지점이 +X, 위가 +Y
// 각 면은 OpenGL · Shadertoy 큐브맵의 면 방향 그대로다(면 이미지의 위쪽 줄이 t = 0).
const FACES = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
const near = (a, b) => Math.abs(a - b) < 0.02;

// 배치: {kind, size, faces: [{x, y, rotate}](FACES 차례, 원본 이미지 픽셀 기준 왼쪽 위)} 또는 {kind: null, reason}
const layoutOf = (width, height) => {
  const ratio = width / height;
  const cells = (size, places, rotate = []) =>
    places.map(([cx, cy], i) => ({ x: cx * size, y: cy * size, rotate: rotate.includes(i) ? 180 : 0 }));
  if (near(ratio, 4 / 3)) {
    const size = Math.floor(width / 4);
    // FACES 차례: +X -X +Y -Y +Z -Z
    return {
      kind: "cross",
      size,
      faces: cells(size, [
        [2, 1],
        [0, 1],
        [1, 0],
        [1, 2],
        [1, 1],
        [3, 1],
      ]),
    };
  }
  if (near(ratio, 3 / 4)) {
    const size = Math.floor(width / 3);
    return {
      kind: "cross-vertical",
      size,
      faces: cells(
        size,
        [
          [2, 1],
          [0, 1],
          [1, 0],
          [1, 2],
          [1, 1],
          [1, 3],
        ],
        [5]
      ),
    };
  }
  if (near(ratio, 6)) {
    const size = height;
    return {
      kind: "strip",
      size,
      faces: cells(
        size,
        FACES.map((_, i) => [i, 0])
      ),
    };
  }
  if (near(ratio, 1 / 6)) {
    const size = width;
    return {
      kind: "strip-vertical",
      size,
      faces: cells(
        size,
        FACES.map((_, i) => [0, i])
      ),
    };
  }
  if (near(ratio, 2)) return { kind: "equirect", size: Math.min(1024, Math.max(1, Math.floor(width / 4))), faces: [] };
  return {
    kind: null,
    reason: `큐브맵으로 쓸 수 없는 비율입니다(${width}×${height}). 4:3 · 3:4 십자, 6:1 · 1:6 띠, 2:1 파노라마만 됩니다.`,
  };
};

// 면 face(0~5)의 텍셀 (s, t)(0~1, t = 0이 면 이미지의 위쪽)가 가리키는 방향. OpenGL 큐브맵 규칙.
const faceDirection = (face, s, t) => {
  const sc = 2 * s - 1,
    tc = 2 * t - 1;
  switch (face) {
    case 0:
      return [1, -tc, -sc];
    case 1:
      return [-1, -tc, sc];
    case 2:
      return [sc, 1, tc];
    case 3:
      return [sc, -1, -tc];
    case 4:
      return [sc, -tc, 1];
    default:
      return [-sc, -tc, -1];
  }
};
// 방향 → 등장방형 이미지 좌표 (u, v)(0~1, v = 0이 위). -Z가 가운데(u = 0.5), +X가 u = 0.75, 위(+Y)가 v = 0.
const equirectUV = ([x, y, z]) => {
  const length = Math.hypot(x, y, z) || 1;
  return [0.5 + Math.atan2(x, -z) / (2 * Math.PI), Math.acos(Math.max(-1, Math.min(1, y / length))) / Math.PI];
};
// 등장방형 RGBA 픽셀(위쪽 줄부터)에서 한 면(size×size)을 이중선형으로 뽑는다.
const equirectFace = (pixels, width, height, face, size) => {
  const out = new Uint8ClampedArray(size * size * 4);
  const read = (x, y, c) => pixels[(y * width + x) * 4 + c];
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const [u, v] = equirectUV(faceDirection(face, (i + 0.5) / size, (j + 0.5) / size));
      const fx = u * width - 0.5,
        fy = Math.max(0, Math.min(height - 1, v * height - 0.5));
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy),
        ax = fx - x0,
        ay = fy - y0;
      const xa = ((x0 % width) + width) % width,
        xb = (xa + 1) % width,
        ya = y0,
        yb = Math.min(height - 1, y0 + 1);
      for (let c = 0; c < 4; c++) {
        const top = read(xa, ya, c) * (1 - ax) + read(xb, ya, c) * ax,
          bottom = read(xa, yb, c) * (1 - ax) + read(xb, yb, c) * ax;
        out[(j * size + i) * 4 + c] = top * (1 - ay) + bottom * ay;
      }
    }
  return out;
};

export { FACES, layoutOf, faceDirection, equirectUV, equirectFace };
