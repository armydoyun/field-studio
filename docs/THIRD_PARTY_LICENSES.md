# 다른 사람의 셰이더 · 라이선스

갤러리의 **커뮤니티 셰이더** 칸에 있는 예제는 다른 사람이 공개한 작품을 FIELD Studio로 옮긴 것이다.
코드는 `js/community-examples.js`에 있고, 각 셰이더 맨 위 주석에 원작자·출처·바꾼 점을 적어 두었다.

넣는 기준: 원작자가 작품에 재배포를 허락하는 라이선스(MIT·CC0 등)나 같은 뜻의 공개 허락을 **직접** 밝힌 것만.
Shadertoy에 코드가 보인다고 해서 쓸 수 있는 것은 아니다. Shadertoy의 기본 라이선스는 CC BY-NC-SA 3.0이고,
작품마다 원작자가 따로 정한 조건이 우선한다. 예를 들어 Inigo Quilez의 작품 장면(Raymarching - Primitives, Elevated 등)은
지금 "어떤 형태로든 호스팅·배포·공유 금지" 고지가 붙어 있어서 넣지 않았다(예전 사본에는 MIT나 CC BY-NC-SA로 적혀 있던 것도 있다).

새 예제를 넣을 때는 원본의 라이선스 고지를 직접 확인하고, 아래 목록과 셰이더 머리말, `credit` 항목을 함께 채운다.

| 예제 | 원작 | 원작자 | 라이선스 | 출처 |
|---|---|---|---|---|
| Star Nest | Star Nest (2013) | Pablo Roman Andrioli (Kali) | MIT | https://www.shadertoy.com/view/XlfGRj |
| Golden Apollian | Tunneling through golden apollian fractal II | mrange | CC0 1.0 | https://gist.github.com/mrange/86fb851ff3c073a1a81a1cf21e48b285 |
| Raymarched Mountains | shader-terrain-landscapes · demo/elevated.html (2026) | Francisco Piaggio | MIT | https://github.com/franpiaggio/shader-terrain-landscapes |
| Ray Tracing Primitives | Ray Tracing - Primitives (2019) | Reinder Nijhoff | MIT | https://www.shadertoy.com/view/tl23Rm |
| Procedural Ocean | Very fast procedural ocean | afl_ext | MIT | https://www.shadertoy.com/view/MdXyzX |
| Skyline | Skyline | Otavio Good | CC0 1.0 | https://www.shadertoy.com/view/XtsSWs |
| 2D Clouds | 2D Clouds | drift | Permission (원작자의 자유 사용 허락) | https://www.shadertoy.com/view/4tdSWr |
| Let's Self Reflect | Let's self reflect | mrange | CC0 1.0 | https://www.shadertoy.com/view/XfyXRV |
| Stars and Galaxy | Stars and galaxy | mrange | CC0 1.0 | https://www.shadertoy.com/view/stBcW1 |
| Elemental Ring | Elemental Ring | Otavio Good | CC0 1.0 | https://www.shadertoy.com/view/MsVXDt |
| Hexagon Plasma | Hexagon Plasma | Nemerix | MIT | https://www.shadertoy.com/view/3fy3z3 |
| Nox Fire | Nox Fire | Matt Vianueva | MIT | https://www.shadertoy.com/view/wfG3Dz |

## Star Nest — MIT

원본 셰이더에는 "Star Nest by Pablo Roman Andrioli / License: MIT"만 적혀 있다. 아래는 그 고지에 맞춘 MIT 전문이다.

```
MIT License

Copyright (c) 2013 Pablo Roman Andrioli

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Golden Apollian — CC0 1.0

원본 첫 줄: `// Licence CC0: Tunneling through golden appollian fractal II`.
CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다. https://creativecommons.org/publicdomain/zero/1.0/

## Raymarched Mountains — MIT

원작자가 밝힌 대로 Inigo Quilez의 지형 기법(https://iquilezles.org/articles/terrainmarching/)을 바탕으로 새로 짠 코드다.
아래는 원본 저장소의 `LICENSE` 파일 그대로다.

```
MIT License

Copyright (c) 2026 Francisco Piaggio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ray Tracing Primitives — MIT

원본 셰이더 머리말: "Ray Tracing - Primitives. Created by Reinder Nijhoff 2019 / The MIT License".
원작자 설명대로 교차 함수 대부분은 Inigo Quilez의 글과 예제(https://iquilezles.org/articles/intersectors)에서 가져온 것이다.

```
MIT License

Copyright (c) 2019 Reinder Nijhoff

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 두 번째 묶음 — xscreensaver 수록본에서 옮긴 작품

아래 작품은 Jamie Zawinski의 xscreensaver(https://www.jwz.org/xscreensaver/, 미러 https://github.com/Zygo/xscreensaver/tree/master/hacks/glx/glsl)에
실린 판을 옮겼다. xscreensaver는 Shadertoy 작품마다 제목·원작자·주소·원작자의 라이선스 고지를 머리말로 남겨 두고, 텍스처를 쓰지 않도록 일부 고쳐 두었다.
각 셰이더 머리말에 원본 Shadertoy 주소와 xscreensaver 수록본을 함께 적었다.

## Procedural Ocean — MIT

원본 머리말: `// afl_ext 2017-2024` / `// MIT License`.

```
MIT License

Copyright (c) 2017-2024 afl_ext

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Skyline — CC0

원본 머리말: `License CC0 - http://creativecommons.org/publicdomain/zero/1.0/` (Otavio Good: "This means do ANYTHING YOU WANT with this code.") CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.

## 2D Clouds — Permission

정식 라이선스 이름은 없지만, 원작자 drift가 2024-06-25 Shadertoy에 남긴 공개 허락이 수록본 머리말에 있다:

> "Anyone and everyone who wishes to use this shader I give my permission to use it in any way that you choose.
> Credit would be nice but I won't insist on it."

그래서 출처를 남기고 넣었다.

## Let's Self Reflect — CC0

원본 머리말에 `CC0: Let's self reflect`(mrange) 고지가 있다. CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.

## Stars and Galaxy — CC0

원본 머리말에 `CC0: Stars and galaxy`(mrange) 고지가 있다. CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.

## Elemental Ring — CC0

원본 머리말: `License CC0 - http://creativecommons.org/publicdomain/zero/1.0/` (Otavio Good: "This means do ANYTHING YOU WANT with this code.") CC0(퍼블릭 도메인 헌정)이라 고지 의무는 없지만 출처를 남긴다.

## Hexagon Plasma — MIT

원본 머리말: `// Shader by Nemerix, 2025-05-26.` / `// Code made available under the MIT license.`

```
MIT License

Copyright (c) 2025 Nemerix

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Nox Fire — MIT

원본 Shadertoy 페이지에는 라이선스 표기가 없다. xscreensaver 수록본 머리말: `// Relicensed as MIT License, by permission, 8-Mar-2026.` — 원작자의 허락을 받아 MIT로 재배포한 판을 따른다.

```
MIT License

Copyright (c) 2025 Matt Vianueva

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
