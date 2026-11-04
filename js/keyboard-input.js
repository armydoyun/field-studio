// 키보드 입력 텍스처(쉐이더토이 호환). 채널에 {keyboard:true}로 연결하면 256×3 R8 텍스처를 읽는다.
//   x = JavaScript 키 코드(A=65, ←=37, Space=32 …)
//   y = 0 지금 누르고 있음 · y = 1 이번 프레임에 눌림(한 프레임만 1) · y = 2 누를 때마다 켜짐/꺼짐
// 키 상태 계산(createState)은 GPU와 무관한 순수 로직이라 node에서 검사한다. create(gl)가 그 상태를 텍스처로 올린다.
// 어떤 키를 셰이더에 넘길지(뷰포트 포커스·단축키 양보)는 input.js가 정한다.
const WIDTH = 256,
  HEIGHT = 3,
  DOWN = 0,
  PRESSED = 1,
  TOGGLE = 2;

const createState = () => {
  const data = new Uint8Array(WIDTH * HEIGHT);
  let dirty = true;
  const valid = code => Number.isInteger(code) && code > 0 && code < WIDTH;
  const at = (row, code) => row * WIDTH + code;
  // 키를 눌렀다(down=true)·뗐다. 같은 키의 반복 입력(autorepeat)은 '이번 프레임에 눌림'을 다시 켜지 않는다.
  const setKey = (code, down) => {
    if (!valid(code)) return false;
    const held = data[at(DOWN, code)] === 255;
    if (down === held) return false;
    data[at(DOWN, code)] = down ? 255 : 0;
    if (down) {
      data[at(PRESSED, code)] = 255;
      data[at(TOGGLE, code)] = data[at(TOGGLE, code)] ? 0 : 255;
    }
    dirty = true;
    return true;
  };
  // 포커스를 잃거나 탭을 바꾸면 모든 키를 뗀 것으로 한다(눌린 채 남지 않게). 켜짐/꺼짐(y=2)은 그대로 둔다.
  const releaseAll = () => {
    for (let code = 0; code < WIDTH; code++)
      if (data[at(DOWN, code)] || data[at(PRESSED, code)]) {
        data[at(DOWN, code)] = data[at(PRESSED, code)] = 0;
        dirty = true;
      }
  };
  // 한 프레임을 그린 뒤 부른다: '이번 프레임에 눌림' 행을 비운다.
  const endFrame = () => {
    for (let code = 0; code < WIDTH; code++)
      if (data[at(PRESSED, code)]) {
        data[at(PRESSED, code)] = 0;
        dirty = true;
      }
  };
  const reset = () => {
    data.fill(0);
    dirty = true;
  };
  const read = (code, row = DOWN) => (valid(code) ? data[at(row, code)] / 255 : 0);
  const takeDirty = () => {
    const was = dirty;
    dirty = false;
    return was;
  };
  return { data, setKey, releaseAll, endFrame, reset, read, takeDirty, markDirty: () => (dirty = true) };
};

// gl: WebGL2. 텍스처는 쓰일 때(bind) 처음 만들고, 상태가 바뀐 프레임에만 다시 올린다.
const create = gl => {
  const state = createState();
  let texture = null;
  const ensure = () => {
    if (texture) return texture;
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, WIDTH, HEIGHT, 0, gl.RED, gl.UNSIGNED_BYTE, state.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
    state.takeDirty();
    return texture;
  };
  // 프레임을 그리기 전에 부른다(텍스처가 이미 있을 때만 올린다).
  const upload = () => {
    if (!texture || !state.takeDirty()) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WIDTH, HEIGHT, gl.RED, gl.UNSIGNED_BYTE, state.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
  // 컨텍스트를 잃으면 GPU 객체는 사라진다. 다음 bind에서 새로 만든다.
  const restore = () => {
    texture = null;
    state.markDirty();
  };
  const dispose = () => {
    if (texture) gl.deleteTexture(texture);
    texture = null;
  };
  return {
    texture: ensure,
    upload,
    restore,
    dispose,
    setKey: state.setKey,
    releaseAll: state.releaseAll,
    endFrame: state.endFrame,
    reset: state.reset,
    read: state.read,
    width: WIDTH,
    height: HEIGHT,
  };
};

export { create, createState, WIDTH, HEIGHT };
