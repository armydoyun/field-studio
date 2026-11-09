// node tests/video-render-regression.js — 영상 렌더링(video-render.js): 설정 검사, WebM 먹서 구조, ZIP 구조·CRC,
// 그리고 렌더링 실행 순서(프레임 시간·키프레임·버퍼 준비·취소·정리)를 가짜 렌더러·인코더로 검사한다.
"use strict";
const path = require("path"), assert = require("assert"), zlib = require("zlib");
let passed = 0;
const check = (ok, label) => { assert.ok(ok, label); passed++; console.log("PASS", label); };
const throwsRange = (fn, pattern, label) => { assert.throws(fn, error => error instanceof RangeError && pattern.test(error.message)); passed++; console.log("PASS", label); };

// ---- 작은 EBML 읽기(검사용) ----
const readVint = (b, at, keepMarker = false) => {
  let len = 1;
  while (len <= 8 && !(b[at] & (0x80 >> (len - 1)))) len++;
  let v = keepMarker ? b[at] : b[at] & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[at + i];
  return { value: v, len };
};
const parse = (b, start = 0, end = b.length) => {
  const out = [];
  for (let at = start; at < end; ) {
    const id = readVint(b, at, true), size = readVint(b, at + id.len), body = at + id.len + size.len;
    out.push({ id: id.value, start: at, body, size: size.value, end: body + size.value });
    at = body + size.value;
  }
  assert.equal(out.at(-1)?.end ?? start, end, "EBML 요소가 경계에 딱 맞아야 한다");
  return out;
};
const uintOf = (b, e) => { let v = 0; for (let i = e.body; i < e.end; i++) v = v * 256 + b[i]; return v; };
const child = (b, e, id) => parse(b, e.body, e.end).filter(c => c.id === id);
const text = (b, e) => String.fromCharCode(...b.subarray(e.body, e.end));
const bytesOf = async parts => new Uint8Array(await new Blob(parts).arrayBuffer());

