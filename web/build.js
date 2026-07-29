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
// 추출용 텍스트층: fontkit + 서브셋 한글 폰트(Noto Sans KR). 독립 실행본에만 내장한다.
const fontkit = read(path.join(VENDOR, "fontkit.umd.js"));
const fontB64 = fs.readFileSync(path.join(VENDOR, "NotoSansKR-subset.ttf")).toString("base64");

// 스크립트 내부 </script> 충돌 방어 + U+FFFD(치환문자) 이스케이프.
// pdf-lib 소스에 문자열 리터럴로 들어있는 U+FFFD 원시 바이트가 아티팩트 배포
// 검증기에서 거부되므로, JS적으로 동일한 이스케이프 "�"로 치환한다.
const safe = (s) =>
  s.replace(/<\/script/gi, "<\\/script").replace(/�/g, "\\uFFFD");

// 공통 head 스크립트(앱 스크립트 앞) — 아티팩트/독립 실행본 공유
const head = [
  `<style>\n${css}\n</style>`,
  body.trim(),
  `<script>${safe(pdfjs)}</script>`,
  `<script>${safe(pdflib)}</script>`,
  `<script id="pdfWorkerSrc" type="text/plain">${safe(worker)}</script>`,
  `<script>${safe(detectors)}</script>`,
];
const appScript = `<script>${safe(app)}</script>`;
// 앱보다 먼저 로드돼야 하는 추출용 텍스트층 에셋(독립 실행본 전용)
const fontScripts = [
  `<script>${safe(fontkit)}</script>`,
  `<script id="notoKrFont" type="text/plain">${fontB64}</script>`,
];

// 1) 아티팩트용 (body-only; 하네스가 doctype/head/body로 감쌈) — 용량 위해 폰트 미포함(추출 텍스트층 비활성)
fs.writeFileSync(path.join(DIR, "masking-artifact.html"), [...head, appScript].join("\n"));

// 2) 독립 실행용 (더블클릭) — 한글 폰트 내장(추출 텍스트층 활성)
const standaloneScripts = [...head, ...fontScripts, appScript].join("\n");
const standalone = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body>
${standaloneScripts}
</body>
</html>`;
fs.writeFileSync(path.join(DIR, "masking-standalone.html"), standalone);

console.log("artifact:", fs.statSync(path.join(DIR, "masking-artifact.html")).size, "bytes");
console.log("standalone:", fs.statSync(path.join(DIR, "masking-standalone.html")).size, "bytes");
