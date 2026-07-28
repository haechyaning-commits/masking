const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const VENDOR = require("path").join(__dirname, "..", "vendor");
const read = (p) => fs.readFileSync(p, "utf8");
const safe = (s) => s.replace(/<\/script/gi, "<\\/script").replace(/�/g, "\\uFFFD");

const css = read(path.join(DIR, "masking.css"));
const body = read(path.join(DIR, "manual-body.html"));
const pdfjs = read(path.join(VENDOR, "pdf.min.js"));
const pdflib = read(path.join(VENDOR, "pdf-lib.min.js"));
const worker = read(path.join(VENDOR, "pdf.worker.min.js"));
const app = read(path.join(DIR, "manual-app.js"));

const scripts = [
  `<style>\n${css}\n</style>`,
  body.trim(),
  `<script>${safe(pdfjs)}</script>`,
  `<script>${safe(pdflib)}</script>`,
  `<script id="pdfWorkerSrc" type="text/plain">${safe(worker)}</script>`,
  `<script>${safe(app)}</script>`,
].join("\n");

fs.writeFileSync(path.join(DIR, "manual-artifact.html"), scripts);
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
fs.writeFileSync(path.join(DIR, "manual-standalone.html"), standalone);
console.log("manual-artifact:", fs.statSync(path.join(DIR, "manual-artifact.html")).size);
console.log("manual-standalone:", fs.statSync(path.join(DIR, "manual-standalone.html")).size);
