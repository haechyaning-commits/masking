/**
 * app.js
 * ------------------------------------------------------------------
 * 전체 흐름 조율:
 *  PDF 업로드 → pdf.js로 텍스트/좌표 추출 + 페이지 렌더링
 *  → 정규식 탐지(detectors.js) → 좌표로 오버레이 박스 표시
 *  → 사용자 포함/제외 토글 → pdf-lib로 마스킹 PDF 생성/다운로드
 *
 * 모든 처리는 브라우저 안에서만 이뤄지며, 파일은 서버로 전송되지 않는다.
 */
(function () {
  "use strict";

  const { CATEGORIES, detect } = window.PIIDetector;

  // pdf.js worker 설정 (로컬 벤더링)
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  // 페이지를 화면에 렌더링할 배율
  const VIEW_SCALE = 1.3;
  // "완전 제거(이미지화)" 모드에서 페이지를 래스터화할 배율(선명도)
  const RASTER_SCALE = 2.0;

  // ----- 애플리케이션 상태 -----
  const state = {
    fileName: "",
    originalBytes: null, // ArrayBuffer (pdf-lib 로드용 원본)
    pageMeta: [],        // [{ index, widthPts, heightPts }]
    detections: [],      // [{ id, pageIndex, category, value, rects:[{x,y,w,h}], included }]
  };

  // ----- DOM 참조 -----
  const el = {
    fileInput: document.getElementById("fileInput"),
    dropZone: document.getElementById("dropZone"),
    fileName: document.getElementById("fileName"),
    summaryPanel: document.getElementById("summaryPanel"),
    downloadPanel: document.getElementById("downloadPanel"),
    catList: document.getElementById("catList"),
    totalCount: document.getElementById("totalCount"),
    downloadBtn: document.getElementById("downloadBtn"),
    viewer: document.getElementById("viewer"),
    viewerEmpty: document.getElementById("viewerEmpty"),
    pages: document.getElementById("pages"),
    loader: document.getElementById("loader"),
    loaderText: document.getElementById("loaderText"),
  };

  // ================================================================
  // 유틸
  // ================================================================
  function showLoader(text) {
    el.loaderText.textContent = text || "처리 중…";
    el.loader.hidden = false;
  }
  function hideLoader() {
    el.loader.hidden = true;
  }

  let detIdSeq = 0;

  // ================================================================
  // 1. 파일 입력 (클릭 / 드래그앤드롭)
  // ================================================================
  el.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFile(file);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.add("is-dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    el.dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropZone.classList.remove("is-dragover");
    })
  );
  el.dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  async function handleFile(file) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      alert("PDF 파일만 업로드할 수 있습니다.");
      return;
    }
    try {
      showLoader("PDF를 읽는 중…");
      resetState();
      state.fileName = file.name;
      state.originalBytes = await file.arrayBuffer();

      el.fileName.textContent = file.name;
      el.fileName.hidden = false;

      await processPdf(state.originalBytes.slice(0)); // pdf.js가 버퍼를 소비하므로 복사본 전달
      renderSummary();

      el.summaryPanel.hidden = false;
      el.downloadPanel.hidden = false;
      el.viewerEmpty.hidden = true;
    } catch (err) {
      console.error(err);
      alert("PDF 처리 중 오류가 발생했습니다.\n" + (err && err.message ? err.message : err));
    } finally {
      hideLoader();
    }
  }

  function resetState() {
    state.pageMeta = [];
    state.detections = [];
    detIdSeq = 0;
    el.pages.innerHTML = "";
    el.catList.innerHTML = "";
    el.totalCount.textContent = "0";
  }

  // ================================================================
  // 2. PDF 처리: 페이지별 렌더링 + 텍스트 추출 + 탐지
  // ================================================================
  async function processPdf(buffer) {
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let hadAnyText = false;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      showLoader(`페이지 분석 중… (${pageNum}/${pdf.numPages})`);
      const page = await pdf.getPage(pageNum);

      // scale=1 뷰포트 = PDF 포인트 단위(좌하단 원점) 기준. pdf-lib 좌표와 일치.
      const baseViewport = page.getViewport({ scale: 1 });
      const pageIndex = pageNum - 1;
      state.pageMeta.push({
        index: pageIndex,
        widthPts: baseViewport.width,
        heightPts: baseViewport.height,
      });

      // 2-1. 페이지 렌더링
      const pageWrap = await renderPage(page, pageIndex, baseViewport);

      // 2-2. 텍스트 추출 + 좌표 매핑
      const { text, charMap } = await extractText(page);
      if (text.trim().length > 0) hadAnyText = true;

      // 2-3. 탐지 + 좌표 변환
      const matches = detect(text);
      for (const match of matches) {
        const rects = matchToRects(match, charMap);
        if (rects.length === 0) continue;
        const det = {
          id: "det-" + detIdSeq++,
          pageIndex,
          category: match.category,
          value: match.value,
          rects,
          included: true,
        };
        state.detections.push(det);
        drawOverlayBox(det, pageWrap, state.pageMeta[pageIndex]);
      }
    }

    if (!hadAnyText) {
      alert(
        "이 PDF에서 텍스트를 추출하지 못했습니다.\n" +
          "스캔본(이미지) PDF는 이번 MVP에서 지원하지 않습니다. (OCR 필요)"
      );
    }
  }

  /** 페이지를 캔버스에 렌더링하고 오버레이 컨테이너가 있는 wrap 요소를 반환 */
  async function renderPage(page, pageIndex, baseViewport) {
    const viewport = page.getViewport({ scale: VIEW_SCALE });
    const outputScale = window.devicePixelRatio || 1;

    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";

    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const label = document.createElement("span");
    label.className = "page-label";
    label.textContent = `p. ${pageIndex + 1}`;

    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    wrap.appendChild(label);
    el.pages.appendChild(wrap);

    const ctx = canvas.getContext("2d");
    await page.render({
      canvasContext: ctx,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    }).promise;

    wrap._overlay = overlay;
    return wrap;
  }

  /**
   * 페이지 텍스트를 하나의 문자열로 이어붙이고,
   * 각 문자 → 원본 텍스트 조각(item) 및 조각 내 위치를 기록한다.
   * 이렇게 하면 여러 조각에 걸친 패턴도 탐지·좌표화할 수 있다.
   */
  async function extractText(page) {
    const content = await page.getTextContent();
    let text = "";
    const charMap = []; // 각 문자에 대응: { item, offset } 또는 null(구분자)

    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      for (let i = 0; i < item.str.length; i++) {
        text += item.str[i];
        charMap.push({ item, offset: i });
      }
      if (item.hasEOL) {
        text += "\n";
        charMap.push(null);
      }
    }
    return { text, charMap };
  }

  /**
   * 탐지 구간(match)을 PDF 좌표(좌하단 원점, 포인트 단위) 사각형 목록으로 변환.
   * 구간이 여러 텍스트 조각에 걸치면 조각별로 사각형을 만든다.
   */
  function matchToRects(match, charMap) {
    const groups = []; // 조각별 연속 구간: { item, startOffset, endOffset }
    let cur = null;

    for (let idx = match.start; idx < match.end; idx++) {
      const entry = charMap[idx];
      if (!entry) {
        if (cur) { groups.push(cur); cur = null; }
        continue;
      }
      if (cur && cur.item === entry.item) {
        cur.endOffset = entry.offset;
      } else {
        if (cur) groups.push(cur);
        cur = { item: entry.item, startOffset: entry.offset, endOffset: entry.offset };
      }
    }
    if (cur) groups.push(cur);

    return groups.map((g) => itemSubRect(g.item, g.startOffset, g.endOffset)).filter(Boolean);
  }

  // 글자별 폭을 근사 측정하기 위한 오프스크린 캔버스
  const _measureCanvas = document.createElement("canvas");
  const _measureCtx = _measureCanvas.getContext("2d");

  /**
   * 텍스트 조각 내 [startOffset..endOffset] 문자들이 차지하는 영역을
   * PDF 포인트 좌표 사각형으로 계산한다. (가로쓰기 기준)
   *
   * 프로포셔널 폰트에서 "문자폭 균등" 가정은 조각이 길수록 오차가 누적되어
   * 마스킹 박스가 어긋난다(앞자리 누락 등). 이를 막기 위해 canvas의 measureText로
   * 각 글자의 상대 폭을 구하고, pdf.js가 알려준 실제 조각 폭(item.width)에 맞춰
   * 스케일링한다. (폰트가 완전히 같지 않아도 비율 근사가 균등 가정보다 훨씬 정확)
   */
  function itemSubRect(item, startOffset, endOffset) {
    const t = item.transform; // [a,b,c,d,e,f]
    if (!t) return null;
    const x0 = t[4];
    const yBaseline = t[5];
    const fontHeight = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const str = item.str;
    const totalWidth = item.width || fontHeight * (str.length || 1);

    _measureCtx.font = "32px sans-serif"; // 비율만 쓰므로 크기·패밀리는 임의
    const measuredFull = _measureCtx.measureText(str).width || 1;
    const scale = totalWidth / measuredFull;

    const preWidth = _measureCtx.measureText(str.slice(0, startOffset)).width * scale;
    const matchWidth =
      _measureCtx.measureText(str.slice(startOffset, endOffset + 1)).width * scale;

    const descent = fontHeight * 0.25;
    // 마스킹이 글자를 확실히 덮도록 약간의 여유(padding)를 둔다.
    const padX = fontHeight * 0.06;
    return {
      x: x0 + preWidth - padX,
      y: yBaseline - descent,
      w: matchWidth + padX * 2,
      h: fontHeight * 1.2,
    };
  }

  // ================================================================
  // 3. 오버레이 박스 (검토 UI)
  // ================================================================
  function drawOverlayBox(det, pageWrap, meta) {
    const cat = CATEGORIES[det.category];
    const overlay = pageWrap._overlay;

    for (const r of det.rects) {
      const box = document.createElement("div");
      box.className = "det-box is-included";
      box.style.borderColor = cat.color;
      // PDF 좌표(좌하단 원점) → CSS 좌표(좌상단 원점) 변환
      box.style.left = r.x * VIEW_SCALE + "px";
      box.style.top = (meta.heightPts - (r.y + r.h)) * VIEW_SCALE + "px";
      box.style.width = r.w * VIEW_SCALE + "px";
      box.style.height = r.h * VIEW_SCALE + "px";
      box.dataset.detId = det.id;

      const tip = document.createElement("span");
      tip.className = "det-box__tip";
      tip.textContent = `${cat.label}: ${det.value}`;
      box.appendChild(tip);

      box.addEventListener("click", () => toggleDetection(det.id));
      overlay.appendChild(box);
    }
    det._boxes = det._boxes || [];
  }

  function refreshBoxStyles(det) {
    const boxes = document.querySelectorAll(`.det-box[data-det-id="${det.id}"]`);
    boxes.forEach((box) => {
      box.classList.toggle("is-included", det.included);
      box.classList.toggle("is-excluded", !det.included);
    });
  }

  function toggleDetection(detId) {
    const det = state.detections.find((d) => d.id === detId);
    if (!det) return;
    det.included = !det.included;
    refreshBoxStyles(det);
    updateCategoryCheckbox(det.category);
    updateTotalCount();
  }

  // ================================================================
  // 4. 좌측 요약 패널
  // ================================================================
  function renderSummary() {
    el.catList.innerHTML = "";
    for (const key of Object.keys(CATEGORIES)) {
      const cat = CATEGORIES[key];
      const items = state.detections.filter((d) => d.category === key);

      const li = document.createElement("li");
      li.className = "cat-item" + (items.length === 0 ? " is-empty" : "");
      li.dataset.category = key;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = items.length > 0;
      cb.disabled = items.length === 0;
      cb.addEventListener("change", () => toggleCategory(key, cb.checked));

      const swatch = document.createElement("span");
      swatch.className = "cat-item__swatch";
      swatch.style.background = cat.color;

      const label = document.createElement("span");
      label.className = "cat-item__label";
      label.textContent = cat.label;

      const count = document.createElement("span");
      count.className = "cat-item__count";
      count.textContent = items.length + "건";

      li.append(cb, swatch, label, count);
      el.catList.appendChild(li);
    }
    updateTotalCount();
  }

  function toggleCategory(category, included) {
    state.detections
      .filter((d) => d.category === category)
      .forEach((d) => {
        d.included = included;
        refreshBoxStyles(d);
      });
    updateTotalCount();
  }

  /** 개별 토글 후, 카테고리 체크박스를 (전체 포함 여부에 따라) 동기화 */
  function updateCategoryCheckbox(category) {
    const li = el.catList.querySelector(`.cat-item[data-category="${category}"]`);
    if (!li) return;
    const cb = li.querySelector("input[type=checkbox]");
    const items = state.detections.filter((d) => d.category === category);
    const anyIncluded = items.some((d) => d.included);
    cb.checked = anyIncluded;
    cb.indeterminate = anyIncluded && items.some((d) => !d.included);
  }

  function updateTotalCount() {
    const n = state.detections.filter((d) => d.included).length;
    el.totalCount.textContent = String(n);
    el.downloadBtn.disabled = n === 0;
  }

  // ================================================================
  // 5. 마스킹 PDF 생성 & 다운로드
  // ================================================================
  el.downloadBtn.addEventListener("click", async () => {
    const mode = document.querySelector('input[name="maskMode"]:checked').value;
    const included = state.detections.filter((d) => d.included);
    if (included.length === 0) return;

    try {
      showLoader("마스킹 PDF를 생성하는 중…");
      const bytes =
        mode === "raster"
          ? await buildRasterizedPdf(included)
          : await buildVectorMaskedPdf(included);
      downloadBytes(bytes, maskedFileName(state.fileName));
    } catch (err) {
      console.error(err);
      alert("마스킹 PDF 생성 중 오류가 발생했습니다.\n" + (err && err.message ? err.message : err));
    } finally {
      hideLoader();
    }
  });

  /** 방식 A: pdf-lib로 원본 위에 검은 사각형만 그린다. (텍스트 레이어 유지) */
  async function buildVectorMaskedPdf(included) {
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.load(state.originalBytes.slice(0));
    const pages = doc.getPages();

    for (const det of included) {
      const page = pages[det.pageIndex];
      if (!page) continue;
      for (const r of det.rects) {
        page.drawRectangle({
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          color: rgb(0, 0, 0),
        });
      }
    }
    return doc.save();
  }

  /**
   * 방식 B(권장): 각 페이지를 이미지로 렌더링하면서 마스킹 영역을 검게 칠하고,
   * 그 이미지만으로 새 PDF를 만든다. 원본 텍스트 레이어가 사라지므로
   * 마스킹된 글자가 추출되지 않는다(진짜 제거).
   */
  async function buildRasterizedPdf(included) {
    const { PDFDocument } = PDFLib;
    const outDoc = await PDFDocument.create();

    const pdf = await pdfjsLib.getDocument({ data: state.originalBytes.slice(0) }).promise;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      showLoader(`이미지화 중… (${pageNum}/${pdf.numPages})`);
      const page = await pdf.getPage(pageNum);
      const pageIndex = pageNum - 1;
      const meta = state.pageMeta[pageIndex];
      const viewport = page.getViewport({ scale: RASTER_SCALE });

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;

      // 마스킹 영역을 캔버스 위에 검게 칠한다.
      ctx.fillStyle = "#000000";
      for (const det of included) {
        if (det.pageIndex !== pageIndex) continue;
        for (const r of det.rects) {
          const cx = r.x * RASTER_SCALE;
          const cy = (meta.heightPts - (r.y + r.h)) * RASTER_SCALE;
          ctx.fillRect(cx, cy, r.w * RASTER_SCALE, r.h * RASTER_SCALE);
        }
      }

      const pngBytes = await canvasToPngBytes(canvas);
      const img = await outDoc.embedPng(pngBytes);
      const outPage = outDoc.addPage([meta.widthPts, meta.heightPts]);
      outPage.drawImage(img, { x: 0, y: 0, width: meta.widthPts, height: meta.heightPts });
    }

    return outDoc.save();
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("캔버스 변환 실패"));
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, "image/png");
    });
  }

  function maskedFileName(name) {
    return name.replace(/\.pdf$/i, "") + "_masked.pdf";
  }

  function downloadBytes(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
})();