(async () => {
  const V = await import(path.join(__dirname, "../js/video-render.js"));

  // ---- 설정 ----
  const base = { start: 0, duration: 2, fps: 30, width: 1281, height: 721, format: "webm-vp9", quality: "high" };
  const s = V.normalizeSettings(base, { limit: 4096 });
  check(V.normalizeSettings({ ...base, format: undefined }).format === "mp4-h264", "기본 형식은 MP4(H.264)");
  check(s.width === 1280 && s.height === 720, "WebM은 짝수 크기로 내림");
  check(s.frames === 60 && s.duration === 2, "프레임 수 = 길이 × fps");
  check(s.bitrate === Math.round(1280 * 720 * 30 * V.QUALITY.high), "비트레이트 = 픽셀 × fps × 품질");
  const png = V.normalizeSettings({ ...base, format: "png" });
  check(png.width === 1281 && png.height === 721, "PNG는 홀수 크기 그대로");
  check(V.normalizeSettings({ ...base, duration: 1.01, fps: 24 }).frames === 24, "길이를 프레임 단위로 반올림");
  throwsRange(() => V.normalizeSettings({ ...base, fps: 29.97 }), /FPS/, "정수가 아닌 FPS 거절");
  throwsRange(() => V.normalizeSettings({ ...base, fps: 0 }), /FPS/, "FPS 0 거절");
  throwsRange(() => V.normalizeSettings({ ...base, duration: 0 }), /길이/, "길이 0 거절");
  throwsRange(() => V.normalizeSettings({ ...base, duration: 601 }), /길이/, "너무 긴 영상 거절");
  throwsRange(() => V.normalizeSettings({ ...base, start: -1 }), /시작/, "음수 시작 시간 거절");
  throwsRange(() => V.normalizeSettings({ ...base, width: 8000 }, { limit: 4096 }), /크기/, "GPU 한도 초과 거절");
  throwsRange(() => V.normalizeSettings({ ...base, width: 8 }), /크기/, "너무 작은 크기 거절");
  throwsRange(() => V.normalizeSettings({ ...base, format: "gif" }), /형식/, "모르는 형식 거절");
  check(V.normalizeSettings({ ...base, format: "png", duration: 600, fps: 120 }).frames === 72000, "PNG도 600초 × 120fps(72000장)까지(ZIP64)");
  check(/^shader-\d{8}-\d{6}-1280x720-30fps\.webm$/.test(V.fileName(s)), "파일 이름에 크기·fps");
  check(V.estimateBytes(s) === (s.bitrate / 8) * 2, "WebM 예상 크기");
  // ---- 자원 예산: 결과 크기 · 버퍼 준비 프레임 ----
  const hugePng = V.normalizeSettings({ ...base, format: "png", width: 3840, height: 2160, fps: 60, duration: 600 });
  check(V.assessBudget(hugePng).problems.some(p => p.code === "bytes"), "4K PNG 60fps 600초(수백 GB)는 시작 전에 막는다");
  check(V.assessBudget(s).problems.length === 0 && V.assessBudget(s).warmup === 0, "보통 설정은 통과 · 버퍼 없으면 준비 프레임 0");
  const late = V.normalizeSettings({ ...base, start: 86400, fps: 120 });
  check(V.assessBudget(late, { hasBuffers: true }).warmup === 10368000 && V.assessBudget(late, { hasBuffers: true }).problems.some(p => p.code === "warmup"), "버퍼 + 시작 86400초 × 120fps(약 1037만 준비 프레임)는 막는다");
  check(V.assessBudget(late).problems.length === 0, "버퍼가 없으면 시작 시간이 길어도 준비 프레임이 없다");
  check(V.assessBudget(V.normalizeSettings({ ...base, start: 120, fps: 60 }), { hasBuffers: true }).warnings.some(p => p.code === "warmup"), "준비 프레임이 많으면 경고");

  // ---- 가변 길이 정수 ----
  for (const n of [0, 1, 126, 127, 16382, 16383, 2 ** 21, 2 ** 40]) {
    const enc = V.vint(n), dec = readVint(enc, 0);
    assert.equal(dec.value, n);
    assert.equal(dec.len, enc.length);
  }
  check(V.vint(126).length === 1 && V.vint(127).length === 2, "EBML 길이: 모두 1인 값(길이 모름)은 피한다");

  // ---- WebM 먹서 ----
  const muxer = V.createWebmMuxer({ codecId: "V_VP9", width: 320, height: 180, fps: 30 });
  assert.throws(() => muxer.addChunk({ type: "delta", timestamp: 0, data: new Uint8Array(3) }), /키프레임/);
  const N = 75, gop = 30;
  for (let i = 0; i < N; i++)
    muxer.addChunk({ type: i % gop === 0 ? "key" : "delta", timestamp: Math.round((i * 1e6) / 30), data: Uint8Array.of(i, 0xaa, i) });
  const webm = await bytesOf(muxer.finish());
  const top = parse(webm);
  check(top.length === 2 && top[0].id === 0x1a45dfa3 && top[1].id === 0x18538067, "EBML 헤더 + Segment");
  check(text(webm, child(webm, top[0], 0x4282)[0]) === "webm", "DocType webm");
  const seg = parse(webm, top[1].body, top[1].end);
  check(seg.map(e => e.id).slice(0, 3).join() === [0x1549a966, 0x1654ae6b, 0x1c53bb6b].join(), "Info → Tracks → Cues → Cluster 순서");
  const info = seg[0], duration = child(webm, info, 0x4489)[0];
  check(new DataView(webm.buffer, duration.body, 8).getFloat64(0) === 2500, "Duration = 75프레임 / 30fps = 2500ms");
  check(uintOf(webm, child(webm, info, 0x2ad7b1)[0]) === 1e6, "TimestampScale 1ms");
  const track = child(webm, seg[1], 0xae)[0];
  check(text(webm, child(webm, track, 0x86)[0]) === "V_VP9", "CodecID");
  check(uintOf(webm, child(webm, track, 0x23e383)[0]) === Math.round(1e9 / 30), "DefaultDuration");
  const video = child(webm, track, 0xe0)[0];
  check(uintOf(webm, child(webm, video, 0xb0)[0]) === 320 && uintOf(webm, child(webm, video, 0xba)[0]) === 180, "PixelWidth·Height");
  const clusters = seg.filter(e => e.id === 0x1f43b675);
  check(clusters.length === 3, "키프레임마다 클러스터 (75프레임 / 30 = 3)");
  const blocks = [];
  for (const c of clusters) {
    const ts = uintOf(webm, child(webm, c, 0xe7)[0]);
    for (const b of child(webm, c, 0xa3)) {
      const rel = (webm[b.body + 1] << 8) | webm[b.body + 2];
      blocks.push({ ms: ts + rel, key: !!(webm[b.body + 3] & 0x80), track: webm[b.body], first: webm[b.body + 4] });
    }
  }
  check(blocks.length === N && blocks.every((b, i) => b.first === i), "모든 프레임이 순서대로 담김");
  check(blocks.every((b, i) => b.ms === Math.round((i * 1000) / 30)), "프레임 시간(ms) = i / fps");
  check(blocks.every((b, i) => b.key === (i % gop === 0)) && blocks.every(b => b.track === 0x81), "키프레임 표시와 트랙 번호");
  const cues = child(webm, seg[2], 0xbb);
  check(cues.length === 3, "클러스터마다 Cue");
  for (const [n, cue] of cues.entries()) {
    const pos = child(webm, child(webm, cue, 0xb7)[0], 0xf1)[0];
    assert.equal(uintOf(webm, pos) + top[1].body, clusters[n].start, `Cue ${n} 위치`);
    assert.equal(uintOf(webm, child(webm, cue, 0xb3)[0]), uintOf(webm, child(webm, clusters[n], 0xe7)[0]));
  }
  check(true, "Cue 위치·시간이 클러스터를 가리킴");
  // 키프레임 없이 32초를 넘으면 클러스터를 나눈다(상대 시간은 int16).
  const long = V.createWebmMuxer({ codecId: "V_VP8", width: 16, height: 16, fps: 1 });
  for (let i = 0; i < 70; i++) long.addChunk({ type: i ? "delta" : "key", timestamp: i * 1e6, data: Uint8Array.of(i) });
  const longBytes = await bytesOf(long.finish()), longSeg = parse(longBytes, parse(longBytes)[1].body, parse(longBytes)[1].end);
  check(longSeg.filter(e => e.id === 0x1f43b675).length === 3 && longSeg.filter(e => e.id === 0x1c53bb6b).length === 1, "32초마다 클러스터 분할(Cue는 키프레임 클러스터만)");

  // ---- MP4 먹서 ----
  const boxes = (b, start = 0, end = b.length) => {
    const out = [], view = new DataView(b.buffer, b.byteOffset);
    for (let at = start; at < end; ) {
      let size = view.getUint32(at), head = 8;
      const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
      if (size === 1) { size = Number(view.getBigUint64(at + 8)); head = 16; }
      out.push({ type, start: at, body: at + head, end: at + size });
      at += size;
    }
    assert.equal(out.at(-1)?.end ?? start, end, "MP4 박스가 경계에 딱 맞아야 한다");
    return out;
  };
  const find = (b, path, from = { body: 0, end: b.length }) => {
    let node = from;
    for (const type of path.split(".")) {
      const skip = { stsd: 8, avc1: 78, dref: 8 }[node.type] || 0;
      node = boxes(b, node.body + skip, node.end).find(x => x.type === type);
      assert.ok(node, `${path}: ${type} 없음`);
    }
    return node;
  };
  const u32 = (b, at) => new DataView(b.buffer, b.byteOffset).getUint32(at);
  const avcC = Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80);
  const mp4 = V.createMp4Muxer({ width: 320, height: 180, fps: 30 });
  assert.throws(() => mp4.addChunk({ type: "delta", timestamp: 0, data: Uint8Array.of(1) }), /키프레임/);
  mp4.setDescription(avcC.buffer);
  mp4.setDescription(Uint8Array.of(9, 9)); // 두 번째부터는 무시
  for (let i = 0; i < 75; i++) mp4.addChunk({ type: i % 30 === 0 ? "key" : "delta", timestamp: Math.round((i * 1e6) / 30), data: Uint8Array.of(0, 0, 0, 1, i) });
  const m = await bytesOf(mp4.finish());
  const mtop = boxes(m);
  check(mtop.map(x => x.type).join() === "ftyp,moov,mdat", "ftyp → moov → mdat (앞쪽 moov: 받자마자 재생)");
  check(String.fromCharCode(...m.subarray(8, 12)) === "isom", "ftyp isom");
  const mvhd = find(m, "moov.mvhd");
  check(u32(m, mvhd.body + 12) === 1000 && u32(m, mvhd.body + 16) === 2500, "mvhd: 1000 단위, 2500ms");
  const tkhd = find(m, "moov.trak.tkhd");
  check(u32(m, tkhd.body + 76) === 320 * 65536 && u32(m, tkhd.body + 80) === 180 * 65536, "tkhd 크기");
  const mdhd = find(m, "moov.trak.mdia.mdhd");
  check(u32(m, mdhd.body + 12) === 90000 && u32(m, mdhd.body + 16) === 75 * 3000, "mdhd: 90000 단위(30fps면 프레임당 3000)");
  check(String.fromCharCode(...m.subarray(find(m, "moov.trak.mdia.hdlr").body + 8, find(m, "moov.trak.mdia.hdlr").body + 12)) === "vide", "hdlr vide");
  const avc1 = find(m, "moov.trak.mdia.minf.stbl.stsd.avc1");
  check(m[avc1.body + 24] * 256 + m[avc1.body + 25] === 320 && m[avc1.body + 26] * 256 + m[avc1.body + 27] === 180, "avc1 샘플 항목 크기");
  const avcBox = find(m, "moov.trak.mdia.minf.stbl.stsd.avc1.avcC");
  check([...m.subarray(avcBox.body, avcBox.end)].join() === [...avcC].join(), "avcC = 인코더 description(첫 것)");
  const stbl = find(m, "moov.trak.mdia.minf.stbl");
  const stts = find(m, "stts", stbl);
  check(u32(m, stts.body + 4) === 1 && u32(m, stts.body + 8) === 75 && u32(m, stts.body + 12) === 3000, "stts: 75프레임 × 3000");
  const stss = find(m, "stss", stbl);
  check(u32(m, stss.body + 4) === 3 && [0, 1, 2].map(i => u32(m, stss.body + 8 + i * 4)).join() === "1,31,61", "stss: 키프레임 1·31·61");
  const stsz = find(m, "stsz", stbl);
  check(u32(m, stsz.body + 8) === 75 && u32(m, stsz.body + 12) === 5, "stsz: 프레임 크기");
  const stco = find(m, "stco", stbl), mdat = mtop[2];
  check(u32(m, stco.body + 8) === mdat.body && m[mdat.body + 4] === 0 && m[mdat.body + 9] === 1 && m[mdat.end - 1] === 74, "stco가 mdat 데이터 시작을 가리키고 프레임이 순서대로");
  check(!boxes(m, stbl.body, stbl.end).some(x => x.type === "ctts"), "표시 순서 = 디코딩 순서면 ctts 없음");
  check(V.createMp4Muxer({ width: 16, height: 16, fps: 7 }).timescale === 7000, "90000으로 나누어떨어지지 않는 fps는 fps×1000 단위");
  // B 프레임: 디코딩 순서 I P B B → 표시 시간 0, 3, 1, 2 (프레임 단위)
  const bm = V.createMp4Muxer({ width: 16, height: 16, fps: 30 });
  bm.setDescription(avcC);
  [0, 3, 1, 2].forEach((f, i) => bm.addChunk({ type: i ? "delta" : "key", timestamp: Math.round((f * 1e6) / 30), data: Uint8Array.of(i) }));
  const bb = await bytesOf(bm.finish()), ctts = find(bb, "ctts", find(bb, "moov.trak.mdia.minf.stbl"));
  const offsets = [0, 1, 2, 3].map(i => new DataView(bb.buffer).getInt32(ctts.body + 8 + i * 8 + 4));
  check(bb[ctts.body] === 1 && offsets.join() === [0, 2, -1, -1].map(v => v * 3000).join(), "B 프레임이면 ctts v1(부호 있는 표시 시간 차이)");
  await assert.rejects(async () => { const x = V.createMp4Muxer({ width: 16, height: 16, fps: 30 }); x.addChunk({ type: "key", timestamp: 0, data: Uint8Array.of(1) }); x.finish(); }, /avcC/);
  check(true, "avcC를 못 받으면 오류");
  // 4GB 넘는 mdat: 64비트 크기 + co64 (실제 데이터 대신 크기만 큰 가짜 조각)
  const big = V.createMp4Muxer({ width: 16, height: 16, fps: 1 });
  big.setDescription(avcC);
  for (let i = 0; i < 3; i++) big.addChunk({ type: "key", timestamp: i * 1e6, data: { byteLength: 0x7fffffff } });
  const bigParts = big.finish(), head = await bytesOf(bigParts.filter(p => p instanceof Uint8Array));
  const bigTop = [], hv = new DataView(head.buffer);
  for (let at = 0; at < head.length; ) {
    const size = hv.getUint32(at), type = String.fromCharCode(...head.subarray(at + 4, at + 8));
    bigTop.push(type);
    if (type === "mdat") { check(size === 1 && Number(hv.getBigUint64(at + 8)) === 3 * 0x7fffffff + 16, "mdat 64비트 크기"); break; }
    at += size;
  }
  const moovEnd = hv.getUint32(0) + hv.getUint32(hv.getUint32(0)); // ftyp + moov
  const bigStbl = find(head, "moov.trak.mdia.minf.stbl", { body: 0, end: moovEnd });
  check(boxes(head, bigStbl.body, bigStbl.end).some(x => x.type === "co64") && bigTop.join() === "ftyp,moov,mdat", "4GB 넘으면 co64");

  // ---- ZIP ----
  const sample = new TextEncoder().encode("hello shader");
  check(V.crc32(sample) === zlib.crc32(sample) && V.crc32(new Uint8Array(0)) === 0, "CRC-32가 zlib와 같다");
  const zip = V.createZipWriter({ date: new Date(2026, 10, 6, 12, 30, 10) });
  const files = [["frame_00000.png", Uint8Array.of(1, 2, 3)], ["frame_00001.png", new Uint8Array(1000).fill(7)], ["README.txt", sample]];
  for (const [name, data] of files) zip.add(name, data);
  const zbytes = await bytesOf(zip.finish()), zv = new DataView(zbytes.buffer);
  const eocd = zbytes.length - 22;
  check(zv.getUint32(eocd, true) === 0x06054b50 && zv.getUint16(eocd + 10, true) === 3, "끝 레코드에 파일 3개");
  let at = zv.getUint32(eocd + 16, true);
  for (const [name, data] of files) {
    assert.equal(zv.getUint32(at, true), 0x02014b50);
    const nameLen = zv.getUint16(at + 28, true), local = zv.getUint32(at + 42, true);
    assert.equal(new TextDecoder().decode(zbytes.subarray(at + 46, at + 46 + nameLen)), name);
    assert.equal(zv.getUint32(local, true), 0x04034b50);
    const size = zv.getUint32(local + 22, true), lnl = zv.getUint16(local + 26, true);
    const stored = zbytes.subarray(local + 30 + lnl, local + 30 + lnl + size);
    assert.deepEqual([...stored], [...data]);
    assert.equal(zv.getUint32(local + 14, true), zlib.crc32(stored));
    at += 46 + nameLen;
  }
  check(true, "중앙 디렉터리 → 로컬 헤더 → 내용·CRC 일치");
  check(!zip.zip64(), "작은 ZIP은 ZIP64를 쓰지 않는다");

  // ---- ZIP64 ----
  // 읽기: 끝 레코드(0xFFFF·0xFFFFFFFF) → ZIP64 위치 레코드 → ZIP64 끝 레코드 → 중앙 디렉터리(오프셋은 추가 필드 0x0001)
  const readZip64 = bytes => {
    const view = new DataView(bytes.buffer), eocd = bytes.length - 22;
    assert.equal(view.getUint32(eocd, true), 0x06054b50);
    assert.equal(view.getUint16(eocd + 10, true), 0xffff);
    assert.equal(view.getUint32(eocd + 16, true), 0xffffffff);
    const locator = eocd - 20;
    assert.equal(view.getUint32(locator, true), 0x07064b50);
    const record = Number(view.getBigUint64(locator + 8, true));
    assert.equal(view.getUint32(record, true), 0x06064b50);
    assert.equal(Number(view.getBigUint64(record + 4, true)), 44);
    const count = Number(view.getBigUint64(record + 32, true)), cdSize = Number(view.getBigUint64(record + 40, true)), cdStart = Number(view.getBigUint64(record + 48, true));
    assert.equal(cdStart + cdSize, record, "중앙 디렉터리 바로 뒤에 ZIP64 끝 레코드");
    const out = [];
    for (let at = cdStart, i = 0; i < count; i++) {
      assert.equal(view.getUint32(at, true), 0x02014b50);
      const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true);
      let local = view.getUint32(at + 42, true);
      if (local === 0xffffffff) {
        const extra = at + 46 + nameLength;
        assert.equal(view.getUint16(extra, true), 0x0001);
        assert.equal(view.getUint16(extra + 2, true), 8);
        local = Number(view.getBigUint64(extra + 4, true));
      }
      assert.equal(view.getUint32(local, true), 0x04034b50, `파일 ${i}의 로컬 헤더`);
      const size = view.getUint32(local + 22, true), lnl = view.getUint16(local + 26, true);
      out.push({ name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)), data: bytes.subarray(local + 30 + lnl, local + 30 + lnl + size), crc: view.getUint32(at + 16, true) });
      at += 46 + nameLength + extraLength;
    }
    return out;
  };
  const z64 = V.createZipWriter({ force64: true });
  for (const [name, data] of files) z64.add(name, data);
  const z64files = readZip64(await bytesOf(z64.finish()));
  check(z64files.length === 3 && z64files.every((f, i) => f.name === files[i][0] && f.crc === zlib.crc32(f.data) && f.data.length === files[i][1].length), "ZIP64 구조(강제): 끝 레코드 → 위치 → 중앙 디렉터리 → 내용");
  // 65535개를 넘으면 저절로 ZIP64
  const many = V.createZipWriter(), tiny = Uint8Array.of(42);
  for (let i = 0; i < 70000; i++) many.add(`f${i}.bin`, tiny);
  check(many.zip64(), "파일 70000개면 ZIP64");
  const manyFiles = readZip64(await bytesOf(many.finish()));
  check(manyFiles.length === 70000 && manyFiles[69999].name === "f69999.bin" && manyFiles[69999].data[0] === 42, "파일 70000개를 모두 읽을 수 있다");
  // 4GB 넘는 위치: 실제로 4GB를 만들 수 없어 크기만 큰 가짜 Blob 조각으로 위치 계산을 확인한다
  const huge = V.createZipWriter(), fakeBlob = { size: 0x7fffffff };
  huge.add("a.png", { byteLength: 0x7fffffff, length: 0 }, fakeBlob);
  huge.add("b.png", { byteLength: 0x7fffffff, length: 0 }, fakeBlob);
  huge.add("c.png", Uint8Array.of(1));
  check(huge.zip64(), "4GB를 넘는 위치면 ZIP64");
  const hugeParts = huge.finish(), tail = await bytesOf(hugeParts.slice(hugeParts.indexOf(fakeBlob, 2) + 1).filter(p => p !== fakeBlob));
  const cOffset = 2 * (30 + 5 + 0x7fffffff);
  const tailView = new DataView(tail.buffer);
  let found = false;
  for (let at = 0; at + 4 <= tail.length; at++)
    if (tailView.getUint32(at, true) === 0x02014b50 && new TextDecoder().decode(tail.subarray(at + 46, at + 51)) === "c.png") {
      found = tailView.getUint32(at + 42, true) === 0xffffffff && Number(tailView.getBigUint64(at + 46 + 5 + 4, true)) === cOffset;
      break;
    }
  check(found, "4GB 뒤 파일의 위치는 ZIP64 추가 필드에(0xFFFFFFFF 대신)");

  // ---- 렌더링 실행(가짜 렌더러·인코더) ----
  const fakeRenderer = () => {
    const calls = [];
    return {
      calls,
      beginOffline: size => { calls.push(["begin", size]); },
      renderOfflineFrame: f => { calls.push(["frame", f]); return { kind: "gl-canvas", frame: f }; },
      endOffline: () => { calls.push(["end"]); },
    };
  };
  const fakeCanvas = () => ({ width: 0, height: 0, last: null, getContext() { const c = this; return { drawImage: src => { c.last = src.frame; } }; }, toBlob(cb) { cb(new Blob([`png${this.last.frame}`])); } });
  class FakeFrame { constructor(src, init) { this.frame = src.last; this.timestamp = init.timestamp; this.closed = false; FakeFrame.made.push(this); } close() { this.closed = true; } }
  class FakeEncoder {
    static async isConfigSupported(c) { return { supported: c.codec === "vp09.00.41.08" || c.codec === "vp8" }; }
    constructor({ output, error }) { this.output = output; this.error = error; this.encodeQueueSize = 0; this.state = "unconfigured"; FakeEncoder.last = this; this.keys = []; }
    configure(c) { this.config = c; this.state = "configured"; }
    encode(frame, { keyFrame }) {
      this.keys.push(keyFrame);
      const data = Uint8Array.of(frame.frame.frame & 0xff);
      this.output({ type: keyFrame ? "key" : "delta", timestamp: frame.timestamp, byteLength: 1, copyTo: d => d.set(data) });
    }
    async flush() {}
    close() { this.state = "closed"; }
  }
  FakeFrame.made = [];
  const settings = V.normalizeSettings({ start: 1, duration: 1, fps: 10, width: 64, height: 36, format: "webm-vp9" });
  let r = fakeRenderer();
  const progress = [];
  const result = await V.render({ renderer: r, settings, hasBuffers: true, Encoder: FakeEncoder, Frame: FakeFrame, createCanvas: fakeCanvas, onProgress: p => progress.push(p) });
  const frames = r.calls.filter(c => c[0] === "frame").map(c => c[1]);
  check(r.calls[0][0] === "begin" && r.calls[0][1].width === 64 && r.calls.at(-1)[0] === "end", "beginOffline → 프레임 → endOffline");
  check(frames.length === 20, "버퍼가 있으면 시작 전 10프레임 + 본 10프레임");
  check(frames.slice(0, 10).every((f, j) => Math.abs(f.time - j * 0.1) < 1e-9 && f.frame === j), "준비 프레임은 0초부터 같은 간격");
  check(frames.slice(10).every((f, i) => Math.abs(f.time - (1 + i * 0.1)) < 1e-9 && f.frame === 10 + i && f.delta === 0.1), "본 프레임: uTime = 시작 + i/fps, uFrame 이어서");
  check(FakeEncoder.last.config.codec === "vp09.00.41.08" && FakeEncoder.last.config.framerate === 10, "지원되는 첫 VP9 코덱 문자열로 설정");
  check(FakeEncoder.last.keys.join() === [true, ...Array(9).fill(false)].join(), "2초마다 키프레임(1초 영상이면 첫 프레임만)");
  check(FakeFrame.made.length === 10 && FakeFrame.made.every(f => f.closed) && FakeFrame.made.every((f, i) => f.timestamp === i * 100000), "VideoFrame 시간(µs)·모두 닫음");
  check(progress.some(p => p.phase === "warmup") && progress.at(-1).phase === "finish", "진행률: 준비 → 렌더 → 마무리");
  check(result.blob.type === "video/webm" && /\.webm$/.test(result.name) && result.blob.size > 100, "WebM 결과");
  check(parse(await bytesOf([result.blob])).length === 2, "결과가 올바른 EBML");
  // 버퍼가 없으면 준비 프레임 없이 시작 시간부터, uFrame은 시작 시간 × fps부터
  r = fakeRenderer();
  await V.render({ renderer: r, settings, hasBuffers: false, Encoder: FakeEncoder, Frame: FakeFrame, createCanvas: fakeCanvas });
  const plain = r.calls.filter(c => c[0] === "frame").map(c => c[1]);
  check(plain.length === 10 && plain[0].time === 1 && plain[0].frame === 10, "버퍼 없으면 준비 프레임 생략");
  // PNG ZIP
  r = fakeRenderer();
  const zres = await V.render({ renderer: r, settings: V.normalizeSettings({ ...settings, format: "png", start: 0, duration: 0.3 }), createCanvas: fakeCanvas });
  const zb = await bytesOf([zres.blob]), zd = new DataView(zb.buffer);
  check(zres.blob.type === "application/zip" && zd.getUint16(zb.length - 22 + 10, true) === 4, "PNG ZIP: 3장 + README");
  check(new TextDecoder().decode(zb.subarray(30, 45)) === "frame_00000.png", "첫 파일 frame_00000.png");
  // 지원하지 않는 코덱: 렌더링을 시작하지 않는다
  r = fakeRenderer();
  await assert.rejects(V.render({ renderer: r, settings: { ...settings }, Encoder: undefined, Frame: FakeFrame, createCanvas: fakeCanvas }), /지원하지 않습니다/);
  check(r.calls.length === 0, "인코더가 없으면 오프라인 모드에 들어가지 않음");
  // 취소: 중간에 abort하면 endOffline을 부르고 AbortError
  r = fakeRenderer();
  const controller = new AbortController();
  await assert.rejects(
    V.render({ renderer: r, settings, Encoder: FakeEncoder, Frame: FakeFrame, createCanvas: fakeCanvas, signal: controller.signal, onProgress: p => { if (p.phase === "render" && p.done === 3) controller.abort(); } }),
    error => error.name === "AbortError"
  );
  check(r.calls.at(-1)[0] === "end" && r.calls.filter(c => c[0] === "frame").length === 3 && FakeEncoder.last.state === "closed", "취소하면 멈추고 정리(endOffline·인코더 닫기)");
  // 타일 렌더링(renderOfflineFrameTiled)이 있으면 그것을 쓰고, 다 그린 캔버스를 capture로 받아 옮긴다
  r = fakeRenderer();
  const tiledCalls = [];
  r.renderOfflineFrameTiled = async (f, capture) => { tiledCalls.push(f); await Promise.resolve(); capture({ kind: "gl-canvas", frame: f }); };
  r.getOfflineTiling = () => ({ tiles: tiledCalls.length * 3 });
  const tileProgress = [];
  FakeFrame.made = [];
  await V.render({ renderer: r, settings, Encoder: FakeEncoder, Frame: FakeFrame, createCanvas: fakeCanvas, onProgress: p => tileProgress.push(p) });
  check(tiledCalls.length === 10 && !r.calls.some(c => c[0] === "frame"), "타일 렌더링 함수가 있으면 그것으로 그린다");
  check(FakeFrame.made.length === 10 && FakeFrame.made.every((f, i) => f.frame.frame === 10 + i), "capture로 받은 캔버스를 인코더에 넘긴다");
  check(tileProgress.filter(p => p.phase === "render").every(p => p.tiles === 3), "진행률에 프레임마다 타일 수");
  // 렌더러 오류도 정리한다
  r = fakeRenderer();
  r.renderOfflineFrame = () => { throw new Error("context lost"); };
  await assert.rejects(V.render({ renderer: r, settings, Encoder: FakeEncoder, Frame: FakeFrame, createCanvas: fakeCanvas }), /context lost/);
  check(r.calls.at(-1)[0] === "end", "렌더 실패해도 endOffline");
  // 인코더 오류 콜백
  class BrokenEncoder extends FakeEncoder { encode() { this.error(new Error("encoder broke")); } }
  r = fakeRenderer();
  await assert.rejects(V.render({ renderer: r, settings, Encoder: BrokenEncoder, Frame: FakeFrame, createCanvas: fakeCanvas }), /encoder broke/);
  check(r.calls.at(-1)[0] === "end", "인코더 오류를 전달하고 정리");
  // 지원 형식 조사
  const probe = await V.probeFormats({ Encoder: FakeEncoder });
  check(probe["webm-vp9"] === "vp09.00.41.08" && probe["webm-vp8"] === "vp8" && probe.png === "png", "형식 조사");
  check((await V.probeFormats({ Encoder: undefined }))["webm-vp9"] === null, "WebCodecs가 없으면 PNG만");
  console.log(`video-render: ${passed} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
