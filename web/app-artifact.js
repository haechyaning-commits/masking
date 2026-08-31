/**
 * app-artifact.js — 단일 파일(아티팩트) 버전
 *  · 번호류(주민/전화/이메일/계좌/카드): 정규식 자동 탐지
 *  · 이름·기관/부서: 단어목록 + 접미어 규칙(접미어는 유지) + 성명 라벨 규칙 +
 *      표 열 구조 인식("성명" 열 헤더 아래 칸 전부) + 성씨 사전(베타)
 *  · 수동 마스킹: 페이지 위 드래그로 직접 지정
 *  · 마스킹 수준: 부분(표준) / 전체 선택
 *      - 부분: 주민번호 뒤7·전화 뒤4·이메일 아이디 일부·계좌 앞6 유지·카드 앞6뒤4 유지·이름 가운데
 *      - 전체: 값 전체 (번호=검은박스, 이름=마스킹 문자)
 *  · 출력: 페이지 이미지화(완전 제거) → 원본 글자까지 제거
 */
(function () {
  "use strict";
  const { CATEGORIES, detect, findEntities } = window.PIIDetector;
  // mask-engine.js: DOM/화면과 무관한 좌표계산·드래그스냅·부분마스킹규칙·
  // 기호배정·최종 래스터 생성 로직 — 화면단(이 파일)만 바뀌어도 그대로 재사용된다.
  const {
    extractText, findTokenAtPoint, rangeRects,
    snapDragToText, piiPartial, createSymbolAssigner, buildRaster: engineBuildRaster,
  } = window.MaskEngine;

  try {
    const workerText = document.getElementById("pdfWorkerSrc").textContent;
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerText], { type: "application/javascript" }));
  } catch (e) { console.warn("worker 설정 실패", e); }

  const VIEW_SCALE = 1.3, RASTER_SCALE = 3.0, OCR_SCALE = 3.0;
  const SYMBOL_FONT = '"WenQuanYi Zen Hei", "Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  // 검토(자동 탐지) 리포트에는 번호류만 — 이름·기관/수동은 각 단계에서 별도 표시
  const AUTO_CATS = [
    { id: "rrn", label: "주민등록번호" }, { id: "phone", label: "전화번호" },
    { id: "email", label: "이메일" }, { id: "card", label: "카드번호" },
    { id: "account", label: "계좌번호" },
  ];
  const AUTO_IDS = AUTO_CATS.map((c) => c.id);

  // 수동 마스킹 기본 방식은 화면의 기본 선택 라디오("문자")와 반드시 일치해야 한다.
  // 하드코딩하면 마크업 기본값이 바뀔 때 또 어긋날 수 있어 DOM에서 직접 읽는다.
  const initialMstyle = (document.querySelector('input[name="mstyle"]:checked') || {}).value || "symbol";
  const state = {
    fileName: "", originalBytes: null, pages: [], dets: [],
    maskChar: "*", maskLevel: "partial", manualMode: false, manualStyle: initialMstyle,
  };
  // 이름·직접지정(문자 방식) 마스킹 기호 순환 배정기(사람마다 다른 기호) — mask-engine.js
  const symbolAssigner = createSymbolAssigner();
  let detIdSeq = 0, lastUrl = null, lastBytes = null;

  const el = {
    msg: id("msg"), drop: id("drop"), fileInput: id("fileInput"), fname: id("fname"),
    reportCard: id("reportCard"), entityCard: id("entityCard"), manualCard: id("manualCard"), dlCard: id("dlCard"),
    cats: id("cats"), totalCount: id("totalCount"),
    wordList: id("wordList"), suffixRule: id("suffixRule"), nameLabelRule: id("nameLabelRule"), nameDictRule: id("nameDictRule"),
    tableColumnRule: id("tableColumnRule"),
    symPicker: id("symPicker"), applyEntities: id("applyEntities"),
    manualToggle: id("manualToggle"), sameWord: id("sameWord"), genBtn: id("genBtn"), result: id("result"),
    dlLink: id("dlLink"), dlLink2: id("dlLink2"), previewBtn: id("previewBtn"),
    previewModal: id("previewModal"), pvBody: id("pvBody"), pvClose: id("pvClose"),
    empty: id("empty"), pages: id("pages"), loader: id("loader"), loaderText: id("loaderText"),
    undoBtn: id("undoBtn"), pvEdit: id("pvEdit"),
    uploadMeta: id("uploadMeta"), autoMeta: id("autoMeta"), entityMeta: id("entityMeta"),
    manualMeta: id("manualMeta"), totalMeta: id("totalMeta"),
  };
  function id(x) { return document.getElementById(x); }
  const catColor = (c) => "var(--cat-" + c + ")";
  const showLoader = (t) => { el.loaderText.textContent = t || "처리 중…"; el.loader.hidden = false; };
  const hideLoader = () => { el.loader.hidden = true; };
  const showMessage = (h, k) => { el.msg.innerHTML = h; el.msg.className = "msg " + (k || "info"); el.msg.hidden = false; };
  const clearMessage = () => { el.msg.hidden = true; };

  // ================= 파일 입력 =================
  el.fileInput.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) handleFile(f); });
  ["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("drag"); }));
  el.drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });

  async function handleFile(file) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { showMessage("PDF 파일만 업로드할 수 있습니다.", "err"); return; }
    const watchdog = setTimeout(() => { hideLoader(); showMessage("<b>처리가 오래 걸립니다.</b> 문서가 크거나 이 환경(샌드박스)에서 PDF 엔진이 제한됐을 수 있습니다. 첨부된 <b>독립 실행 HTML</b>을 이용해 보세요.", "warn"); }, 90000);
    try {
      clearMessage(); showLoader("PDF를 읽는 중…"); resetState();
      state.fileName = file.name; state.originalBytes = await file.arrayBuffer();
      el.fname.hidden = false; el.fname.querySelector("span").textContent = file.name;
      const { hadRealText, ocrPages } = await processPdf(state.originalBytes.slice(0));
      reDetectEntities(); renderReport();
      [el.reportCard, el.entityCard, el.manualCard, el.dlCard].forEach((c) => (c.hidden = false));
      el.empty.hidden = true; el.undoBtn.hidden = false;
      el.uploadMeta.textContent = state.pages.length + "쪽";
      const hadAnyText = hadRealText || state.pages.some((p) => p.text.trim());
      if (!hadAnyText) {
        showMessage("이 PDF에서 <b>텍스트를 찾지 못했습니다.</b> 스캔본으로 보고 OCR을 시도했지만 인식에 실패했습니다(해상도가 너무 낮거나 손글씨일 수 있음). <b>직접 지정(클릭/드래그)</b>으로 가려주세요.", "warn");
      } else if (ocrPages.length) {
        showMessage(`<b>${ocrPages.length}쪽</b>은 텍스트 레이어가 없어 OCR로 인식했습니다(${ocrPages.join(", ")}쪽). OCR은 실제 텍스트보다 <b>오탐·누락이 더 있을 수 있으니</b> 검토 화면에서 특히 꼼꼼히 확인하세요. 이름 자동탐지(라벨·표 열 인식)는 OCR 페이지에서 정확도가 낮습니다 — 필요하면 직접 지정을 함께 쓰세요.`, "warn");
      }
    } catch (err) { console.error(err); showMessage("<b>PDF 처리 중 오류.</b> " + (err && err.message ? err.message : err), "err"); }
    finally { clearTimeout(watchdog); hideLoader(); }
  }
  function resetState() {
    state.pages = []; state.dets = []; detIdSeq = 0; symbolAssigner.clear();
    el.pages.innerHTML = ""; el.cats.innerHTML = ""; el.totalCount.textContent = "0";
    el.result.hidden = true; el.previewModal.hidden = true;
    history.length = 0; updateUndo(); el.undoBtn.hidden = true;
    el.autoMeta.textContent = el.entityMeta.textContent = el.manualMeta.textContent = el.totalMeta.textContent = el.uploadMeta.textContent = "";
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
    // 새 파일이면 이름·기관 가리기 입력도 초기화 → 새 문서에 맞춰 새로 작성.
    el.wordList.value = "";
    if (el.suffixRule) el.suffixRule.checked = true;
    if (el.nameLabelRule) el.nameLabelRule.checked = true;
    if (el.nameDictRule) el.nameDictRule.checked = false; // 베타 기능은 새 문서에서도 기본 꺼짐 유지
    if (el.tableColumnRule) el.tableColumnRule.checked = true;
    // 직접 지정(수동) 모드도 끈 상태로 되돌린다.
    state.manualMode = false;
    if (el.sameWord) el.sameWord.checked = false;
    if (el.manualToggle) {
      el.manualToggle.setAttribute("aria-pressed", "false");
      el.manualToggle.textContent = "✏️ 직접 지정 모드 켜기";
    }
  }

  // ================= OCR(스캔본) =================
  // 텍스트 레이어가 없는 페이지(스캔본)를 위한 Tesseract.js 워커. 최초 필요한
  // 시점에 한 번만 만들고(완전 오프라인 — 코드/학습데이터 전부 이 파일 안에
  // 내장) 이후 페이지들은 재사용한다.
  function getOcrWorker() {
    return window.MaskOCR.getOcrWorker({
      coreText: document.getElementById("tessCoreSrc").textContent,
      workerText: document.getElementById("tessWorkerSrc").textContent,
      korDataB64: document.getElementById("tessKorData").textContent,
    });
  }
  /** OCR 전용 고해상도 렌더 — 화면 표시용 캔버스(VIEW_SCALE)와는 별도로 오프스크린에 그림 */
  async function renderForOcr(page) {
    const viewport = page.getViewport({ scale: OCR_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    return canvas;
  }

  // ================= PDF 처리 =================
  async function processPdf(buffer) {
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let hadRealText = false;
    const ocrPages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      showLoader(`페이지 분석 중… (${n}/${pdf.numPages})`);
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 }), pageIndex = n - 1;
      const meta = { widthPts: base.width, heightPts: base.height };
      const pw = await renderPage(page, pageIndex);
      let { text, charMap, items } = await extractText(page);
      let isOcr = false;
      if (text.trim()) {
        hadRealText = true;
        // 각 텍스트 조각의 실제 임베드 폰트명을 저장 → 마스킹 위치를 정확히 측정
        for (const item of items) { try { const fo = page.commonObjs.get(item.fontName); if (fo && fo.loadedName) item._font = fo.loadedName; } catch (e) {} }
      } else {
        // 텍스트 레이어가 전혀 없는 페이지 — 스캔본으로 보고 OCR 시도.
        // 번호류(주민번호·전화·계좌·카드·이메일)는 실측으로 잘 잡히지만, 이름
        // 자동탐지(라벨/표 열/사전)는 OCR 특성상 정확도가 떨어질 수 있다(README 참고).
        try {
          showLoader(`OCR로 스캔본 인식 중… (${n}/${pdf.numPages})`);
          const worker = await getOcrWorker();
          const canvas = await renderForOcr(page);
          const ocrRec = await window.MaskOCR.ocrCanvasToRec(worker, canvas, OCR_SCALE, meta);
          text = ocrRec.text; charMap = ocrRec.charMap; items = ocrRec.items;
          if (text.trim()) { isOcr = true; ocrPages.push(n); }
        } catch (e) { console.warn("OCR 실패(페이지 " + n + ")", e); }
      }
      const rec = { pageIndex, meta, text, charMap, items, ov: pw._ov, pw, isOcr };
      state.pages.push(rec); enableManualDrag(rec);
      for (const m of detect(text)) {
        const full = rangeRects(m.start, m.end, charMap);
        if (!full.length) continue;
        const [pa, pb] = piiPartial(m.category, text, m.start, m.end);
        addDet({ pageIndex, category: m.category, source: "pii", style: "box",
          fullRects: full, partialRects: rangeRects(pa, pb, charMap), value: m.value });
      }
    }
    return { hadRealText, ocrPages };
  }
  async function renderPage(page, pageIndex) {
    const viewport = page.getViewport({ scale: VIEW_SCALE }), outputScale = window.devicePixelRatio || 1;
    const pw = document.createElement("div"); pw.className = "pw";
    pw.style.width = viewport.width + "px"; pw.style.height = viewport.height + "px";
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale); canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
    const ov = document.createElement("div"); ov.className = "ov";
    const label = document.createElement("span"); label.className = "plabel"; label.textContent = "p. " + (pageIndex + 1);
    pw.append(canvas, ov, label); el.pages.appendChild(pw);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null }).promise;
    pw._ov = ov; return pw;
  }
  // 같은 단어를 문서 전체에서 찾아 마스킹(중복 구간은 건너뜀).
  function maskWordEverywhere(word) {
    if (!word) return;
    for (const r of state.pages) {
      let from = 0, idx;
      while ((idx = r.text.indexOf(word, from)) !== -1) {
        from = idx + word.length;
        const key = idx + ":" + (idx + word.length);
        if (state.dets.some((d) => d.source === "manual" && d.pageIndex === r.pageIndex && d.rangeKey === key)) continue;
        const rects = rangeRects(idx, idx + word.length, r.charMap);
        if (rects.length) addDet({ pageIndex: r.pageIndex, category: "manual", source: "manual", style: state.manualStyle, fullRects: rects, partialRects: rects, value: word, rangeKey: key, wordMatch: true });
      }
    }
  }
  function maskToken(rec, tok) {
    snapshot();
    if (el.sameWord && el.sameWord.checked && tok.token.length >= 1) {
      maskWordEverywhere(tok.token);
    } else {
      const key = tok.start + ":" + tok.end;
      const rects = rangeRects(tok.start, tok.end, rec.charMap);
      if (rects.length) addDet({ pageIndex: rec.pageIndex, category: "manual", source: "manual", style: state.manualStyle, fullRects: rects, partialRects: rects, value: tok.token, rangeKey: key, wordMatch: true });
    }
    renderReport();
  }

  // ================= 이름·기관 재탐지 =================
  function currentWords() { return el.wordList.value.split(/\n+/).map((s) => s.trim()).filter(Boolean); }
  function reDetectEntities() {
    removeDetsBySource("entity");
    const words = currentWords(), useSuffixRule = el.suffixRule.checked;
    const useNameLabelRule = el.nameLabelRule.checked, useNameDict = el.nameDictRule.checked;
    const useTableColumnRule = el.tableColumnRule.checked;
    for (const rec of state.pages) {
      for (const e of findEntities(rec.text, { words, useSuffixRule, useNameLabelRule, useNameDict, useTableColumnRule, items: rec.items })) {
        const full = rangeRects(e.maskStart, e.maskEnd, rec.charMap);
        if (!full.length) continue;
        // 사람 이름(접미어 없음·2~4 한글)은 부분 시 가운데만, 그 외(기관)는 전체 동일
        const isName = e.maskEnd === e.end && /^[가-힣]{2,4}$/.test(rec.text.slice(e.maskStart, e.maskEnd));
        let pa = e.maskStart, pb = e.maskEnd;
        if (isName) { const len = e.maskEnd - e.maskStart; pa = e.maskStart + 1; pb = len <= 2 ? e.maskEnd : e.maskEnd - 1; }
        const masked = rec.text.slice(e.maskStart, e.maskEnd), kept = rec.text.slice(e.maskEnd, e.end);
        // 자동탐지 출처를 말풍선에 표시 — 특히 사전(베타) 결과는 오탐 가능성이 있어
        // 검토 시 "왜 걸렸는지" 구분할 수 있어야 한다.
        const kindTag = e.kind === "name-label" ? " [라벨]" : e.kind === "name-dict" ? " [사전·베타]" : e.kind === "name-column" ? " [표 열]" : "";
        addDet({ pageIndex: rec.pageIndex, category: "name", source: "entity", style: "symbol",
          fullRects: full, partialRects: rangeRects(pa, pb, rec.charMap), value: masked + kindTag + (kept ? " +『" + kept + "』유지" : ""), entityKey: masked });
      }
    }
  }

  // ================= 마스킹 항목 & 오버레이 =================
  function addDet(d) {
    d.id = "d" + detIdSeq++; d.included = d.included !== false;
    if (!d.partialRects || !d.partialRects.length) d.partialRects = d.fullRects;
    state.dets.push(d); drawBoxes(d); return d;
  }
  function activeRects(det) { return (state.maskLevel === "partial" && det.source !== "manual") ? det.partialRects : det.fullRects; }
  function pageRec(idx) { return state.pages.find((p) => p.pageIndex === idx); }

  function drawBoxes(det) {
    const rec = pageRec(det.pageIndex); if (!rec) return;
    const meta = rec.meta;
    // 검토 오버레이는 '탐지된 전체'를 표시(확인용). 실제 부분 마스킹은 출력에만 적용.
    for (const r of det.fullRects) {
      const box = document.createElement("div");
      box.className = "box " + (det.included ? "on" : "off") + (det.style === "symbol" ? " symbol" : "") + (det.source === "manual" ? " manual" : "");
      box.style.borderColor = catColor(det.category);
      box.style.left = r.x * VIEW_SCALE + "px";
      box.style.top = (meta.heightPts - (r.y + r.h)) * VIEW_SCALE + "px";
      box.style.width = r.w * VIEW_SCALE + "px";
      box.style.height = r.h * VIEW_SCALE + "px";
      box.dataset.det = det.id;
      if (det.value) { const tip = document.createElement("span"); tip.className = "box__tip"; tip.textContent = det.value; box.appendChild(tip); }
      box.addEventListener("click", (ev) => { ev.stopPropagation(); if (det.source === "manual") removeManualDet(det); else toggleDet(det.id); });
      rec.ov.appendChild(box);
    }
  }
  function boxesOf(idv) { return document.querySelectorAll('.box[data-det="' + idv + '"]'); }
  function refreshBox(det) { boxesOf(det.id).forEach((b) => { b.classList.toggle("on", det.included); b.classList.toggle("off", !det.included); }); }
  function toggleDet(idv) { const d = state.dets.find((x) => x.id === idv); if (!d) return; snapshot(); d.included = !d.included; refreshBox(d); renderReport(); }
  function removeDet(idv) { snapshot(); boxesOf(idv).forEach((b) => b.remove()); state.dets = state.dets.filter((x) => x.id !== idv); renderReport(); }
  // 수동 마스킹 박스 삭제: "같은 단어 함께 가리기"가 켜져 있고, 이 박스가 실제
  // 텍스트 단어를 잡은 것이면(비텍스트 드래그 사각형 제외) 같은 단어의 모든
  // 항목을 한 번에 지운다 — 추가할 때와 대칭이 되도록.
  function removeManualDet(det) {
    if (el.sameWord && el.sameWord.checked && det.wordMatch && det.value) {
      snapshot();
      const toRemove = state.dets.filter((d) => d.source === "manual" && d.wordMatch && d.value === det.value);
      toRemove.forEach((d) => boxesOf(d.id).forEach((b) => b.remove()));
      const ids = new Set(toRemove.map((d) => d.id));
      state.dets = state.dets.filter((d) => !ids.has(d.id));
      renderReport();
    } else {
      removeDet(det.id);
    }
  }
  function removeDetsBySource(src) { state.dets.filter((d) => d.source === src).forEach((d) => boxesOf(d.id).forEach((b) => b.remove())); state.dets = state.dets.filter((d) => d.source !== src); }
  function redrawOverlays() { document.querySelectorAll(".ov").forEach((o) => (o.innerHTML = "")); state.dets.forEach(drawBoxes); }

  // ================= 리포트 =================
  function renderReport() {
    el.cats.innerHTML = "";
    for (const c of AUTO_CATS) {
      const items = state.dets.filter((d) => d.category === c.id);
      const row = document.createElement("label");
      row.className = "cat" + (items.length === 0 ? " empty" : "");
      row.style.setProperty("--c", catColor(c.id)); row.dataset.cat = c.id;
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = items.some((d) => d.included); cb.disabled = items.length === 0;
      cb.indeterminate = items.some((d) => d.included) && items.some((d) => !d.included);
      cb.addEventListener("change", () => { snapshot(); items.forEach((d) => { d.included = cb.checked; refreshBox(d); }); updateMetas(); updateTotal(); });
      const name = document.createElement("span"); name.className = "cat__name"; name.textContent = c.label;
      const n = document.createElement("span"); n.className = "cat__n"; n.textContent = items.length;
      row.append(cb, name, n); el.cats.appendChild(row);
    }
    updateMetas(); updateTotal();
  }
  function cntCat(id) { return state.dets.filter((d) => d.category === id).length; }
  function updateMetas() {
    const autoTot = state.dets.filter((d) => AUTO_IDS.includes(d.category)).length;
    el.autoMeta.textContent = autoTot ? autoTot + "건" : "";
    const nm = cntCat("name"); el.entityMeta.textContent = nm ? nm + "건" : "";
    const mn = cntCat("manual"); el.manualMeta.textContent = mn ? mn + "건" : "";
  }
  function updateTotal() {
    const n = state.dets.filter((d) => d.included).length;
    el.totalCount.textContent = String(n); el.genBtn.disabled = n === 0;
    el.totalMeta.textContent = n ? n + "건" : "";
  }

  // ===== 되돌리기(Undo) =====
  const history = [];
  function snapshot() { history.push(state.dets.map((d) => ({ ...d }))); if (history.length > 40) history.shift(); updateUndo(); }
  function undo() { if (!history.length) return; state.dets = history.pop(); redrawOverlays(); renderReport(); updateUndo(); }
  function updateUndo() { el.undoBtn.disabled = history.length === 0; }
  el.undoBtn.addEventListener("click", undo);

  // ===== 단계 접기/펼치기 =====
  document.querySelectorAll(".card > .step").forEach((btn) => btn.addEventListener("click", () => {
    const card = btn.closest(".card"); card.classList.toggle("collapsed");
    btn.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
  }));

  // ================= 컨트롤 =================
  el.applyEntities.addEventListener("click", () => { snapshot(); reDetectEntities(); renderReport(); });
  el.suffixRule.addEventListener("change", () => { snapshot(); reDetectEntities(); renderReport(); });
  el.nameLabelRule.addEventListener("change", () => { snapshot(); reDetectEntities(); renderReport(); });
  el.nameDictRule.addEventListener("change", () => { snapshot(); reDetectEntities(); renderReport(); });
  el.tableColumnRule.addEventListener("change", () => { snapshot(); reDetectEntities(); renderReport(); });
  el.symPicker.addEventListener("click", (e) => {
    const b = e.target.closest(".sym"); if (!b) return;
    el.symPicker.querySelectorAll(".sym").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); state.maskChar = b.dataset.sym;
  });
  document.querySelectorAll('input[name="maskLevel"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { state.maskLevel = r.value; redrawOverlays(); } }));
  el.manualToggle.addEventListener("click", () => {
    state.manualMode = !state.manualMode;
    el.manualToggle.setAttribute("aria-pressed", String(state.manualMode));
    el.manualToggle.textContent = state.manualMode ? "✏️ 직접 지정 모드 끄기" : "✏️ 직접 지정 모드 켜기";
    state.pages.forEach((p) => p.pw.classList.toggle("manual-on", state.manualMode));
  });
  document.querySelectorAll('input[name="mstyle"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) state.manualStyle = r.value; }));

  function enableManualDrag(rec) {
    const ov = rec.ov; let startX, startY, tempEl = null;
    ov.addEventListener("mousedown", (e) => {
      if (!state.manualMode) return;
      if (e.target.closest(".box")) return; // 기존 박스 클릭은 그 박스가 처리(삭제)
      e.preventDefault();
      const rb = ov.getBoundingClientRect();
      startX = e.clientX - rb.left; startY = e.clientY - rb.top;
      tempEl = document.createElement("div"); tempEl.className = "dragrect"; ov.appendChild(tempEl);
      const move = (ev) => {
        const x = ev.clientX - rb.left, y = ev.clientY - rb.top;
        tempEl.style.left = Math.min(x, startX) + "px"; tempEl.style.top = Math.min(y, startY) + "px";
        tempEl.style.width = Math.abs(x - startX) + "px"; tempEl.style.height = Math.abs(y - startY) + "px";
      };
      const up = (ev) => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        const x = ev.clientX - rb.left, y = ev.clientY - rb.top;
        const left = Math.min(x, startX), top = Math.min(y, startY), w = Math.abs(x - startX), h = Math.abs(y - startY);
        if (tempEl) { tempEl.remove(); tempEl = null; }
        if (w < 6 && h < 6) { // 클릭 → 단어 마스킹
          const px = startX / VIEW_SCALE, py = rec.meta.heightPts - startY / VIEW_SCALE;
          const tok = findTokenAtPoint(rec, px, py);
          if (tok) maskToken(rec, tok);
          return;
        }
        if (w < 6 || h < 6) return;
        snapshot();
        const box = { x: left / VIEW_SCALE, y: rec.meta.heightPts - (top + h) / VIEW_SCALE, w: w / VIEW_SCALE, h: h / VIEW_SCALE };
        // 드래그가 글자 위를 지나면 그 글자에 딱 맞춰 마스킹(위치 부정확 보정).
        // 표·도장 등 텍스트가 없는 영역이면 드래그한 사각형 그대로 사용.
        const snapped = snapDragToText(rec, box);
        if (snapped) {
          // 클릭과 동일하게, "같은 단어 함께 가리기"가 켜져 있으면 드래그로 잡은
          // 단어(들)도 문서 전체에서 찾아 함께 마스킹한다.
          if (el.sameWord && el.sameWord.checked && snapped.tokens.length) {
            snapped.tokens.forEach(maskWordEverywhere);
          } else {
            addDet({ pageIndex: rec.pageIndex, category: "manual", source: "manual", style: state.manualStyle,
              fullRects: snapped.rects, partialRects: snapped.rects, value: snapped.text || "수동 (드래그)", wordMatch: !!snapped.text });
          }
        } else {
          addDet({ pageIndex: rec.pageIndex, category: "manual", source: "manual", style: state.manualStyle,
            fullRects: [box], partialRects: [box], value: state.manualStyle === "symbol" ? "수동 (문자)" : "수동 (검은박스)" });
        }
        renderReport();
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
  }

  // ================= 생성 (이미지화) =================
  el.genBtn.addEventListener("click", async () => {
    const included = state.dets.filter((d) => d.included);
    if (!included.length) return;
    try { showLoader("마스킹 PDF를 생성하는 중…"); showResult(await buildRaster(included)); }
    catch (err) { console.error(err); showMessage("<b>마스킹 PDF 생성 중 오류.</b> " + (err && err.message ? err.message : err), "err"); }
    finally { hideLoader(); }
  });

  // 이 화면(app-artifact.js)이 아는 건 "어떤 det이 페이지 어디에 있고 어떤 스타일인지"뿐이고,
  // 실제 래스터 생성(페이지 렌더 → 여백 계산 → 마스킹 문자 그리기 → PNG 임베드)은
  // mask-engine.js의 buildRaster에 위임한다.
  async function buildRaster(included) {
    return engineBuildRaster({
      pdfjsLib, PDFLib, originalBytes: state.originalBytes, pages: state.pages,
      RASTER_SCALE, symbolFont: SYMBOL_FONT,
      onProgress: (n, total) => showLoader(`이미지화 중… (${n}/${total})`),
      getPageRects: (pageIndex, meta) => {
        const rects = [];
        for (const det of included) {
          if (det.pageIndex !== pageIndex) continue;
          // 부분 마스킹 또는 문자 스타일 → 마스킹 문자로, 아니면 검은박스
          const useChar = (state.maskLevel === "partial" && det.source !== "manual") || det.style === "symbol";
          // 이름(entity)·직접지정(문자 방식)은 사람(단어)마다 다른 기호를 배정.
          // 번호류(주민번호·전화·이메일·계좌·카드)는 항상 사용자가 고른 마스킹 문자 하나만 사용.
          let charForDet = state.maskChar;
          if (useChar && det.category === "name") charForDet = symbolAssigner.get(det.entityKey || det.value, state.maskChar);
          else if (useChar && det.source === "manual" && det.style === "symbol") charForDet = symbolAssigner.get(det.wordMatch ? det.value : det.id, state.maskChar);
          for (const r of activeRects(det)) {
            const rx = r.x * RASTER_SCALE, ry = (meta.heightPts - (r.y + r.h)) * RASTER_SCALE, rw = r.w * RASTER_SCALE, rh = r.h * RASTER_SCALE;
            rects.push({ rx, ry, rw, rh, useChar, chars: r.chars, char: charForDet });
          }
        }
        return rects;
      },
    });
  }

  // ================= 결과 & 미리보기 =================
  function showResult(bytes) {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastBytes = bytes; lastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const name = state.fileName.replace(/\.pdf$/i, "") + "_masked.pdf";
    el.dlLink.href = lastUrl; el.dlLink.download = name; el.dlLink2.href = lastUrl; el.dlLink2.download = name;
    el.result.hidden = false; el.result.scrollIntoView({ block: "nearest", behavior: "smooth" });
    openPreview();
  }
  async function openPreview() {
    if (!lastBytes) return;
    try {
      showLoader("미리보기 생성 중…"); el.pvBody.innerHTML = "";
      const pdf = await pdfjsLib.getDocument({ data: lastBytes.slice(0) }).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1.4 });
        const c = document.createElement("canvas"); c.width = Math.floor(viewport.width); c.height = Math.floor(viewport.height);
        await page.render({ canvasContext: c.getContext("2d"), viewport }).promise; el.pvBody.appendChild(c);
      }
      el.previewModal.hidden = false;
    } catch (err) { console.error(err); showMessage("<b>미리보기 오류.</b> " + (err && err.message ? err.message : err), "err"); }
    finally { hideLoader(); }
  }
  el.previewBtn.addEventListener("click", openPreview);
  el.pvEdit.addEventListener("click", () => { el.previewModal.hidden = true; }); // 검토로 돌아가 수정
  el.pvClose.addEventListener("click", () => { el.previewModal.hidden = true; });
  el.previewModal.addEventListener("click", (e) => { if (e.target === el.previewModal) el.previewModal.hidden = true; });
})();
