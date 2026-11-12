// 단축키에 쓸 글자 키 이름.
// 한글 입력 상태에서는 글자 키의 event.key가 "ㅋ" 같은 자모나 "Process"(IME가 처리 중)로 와서 "z"와 비교하면 맞지 않는다.
// 그럴 때는 물리 키 위치(event.code = "KeyZ")에서 영문 글자를 읽는다. 영문·다른 라틴 배열(AZERTY 등)은 key를 그대로 쓴다.
const imeLetter = event => {
  const key = event.key || "",
    letter = /^Key([A-Z])$/.exec(event.code || "")?.[1];
  if (!letter) return "";
  return key === "Process" || key === "Unidentified" || (key.length === 1 && key.charCodeAt(0) > 127)
    ? letter.toLowerCase()
    : "";
};
// 소문자 글자 키 이름(글자가 아니면 key를 소문자로).
const latinKey = event => imeLetter(event) || String(event.key || "").toLowerCase();

export { imeLetter, latinKey };
