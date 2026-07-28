/**
 * app-artifact.js — 단일 파일(아티팩트) 버전
 *  · 번호류(주민/전화/이메일/계좌): 정규식 자동 탐지
 *  · 이름·기관/부서: 단어목록 + 접미어 규칙 (접미어는 유지)
 *  · 수동 마스킹: 페이지 위 드래그로 직접 지정
 *  · 마스킹 수준: 부분(표준) / 전체 선택
 *      - 부분: 주민번호 뒤7·전화 뒤4·이메일 아이디 일부·계좌 앞6 유지·이름 가운데
 *      - 전체: 값 전체 (번호=검은박스, 이름=마스킹 문자)
 *  · 출력: 페이지 이미지화(완전 제거) → 원본 글자까지 제거
 */
(function () {
  "use strict";
  const { CATEGORIES, detect, findEntities } = window.PIIDetector;

  try {
    const workerText = document.getElementById("pdfWorkerSrc").textContent;
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerText], { type: "application/javascript" }));
  } catch (e) { console.warn("worker 설정 실패", e); }

  const VIEW_SCALE = 1.3, RASTER_SCALE = 2.0;
  const SYMBOL_FONT = '"WenQuanYi Zen Hei", "Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  // 검토(자동 탐지) 리포트에는 번호류만 — 이름·기관/수동은 각 단계에서 별도 표시
  const AUTO_CATS = [
    { id: "rrn", label: "주민등록번호" }, { id: "phone", label: "전화번호" },
    { id: "email", label: "이메일" }, { id: "account", label: "계좌번호" },
  ];
  const AUTO_IDS = AUTO_CATS.map((c) => c.id);

  const state = {
    fileName: "", originalBytes: null, pages: [], dets: [],
    maskChar: "*", maskLevel: "partial", manualMode: false, manualStyle: "box",
  };
  let detIdSeq = 0, lastUrl = null, lastBytes = null;

  const el = {
    msg: id("msg"), drop: id("drop"), fileInput: id("fileInput"), fname: id("fname"),
    reportCard: id("reportCard"), entityCard: id("entityCard"), manualCard: id("manualCard"), dlCard: id("dlCard"),
    cats: id("cats"), totalCount: id("totalCount"),
    wordList: id("wordList"), suffixRule: id("suffixRule"), symPicker: id("symPicker"), applyEntities: id("applyEntities"),
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
      const hadText = await processPdf(state.originalBytes.slice(0));
      reDetectEntities(); renderReport();
      [el.reportCard, el.entityCard, el.manualCard, el.dlCard].forEach((c) => (c.hidden = false));
      el.empty.hidden = true; el.undoBtn.hidden = false;
      el.uploadMeta.textContent = state.pages.length + "쪽";
      if (!hadText) showMessage("이 PDF에서 <b>선택 가능한 텍스트를 찾지 못했습니다.</b> 스캔본(이미지) PDF는 지원하지 않습니다. (OCR 필요)", "warn");
    } catch (err) { console.error(err); showMessage("<b>PDF 처리 중 오류.</b> " + (err && err.message ? err.message : err), "err"); }
    finally { clearTimeout(watchdog); hideLoader(); }
  }
  function resetState() {
    state.pages = []; state.dets = []; detIdSeq = 0;
    el.pages.innerHTML = ""; el.cats.innerHTML = ""; el.totalCount.textContent = "0";
    el.result.hidden = true; el.previewModal.hidden = true;
    history.length = 0; updateUndo(); el.undoBtn.hidden = true;
    el.autoMeta.textContent = el.entityMeta.textContent = el.manualMeta.textContent = el.totalMeta.textContent = el.uploadMeta.textContent = "";
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  }

  // ================= PDF 처리 =================
  async function processPdf(buffer) {
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let hadText = false;
    for (let n = 1; n <= pdf.numPages; n++) {
      showLoader(`페이지 분석 중… (${n}/${pdf.numPages})`);
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 }), pageIndex = n - 1;
      const meta = { widthPts: base.width, heightPts: base.height };
      const pw = await renderPage(page, pageIndex);
      const { text, charMap, items } = await extractText(page);
      if (text.trim()) hadText = true;
      // 각 텍스트 조각의 실제 임베드 폰트명을 저장 → 마스킹 위치를 정확히 측정
      for (const item of items) { try { const fo = page.commonObjs.get(item.fontName); if (fo && fo.loadedName) item._font = fo.loadedName; } catch (e) {} }
      const rec = { pageIndex, meta, text, charMap, items, ov: pw._ov, pw };
      state.pages.push(rec); enableManualDrag(rec);
      for (const m of detect(text)) {
        const full = rangeRects(m.start, m.end, charMap);
        if (!full.length) continue;
        const [pa, pb] = piiPartial(m.category, text, m.start, m.end);
        addDet({ pageIndex, category: m.category, source: "pii", style: "box",
          fullRects: full, partialRects: rangeRects(pa, pb, charMap), value: m.value });
      }
    }
    return hadText;
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
  async function extractText(page) {
    const content = await page.getTextContent();
    let text = ""; const charMap = [], items = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      if (item.str.length) items.push(item);
      for (let i = 0; i < item.str.length; i++) { text += item.str[i]; charMap.push({ item, offset: i }); }
      if (item.hasEOL) { text += "\n"; charMap.push(null); }
    }
    return { text, charMap, items };
  }

  // ===== 클릭 지점의 단어(토큰) 찾기 =====
  const TOKEN_DELIM = /[\s,()\[\]{}·:;/\\|"'“”‘’「」『』【】、。]/;
  function itemBBox(item) {
    const t = item.transform, fh = Math.hypot(t[2], t[3]) || 10;
    return { x0: t[4], top: t[5] + fh * 0.9, bottom: t[5] - fh * 0.28, w: item.width || fh * (item.str.length || 1), fh };
  }
  function findTokenAtPoint(rec, px, py) {
    let hit = null;
    for (const item of rec.items) {
      const b = itemBBox(item);
      if (px >= b.x0 - 1 && px <= b.x0 + b.w + 1 && py >= b.bottom && py <= b.top) { hit = item; break; }
    }
    if (!hit) return null;
    const b = itemBBox(hit), s0 = hit.str;
    let off = Math.floor(Math.max(0, Math.min(1, (px - b.x0) / b.w)) * s0.length);
    off = Math.max(0, Math.min(s0.length - 1, off));
    const isW = (ch) => ch && !TOKEN_DELIM.test(ch);
    if (!isW(s0[off])) { if (isW(s0[off + 1])) off++; else if (off > 0 && isW(s0[off - 1])) off--; else return null; }
    let s = off, e = off;
    while (s > 0 && isW(s0[s - 1])) s--;
    while (e < s0.length - 1 && isW(s0[e + 1])) e++;
    return { item: hit, tStart: s, tEnd: e, token: s0.slice(s, e + 1) };
  }
  function maskToken(rec, tok) {
    snapshot();
    if (el.sameWord && el.sameWord.checked && tok.token.length >= 1) {
      for (const r of state.pages) {
        let from = 0, idx;
        while ((idx = r.text.indexOf(tok.token, from)) !== -1) {
          from = idx + tok.token.length;
          const rects = rangeRects(idx, idx + tok.token.length, r.charMap);
          if (rects.length) addDet({ pageIndex: r.pageIndex, category: "manual", source: "manual", style: state.manualStyle, fullRects: rects, partialRects: rects, value: tok.token });
        }
      }
    } else {
      const rect = itemSubRect(tok.item, tok.tStart, tok.tEnd);
      if (rect) addDet({ pageIndex: rec.pageIndex, category: "manual", source: "manual", style: state.manualStyle, fullRects: [rect], partialRects: [rect], value: tok.token });
    }
    renderReport();
  }

  // 문자 범위 → PDF 좌표 사각형들
  function rangeRects(start, end, charMap) {
    const groups = []; let cur = null;
    for (let i = start; i < end; i++) {
      const e = charMap[i];
      if (!e) { if (cur) { groups.push(cur); cur = null; } continue; }
      if (cur && cur.item === e.item) cur.endOffset = e.offset;
      else { if (cur) groups.push(cur); cur = { item: e.item, startOffset: e.offset, endOffset: e.offset }; }
    }
    if (cur) groups.push(cur);
    return groups.map((g) => itemSubRect(g.item, g.startOffset, g.endOffset)).filter(Boolean);
  }
  const _mc = document.createElement("canvas").getContext("2d");
  function itemSubRect(item, startOffset, endOffset) {
    const t = item.transform; if (!t) return null;
    const x0 = t[4], yBaseline = t[5];
    const fontHeight = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const str = item.str, totalWidth = item.width || fontHeight * (str.length || 1);
    _mc.font = '32px ' + (item._font ? '"' + item._font + '"' : "sans-serif"); // 실제 폰트로 측정
    const measuredFull = _mc.measureText(str).width || 1, scale = totalWidth / measuredFull;
    const preWidth = _mc.measureText(str.slice(0, startOffset)).width * scale;
    const matchWidth = _mc.measureText(str.slice(startOffset, endOffset + 1)).width * scale;
    const descent = fontHeight * 0.25, padX = fontHeight * 0.11;
    return { x: x0 + preWidth - padX, y: yBaseline - descent, w: matchWidth + padX * 2, h: fontHeight * 1.2, chars: endOffset - startOffset + 1 };
  }

  // ===== 부분 마스킹 표준 규칙: 가릴 하위 범위 [a,b) 반환 =====
  function digitIdx(v) { const a = []; for (let i = 0; i < v.length; i++) if (v[i] >= "0" && v[i] <= "9") a.push(i); return a; }
  function piiPartial(category, text, start, end) {
    const v = text.slice(start, end), d = digitIdx(v);
    if (category === "rrn" && d.length >= 7) return [start + d[d.length - 7], start + d[d.length - 1] + 1];   // 뒤 7자리
    if (category === "phone" && d.length >= 4) return [start + d[d.length - 4], start + d[d.length - 1] + 1]; // 뒤 4자리
    if (category === "account" && d.length > 6) return [start + d[6], start + d[d.length - 1] + 1];           // 앞 6자리 유지
    if (category === "email") { const at = v.indexOf("@"); if (at > 0) { const keep = at <= 3 ? Math.max(1, at - 1) : 3; return [start + keep, start + at]; } }
    return [start, end]; // 규칙 없으면 전체
  }

  // ================= 이름·기관 재탐지 =================
  function currentWords() { return el.wordList.value.split(/\n+/).map((s) => s.trim()).filter(Boolean); }
  function reDetectEntities() {
    removeDetsBySource("entity");
    const words = currentWords(), useSuffixRule = el.suffixRule.checked;
    for (const rec of state.pages) {
      for (const e of findEntities(rec.text, { words, useSuffixRule })) {
        const full = rangeRects(e.maskStart, e.maskEnd, rec.charMap);
        if (!full.length) continue;
        // 사람 이름(접미어 없음·2~4 한글)은 부분 시 가운데만, 그 외(기관)는 전체 동일
        const isName = e.maskEnd === e.end && /^[가-힣]{2,4}$/.test(rec.text.slice(e.maskStart, e.maskEnd));
        let pa = e.maskStart, pb = e.maskEnd;
        if (isName) { const len = e.maskEnd - e.maskStart; pa = e.maskStart + 1; pb = len <= 2 ? e.maskEnd : e.maskEnd - 1; }
        const masked = rec.text.slice(e.maskStart, e.maskEnd), kept = rec.text.slice(e.maskEnd, e.end);
        addDet({ pageIndex: rec.pageIndex, category: "name", source: "entity", style: "symbol",
          fullRects: full, partialRects: rangeRects(pa, pb, rec.charMap), value: masked + (kept ? " +『" + kept + "』유지" : "") });
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
    for (const r of activeRects(det)) {
      const box = document.createElement("div");
      box.className = "box " + (det.included ? "on" : "off") + (det.style === "symbol" ? " symbol" : "") + (det.source === "manual" ? " manual" : "");
      box.style.borderColor = catColor(det.category);
      box.style.left = r.x * VIEW_SCALE + "px";
      box.style.top = (meta.heightPts - (r.y + r.h)) * VIEW_SCALE + "px";
      box.style.width = r.w * VIEW_SCALE + "px";
      box.style.height = r.h * VIEW_SCALE + "px";
      box.dataset.det = det.id;
      if (det.value) { const tip = document.createElement("span"); tip.className = "box__tip"; tip.textContent = det.value; box.appendChild(tip); }
      box.addEventListener("click", (ev) => { ev.stopPropagation(); if (det.source === "manual") removeDet(det.id); else toggleDet(det.id); });
      rec.ov.appendChild(box);
    }
  }
  function boxesOf(idv) { return document.querySelectorAll('.box[data-det="' + idv + '"]'); }
  function refreshBox(det) { boxesOf(det.id).forEach((b) => { b.classList.toggle("on", det.included); b.classList.toggle("off", !det.included); }); }
  function toggleDet(idv) { const d = state.dets.find((x) => x.id === idv); if (!d) return; snapshot(); d.included = !d.included; refreshBox(d); renderReport(); }
  function removeDet(idv) { snapshot(); boxesOf(idv).forEach((b) => b.remove()); state.dets = state.dets.filter((x) => x.id !== idv); renderReport(); }
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
  el.symPicker.addEventListener("click", (e) => {
    const b = e.target.closest(".sym"); if (!b) return;
    el.symPicker.querySelectorAll(".sym").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); state.maskChar = b.dataset.sym;
  });
  document.querySelectorAll('input[name="maskLevel"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { state.maskLevel = r.value; redrawOverlays(); } }));
  el.manualToggle.addEventListener("click", () => {
    state.manualMode = !state.manualMode;
    el.manualToggle.setAttribute("aria-pressed", String(state.manualMode));
    el.manualToggle.textContent = state.manualMode ? "✏️ 수동 마스킹 모드 끄기" : "✏️ 수동 마스킹 모드 켜기";
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
        const rect = { x: left / VIEW_SCALE, y: rec.meta.heightPts - (top + h) / VIEW_SCALE, w: w / VIEW_SCALE, h: h / VIEW_SCALE };
        addDet({ pageIndex: rec.pageIndex, category: "manual", source: "manual", style: state.manualStyle,
          fullRects: [rect], partialRects: [rect], value: state.manualStyle === "symbol" ? "수동 (문자)" : "수동 (검은박스)" });
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

  async function buildRaster(included) {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    const pdf = await pdfjsLib.getDocument({ data: state.originalBytes.slice(0) }).promise;
    for (let n = 1; n <= pdf.numPages; n++) {
      showLoader(`이미지화 중… (${n}/${pdf.numPages})`);
      const page = await pdf.getPage(n);
      const pageIndex = n - 1, meta = state.pages[pageIndex].meta;
      const viewport = page.getViewport({ scale: RASTER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      for (const det of included) {
        if (det.pageIndex !== pageIndex) continue;
        // 부분 마스킹 또는 문자 스타일 → 마스킹 문자로, 아니면 검은박스
        const useChar = (state.maskLevel === "partial" && det.source !== "manual") || det.style === "symbol";
        for (const r of activeRects(det)) {
          const rx = r.x * RASTER_SCALE, ry = (meta.heightPts - (r.y + r.h)) * RASTER_SCALE, rw = r.w * RASTER_SCALE, rh = r.h * RASTER_SCALE;
          if (useChar) drawChars(ctx, rx, ry, rw, rh, r.chars);
          else { ctx.fillStyle = "#000"; ctx.fillRect(rx, ry, rw, rh); }
        }
      }
      const png = await new Promise((res, rej) => canvas.toBlob((b) => b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error("canvas")), "image/png"));
      const img = await out.embedPng(png);
      out.addPage([meta.widthPts, meta.heightPts]).drawImage(img, { x: 0, y: 0, width: meta.widthPts, height: meta.heightPts });
    }
    return out.save();
  }

  // 흰색으로 덮고 마스킹 문자를 채워 넣는다
  function drawChars(ctx, rx, ry, rw, rh, chars) {
    ctx.fillStyle = "#fff"; ctx.fillRect(rx, ry, rw, rh);
    ctx.fillStyle = "#000";
    const fs = Math.floor(rh * 0.8);
    ctx.font = fs + "px " + SYMBOL_FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    // 가려진 글자 수만큼 정확히 채움(없으면 폭으로 근사 — 드래그 영역 등)
    const n = chars && chars > 0 ? chars : Math.max(1, Math.round(rw / (rh * 0.62)));
    const slot = rw / n;
    for (let i = 0; i < n; i++) ctx.fillText(state.maskChar, rx + slot * (i + 0.5), ry + rh / 2);
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
