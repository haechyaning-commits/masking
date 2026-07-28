const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor");
const JS = path.join(ROOT, "js");

const read = (p) => fs.readFileSync(p, "utf8");

const css = read(path.join(DIR, "masking.css"));
const body = read(path.join(DIR, "body.html"));
const pdfjs = read(path.join(VENDOR, "pdf.min.js"));
const pdflib = read(path.join(VENDOR, "pdf-lib.min.js"));
const worker = read(path.join(VENDOR, "pdf.worker.min.js"));
const detectors = read(path.join(JS, "detectors.js"));
const app = read(path.join(DIR, "app-artifact.js"));

// 스크립트 내부 </script> 충돌 방어 + U+FFFD(치환문자) 이스케이프.
// pdf-lib 소스에 문자열 리터럴로 들어있는 U+FFFD 원시 바이트가 아티팩트 배포
// 검증기에서 거부되므로, JS적으로 동일한 이스케이프 "�"로 치환한다.
const safe = (s) =>
  s.replace(/<\/script/gi, "<\\/script").replace(/�/g, "\\uFFFD");

const scripts = [
  `<style>\n${css}\n</style>`,
  body.trim(),
  `<script>${safe(pdfjs)}</script>`,
  `<script>${safe(pdflib)}</script>`,
  `<script id="pdfWorkerSrc" type="text/plain">${safe(worker)}</script>`,
  `<script>${safe(detectors)}</script>`,
  `<script>${safe(app)}</script>`,
].join("\n");

// 1) 아티팩트용 (body-only; 하네스가 doctype/head/body로 감쌈)
fs.writeFileSync(path.join(DIR, "masking-artifact.html"), scripts);

// 2) 독립 실행용 (더블클릭)
const standalone = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
${scripts}
</body>
</html>`;
fs.writeFileSync(path.join(DIR, "masking-standalone.html"), standalone);

console.log("artifact:", fs.statSync(path.join(DIR, "masking-artifact.html")).size, "bytes");
console.log("standalone:", fs.statSync(path.join(DIR, "masking-standalone.html")).size, "bytes");
