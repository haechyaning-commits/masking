/**
 * ocr-bridge.js
 * ------------------------------------------------------------------
 * 텍스트 레이어가 없는 스캔본 PDF 페이지를 위한 OCR 브리지.
 * Tesseract.js(한국어, fast 모델)로 렌더링된 페이지 이미지를 인식하고,
 * 그 결과를 extractText()가 만드는 것과 동일한 {text, charMap, items} 형태로
 * 변환해, 이후 파이프라인(개인정보 탐지·표 열 인식·마스킹)이 실제 PDF
 * 텍스트와 완전히 동일하게 동작하도록 한다(이 파일이 만드는 items는 문자
 * 하나당 하나씩이라, 부분 마스킹 시 폭을 추정할 필요 없이 실측 글자
 * 박스를 그대로 쓸 수 있다 — 실제 PDF 텍스트보다 오히려 더 정확함).
 *
 * 완전 오프라인 동작을 위한 세 가지 우회:
 *  1) Tesseract 코어(.wasm.js, SINGLE_FILE 빌드라 wasm이 이미 base64로 내부에
 *     포함돼 있어 별도 fetch가 필요 없음) 코드를 워커 스크립트 맨 앞에 그대로
 *     이어붙여 하나의 Blob으로 만든다. tesseract.js의 getCore()는
 *     `typeof TesseractCore === 'undefined'`일 때만 corePath를 따로 불러오므로,
 *     코어가 먼저 실행돼 전역에 TesseractCore를 이미 만들어두면 별도 로드
 *     자체가 필요 없어진다 — corePath를 별도 Blob URL로 주고 워커 안에서
 *     importScripts()로 불러오는 방식은 file:// 로 연 페이지(오프라인 실행
 *     파일을 더블클릭한 경우)에서 origin이 "null"이 되어 부모 문서가 만든
 *     Blob URL을 워커가 못 읽는 문제가 있어(GitHub Pages 등 http(s)에서는
 *     문제없이 동작하지만 완전 오프라인 실행에서 실패함을 실측으로 확인)
 *     이 방식으로 바꿨다.
 *  2) 한국어 학습 데이터는 fetch 대신 idb-keyval의 기본 캐시 스토어에 미리
 *     심어(pre-seed)두고 문자열 langs('kor')로 createWorker를 호출해 라이브러리가
 *     캐시를 먼저 찾게 한다 — tesseract.js가 langs를 객체 배열(예:
 *     [{code,data}])로 받으면 초기화 단계에서 언어 코드 대신 원본 데이터를
 *     문자열로 join해버리는 업스트림 버그(v6·v7 모두 확인됨)가 있어, 이
 *     우회로만 정상 동작한다.
 */
