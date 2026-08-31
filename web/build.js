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
const engine = read(path.join(JS, "mask-engine.js"));
const ocrBridge = read(path.join(JS, "ocr-bridge.js"));
const app = read(path.join(DIR, "app-artifact.js"));

// OCR(스캔본 인식)용 — Tesseract.js 본체·워커·코어(SIMD 없는 lstm 전용, wasm이
// base64로 내부에 이미 포함된 SINGLE_FILE 빌드라 별도 fetch 불필요)·한국어
// 학습데이터(fast 모델). 전부 오프라인 실행을 위해 파일 안에 통째로 넣는다.
const tessMain = read(path.join(VENDOR, "tesseract.min.js"));
const tessWorker = read(path.join(VENDOR, "worker.min.js"));
const tessCore = read(path.join(VENDOR, "tesseract-core-lstm.wasm.js"));
const korData = fs.readFileSync(path.join(VENDOR, "kor.traineddata")).toString("base64");

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
  `<script>${safe(tessMain)}</script>`,
  `<script id="tessWorkerSrc" type="text/plain">${safe(tessWorker)}</script>`,
  `<script id="tessCoreSrc" type="text/plain">${safe(tessCore)}</script>`,
  `<script id="tessKorData" type="text/plain">${korData}</script>`,
  `<script>${safe(detectors)}</script>`,
  `<script>${safe(engine)}</script>`,
  `<script>${safe(ocrBridge)}</script>`,
  `<script>${safe(app)}</script>`,
].join("\n");

// 1) 아티팩트용 (body-only; 하네스가 doctype/head/body로 감쌈)
fs.writeFileSync(path.join(DIR, "masking-artifact.html"), scripts);

// 브라우저가 코드 내용과 무관하게 강제로 네트워크 전송을 차단하도록 하는 CSP.
// "코드에 fetch가 없다"를 사용자가 매번 읽어서 확인할 필요 없이, 브라우저가
// 기술적으로 보장해준다(connect-src 'none' → 어떤 fetch/XHR/WebSocket도 차단).
// 'wasm-unsafe-eval'은 OCR(Tesseract.js, WebAssembly)을 브라우저가 컴파일·
// 실행할 수 있게 하는 용도로만 쓰인다 — eval()·Function() 등 일반 동적 코드
// 실행은 여전히 전부 막혀 있고(그건 'unsafe-eval'이며 이것과는 다른 토큰),
// 오직 이미 파일 안에 들어있는 WebAssembly 모듈의 컴파일만 허용한다.
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none';";

// 2) 독립 실행용 (더블클릭)
const standalone = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${CSP}" />
</head>
<body>
${scripts}
</body>
</html>`;
fs.writeFileSync(path.join(DIR, "masking-standalone.html"), standalone);

// 3) 웹 호스팅용 (GitHub Pages 등 — URL로 바로 접속해 쓰는 버전). 독립 실행용과
// 동일한 내용 + 동일한 CSP를 docs/index.html 로도 내보내 그대로 정적 호스팅한다.
const DOCS = path.join(ROOT, "docs");
if (!fs.existsSync(DOCS)) fs.mkdirSync(DOCS);
fs.writeFileSync(path.join(DOCS, "index.html"), standalone);

console.log("artifact:", fs.statSync(path.join(DIR, "masking-artifact.html")).size, "bytes");
console.log("standalone:", fs.statSync(path.join(DIR, "masking-standalone.html")).size, "bytes");
console.log("docs/index.html:", fs.statSync(path.join(DOCS, "index.html")).size, "bytes");
