// 명시한 경로 → Playwright 번들 → 설치된 Chromium 순서로 고른다.
const fs = require("node:fs");

const chromiumPath = chromium => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (fs.existsSync(chromium.executablePath())) return chromium.executablePath();
  return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]
    .find(file => fs.existsSync(file));
};

const launchOptions = chromium => ({
  headless: true,
  executablePath: chromiumPath(chromium),
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

module.exports = { chromiumPath, launchOptions };