(function (global) {
  "use strict";

  function idbPut(key, value) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("keyval-store");
      req.onupgradeneeded = () => req.result.createObjectStore("keyval");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("keyval", "readwrite");
        tx.objectStore("keyval").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  let workerPromise = null;
  /**
   * OCR 워커를 (최초 1회) 준비한다. 이미 준비 중/완료면 같은 Promise를 재사용.
   * @param {object} opts { coreText, workerText, korDataB64, onProgress }
   */
  function getOcrWorker(opts) {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      // 코어+워커 스크립트를 하나의 Blob으로 합친다(위 파일 설명의 1번 참고).
      const combined = opts.coreText + "\n" + opts.workerText;
      const workerBlobUrl = URL.createObjectURL(new Blob([combined], { type: "text/javascript" }));
      const korData = base64ToBytes(opts.korDataB64);
      await idbPut("./kor.traineddata", korData);
      return Tesseract.createWorker("kor", 1, {
        workerPath: workerBlobUrl,
        workerBlobURL: false,
        gzip: false,
        logger: opts.onProgress || (() => {}),
      });
    })();
    return workerPromise;
  }

  /** Tesseract 결과(blocks 트리)를 {text,bbox,confidence} 평면 목록으로 펼침 */
  function flattenSymbols(ret) {
    const out = [];
    for (const blk of (ret.data.blocks || [])) {
      for (const par of (blk.paragraphs || [])) {
        for (const line of (par.lines || [])) {
          for (const w of (line.words || [])) {
            const wsyms = (w.symbols && w.symbols.length) ? w.symbols : [{ text: w.text, bbox: w.bbox, confidence: w.confidence }];
            for (const s of wsyms) if (s.text) out.push(s);
          }
        }
      }
    }
    return out;
  }

  /** 캔버스 일부를 축소 샘플링해 "어두운 픽셀 비율"을 추정 — 진한 배경(다크 헤더 등)이 있는지 값싸게 확인 */
  function hasDarkRegions(canvas, ratio) {
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return false;
    const sw = 100, sh = Math.max(1, Math.round((h / w) * sw));
    const off = document.createElement("canvas"); off.width = sw; off.height = sh;
    const octx = off.getContext("2d");
    octx.drawImage(canvas, 0, 0, sw, sh);
    const data = octx.getImageData(0, 0, sw, sh).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 80) dark++;
    }
    return dark / (sw * sh) >= (ratio || 0.02);
  }

  /** 캔버스의 색을 반전한 새 캔버스를 만든다(밝은 배경/어두운 글자 전제인 OCR이 어두운 배경/밝은 글자 영역도 읽게 함) */
  function invertCanvas(canvas) {
    const w = canvas.width, h = canvas.height;
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    const ctx = out.getContext("2d");
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  function bboxIoU(a, b) {
    const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
    const iw = Math.max(0, x1 - x0), ih = Math.max(0, y1 - y0);
    const inter = iw * ih;
    const areaA = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
    const areaB = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
    return inter / (areaA + areaB - inter);
  }

  /**
   * 여러 인식 패스(원본·색반전)에서 나온 글자 후보를 하나로 합친다. 같은
   * 자리를 두 패스가 각자 다르게 읽었으면(예: 원본은 다크 헤더를 엉뚱하게
   * 읽고, 반전본은 그 자리를 정확히 읽은 경우) 신뢰도(confidence)가 더 높은
   * 쪽만 채택한다 — 물체 탐지에서 쓰는 NMS(non-max suppression)와 같은 방식.
   */
  function mergeSymbolPasses(passes) {
    const all = [];
    for (const syms of passes) for (const s of syms) all.push(s);
    all.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const accepted = [];
    for (const cand of all) {
      if (accepted.some((a) => bboxIoU(a.bbox, cand.bbox) > 0.3)) continue;
      accepted.push(cand);
    }
    return accepted;
  }

  /** 평면 글자 목록을 y좌표로 줄(line)로 묶는다(위→아래), 각 줄은 x좌표로 정렬 */
  function groupIntoLines(symbols) {
    const withY = symbols.map((s) => ({ s, cy: (s.bbox.y0 + s.bbox.y1) / 2, h: Math.max(1, s.bbox.y1 - s.bbox.y0) }));
    withY.sort((a, b) => a.cy - b.cy);
    const lines = [];
    for (const w of withY) {
      let line = lines.find((l) => Math.abs(l.cy - w.cy) <= Math.max(l.h, w.h) * 0.5);
      if (!line) { line = { cy: w.cy, h: w.h, syms: [] }; lines.push(line); }
      line.syms.push(w.s);
    }
    lines.sort((a, b) => a.cy - b.cy);
    for (const l of lines) l.syms.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    return lines.map((l) => l.syms);
  }

  /**
   * 렌더링된 페이지 캔버스를 OCR해 extractText()와 같은 형태로 반환한다.
   * 진한 배경/밝은 글자 영역(표 헤더 등)이 있으면 색을 반전한 사본도 함께
   * 인식해 결과를 합친다 — 일반 OCR은 밝은 배경/어두운 글자를 전제로 하므로
   * 반전 없이는 그런 영역을 거의 인식하지 못한다(실제 감사보고서 샘플로
   * 검증하며 발견함).
   * @param {*} worker      getOcrWorker()로 만든 워커
   * @param {HTMLCanvasElement} canvas  OCR용으로 렌더링된 페이지 캔버스
   * @param {number} ocrScale  캔버스를 렌더링할 때 쓴 배율(1pt = ocrScale px)
   * @param {object} meta   { widthPts, heightPts } — 페이지 크기(포인트)
   * @param {object} [opts] { tryInverted: boolean(기본 true, 어두운 영역이 있을 때만 실제로 두 번째 패스 실행) }
   */
  async function ocrCanvasToRec(worker, canvas, ocrScale, meta, opts) {
    opts = opts || {};
    const ret1 = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const passes = [flattenSymbols(ret1)];

    if (opts.tryInverted !== false && hasDarkRegions(canvas)) {
      const inv = invertCanvas(canvas);
      const ret2 = await worker.recognize(inv, {}, { blocks: true, text: false });
      passes.push(flattenSymbols(ret2));
    }

    const merged = mergeSymbolPasses(passes);
    const lines = groupIntoLines(merged);

    let text = "";
    const charMap = [];
    const items = [];
    function pushChar(ch, bbox) {
      const widthPts = Math.max(0.01, (bbox.x1 - bbox.x0) / ocrScale);
      const heightPts = Math.max(1, bbox.y1 - bbox.y0) / ocrScale;
      const fh = heightPts / 1.18;
      const bottomPts = meta.heightPts - bbox.y1 / ocrScale;
      const baseline = bottomPts + fh * 0.28;
      const item = { str: ch, width: widthPts, transform: [fh, 0, 0, fh, bbox.x0 / ocrScale, baseline], _gStart: charMap.length };
      items.push(item);
      text += ch;
      charMap.push({ item, offset: 0 });
    }
    function pushSep(ch) { text += ch; charMap.push(null); }

    // Tesseract의 "단어(word)" 경계는 한글에서 신뢰할 수 없다(음절 하나하나를
    // 따로 단어로 잘라버리는 경우가 실측에서 흔함 — 모델을 fast→best로
    // 바꿔도 동일). 그래서 word 단위로 공백을 넣지 않고, 한 줄의 모든 글자를
    // 평평하게 모아 "실제 픽셀 간격"으로 띄어쓰기 여부를 판단한다: 간격이
    // 글자 높이의 일정 비율보다 크면 실제 공백으로, 아니면 붙여쓴 것으로 본다.
    const SPACE_GAP_RATIO = 0.55; // 이 줄 평균 글자 폭 대비, 이보다 넓은 간격만 진짜 공백으로 본다
    let firstLine = true;
    for (const syms of lines) {
      if (!firstLine) pushSep("\n");
      firstLine = false;
      const avgW = syms.length
        ? syms.reduce((sum, s) => sum + Math.max(1, s.bbox.x1 - s.bbox.x0), 0) / syms.length
        : 10;
      let prev = null;
      for (const s of syms) {
        if (prev) {
          const gap = s.bbox.x0 - prev.bbox.x1;
          if (gap > avgW * SPACE_GAP_RATIO) pushSep(" ");
        }
        pushChar(s.text, s.bbox);
        prev = s;
      }
    }
    return { text, charMap, items };
  }

  global.MaskOCR = {
    getOcrWorker, ocrCanvasToRec, idbPut, base64ToBytes,
    hasDarkRegions, invertCanvas, mergeSymbolPasses, groupIntoLines,
  };
})(window);
