/**
 * manual-app.js — 수동 마스킹 전용(직접 지정) 단일 파일 앱
 * 자동 탐지 없음. 업로드 후 단어 클릭 / 영역 드래그로 마스킹 → 이미지화 저장.
 */
(function () {
  "use strict";
  try {
    const w = document.getElementById("pdfWorkerSrc").textContent;
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([w], { type: "application/javascript" }));
  } catch (e) { console.warn("worker", e); }

  const VIEW_SCALE = 1.3, RASTER_SCALE = 2.0;
  const SYMBOL_FONT = '"WenQuanYi Zen Hei", "Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
  const state = { fileName: "", originalBytes: null, pages: [], dets: [], maskChar: "*", manualStyle: "box" };
  let detIdSeq = 0, lastUrl = null, lastBytes = null;

  const el = {
    msg: id("msg"), drop: id("drop"), fileInput: id("fileInput"), fname: id("fname"),
    toolCard: id("toolCard"), dlCard: id("dlCard"), symrow: id("symrow"), symPicker: id("symPicker"),
    sameWord: id("sameWord"), totalCount: id("totalCount"), genBtn: id("genBtn"), result: id("result"),
    dlLink: id("dlLink"), dlLink2: id("dlLink2"), previewBtn: id("previewBtn"),
    previewModal: id("previewModal"), pvBody: id("pvBody"), pvClose: id("pvClose"),
    empty: id("empty"), pages: id("pages"), loader: id("loader"), loaderText: id("loaderText"),
  };
  function id(x) { return document.getElementById(x); }
  const showLoader = (t) => { el.loaderText.textContent = t || "처리 중…"; el.loader.hidden = false; };
  const hideLoader = () => { el.loader.hidden = true; };
  const showMessage = (h, k) => { el.msg.innerHTML = h; el.msg.className = "msg " + (k || "info"); el.msg.hidden = false; };
  const clearMessage = () => { el.msg.hidden = true; };

  el.fileInput.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) handleFile(f); });
  ["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("drag"); }));
  el.drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });

  async function handleFile(file) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { showMessage("PDF 파일만 업로드할 수 있습니다.", "err"); return; }
    try {
      clearMessage(); showLoader("PDF를 읽는 중…"); resetState();
      state.fileName = file.name; state.originalBytes = await file.arrayBuffer();
      el.fname.hidden = false; el.fname.querySelector("span").textContent = file.name;
      const hadText = await processPdf(state.originalBytes.slice(0));
      el.toolCard.hidden = false; el.dlCard.hidden = false; el.empty.hidden = true;
      renderTotal();
      state.pages.forEach((p) => p.pw.classList.add("manual-on"));
      if (!hadText) showMessage("텍스트를 찾지 못했습니다. 스캔본(이미지) PDF는 클릭 마스킹이 어렵고, <b>드래그</b>로만 가릴 수 있습니다.", "warn");
    } catch (err) { console.error(err); showMessage("<b>PDF 처리 중 오류.</b> " + (err && err.message ? err.message : err), "err"); }
    finally { hideLoader(); }
  }
  function resetState() {
    state.pages = []; state.dets = []; detIdSeq = 0;
    el.pages.innerHTML = ""; el.totalCount.textContent = "0"; el.result.hidden = true; el.previewModal.hidden = true;
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  }

  async function processPdf(buffer) {
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let hadText = false;
    for (let n = 1; n <= pdf.numPages; n++) {
      showLoader(`페이지 준비 중… (${n}/${pdf.numPages})`);
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 }), pageIndex = n - 1;
      const meta = { widthPts: base.width, heightPts: base.height };
      const pw = await renderPage(page, pageIndex);
      const { text, charMap, items } = await extractText(page);
      if (text.trim()) hadText = true;
      for (const item of items) { try { const fo = page.commonObjs.get(item.fontName); if (fo && fo.loadedName) item._font = fo.loadedName; } catch (e) {} }
      const rec = { pageIndex, meta, text, charMap, items, ov: pw._ov, pw };
      state.pages.push(rec); enableManualDrag(rec);
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
    _mc.font = "32px " + (item._font ? '"' + item._font + '"' : "sans-serif");
    const measuredFull = _mc.measureText(str).width || 1, scale = totalWidth / measuredFull;
    const preWidth = _mc.measureText(str.slice(0, startOffset)).width * scale;
    const matchWidth = _mc.measureText(str.slice(startOffset, endOffset + 1)).width * scale;
    const descent = fontHeight * 0.25, padX = fontHeight * 0.11;
    return { x: x0 + preWidth - padX, y: yBaseline - descent, w: matchWidth + padX * 2, h: fontHeight * 1.2, chars: endOffset - startOffset + 1 };
  }

  // ===== 클릭 토큰 =====
  const TOKEN_DELIM = /[\s,()\[\]{}·:;/\\|"'“”‘’「」『』【】、。]/;
  function itemBBox(item) { const t = item.transform, fh = Math.hypot(t[2], t[3]) || 10; return { x0: t[4], top: t[5] + fh * 0.9, bottom: t[5] - fh * 0.28, w: item.width || fh * (item.str.length || 1), fh }; }
  function findTokenAtPoint(rec, px, py) {
    let hit = null;
    for (const item of rec.items) { const b = itemBBox(item); if (px >= b.x0 - 1 && px <= b.x0 + b.w + 1 && py >= b.bottom && py <= b.top) { hit = item; break; } }
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
    if (el.sameWord.checked && tok.token.length >= 1) {
      for (const r of state.pages) {
        let from = 0, idx;
        while ((idx = r.text.indexOf(tok.token, from)) !== -1) {
          from = idx + tok.token.length;
          const rects = rangeRects(idx, idx + tok.token.length, r.charMap);
          if (rects.length) addDet({ pageIndex: r.pageIndex, style: state.manualStyle, rects, value: tok.token });
        }
      }
    } else {
      const rect = itemSubRect(tok.item, tok.tStart, tok.tEnd);
      if (rect) addDet({ pageIndex: rec.pageIndex, style: state.manualStyle, rects: [rect], value: tok.token });
    }
    renderTotal();
  }

  // ===== 항목 & 오버레이 =====
  function addDet(d) { d.id = "d" + detIdSeq++; state.dets.push(d); drawBoxes(d); return d; }
  function pageRec(i) { return state.pages.find((p) => p.pageIndex === i); }
  function drawBoxes(det) {
    const rec = pageRec(det.pageIndex); if (!rec) return; const meta = rec.meta;
    for (const r of det.rects) {
      const box = document.createElement("div");
      box.className = "box on manual" + (det.style === "symbol" ? " symbol" : "");
      box.style.borderColor = "var(--cat-manual)";
      box.style.left = r.x * VIEW_SCALE + "px"; box.style.top = (meta.heightPts - (r.y + r.h)) * VIEW_SCALE + "px";
      box.style.width = r.w * VIEW_SCALE + "px"; box.style.height = r.h * VIEW_SCALE + "px";
      box.dataset.det = det.id;
      if (det.value) { const tip = document.createElement("span"); tip.className = "box__tip"; tip.textContent = det.value; box.appendChild(tip); }
      box.addEventListener("click", (ev) => { ev.stopPropagation(); removeDet(det.id); });
      rec.ov.appendChild(box);
    }
  }
  function removeDet(idv) { document.querySelectorAll('.box[data-det="' + idv + '"]').forEach((b) => b.remove()); state.dets = state.dets.filter((x) => x.id !== idv); renderTotal(); }
  function renderTotal() { el.totalCount.textContent = String(state.dets.length); el.genBtn.disabled = state.dets.length === 0; }

  // ===== 컨트롤 =====
  document.querySelectorAll('input[name="mstyle"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { state.manualStyle = r.value; } }));
  el.symPicker.addEventListener("click", (e) => { const b = e.target.closest(".sym"); if (!b) return; el.symPicker.querySelectorAll(".sym").forEach((x) => x.classList.remove("on")); b.classList.add("on"); state.maskChar = b.dataset.sym; });

  function enableManualDrag(rec) {
    const ov = rec.ov; let startX, startY, tempEl = null;
    ov.addEventListener("mousedown", (e) => {
      if (e.target.closest(".box")) return;
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
        if (w < 6 && h < 6) { const px = startX / VIEW_SCALE, py = rec.meta.heightPts - startY / VIEW_SCALE; const tok = findTokenAtPoint(rec, px, py); if (tok) maskToken(rec, tok); return; }
        if (w < 6 || h < 6) return;
        const rect = { x: left / VIEW_SCALE, y: rec.meta.heightPts - (top + h) / VIEW_SCALE, w: w / VIEW_SCALE, h: h / VIEW_SCALE };
        addDet({ pageIndex: rec.pageIndex, style: state.manualStyle, rects: [rect], value: state.manualStyle === "symbol" ? "영역 (문자)" : "영역 (검은박스)" });
        renderTotal();
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
  }

  // ===== 생성 =====
  el.genBtn.addEventListener("click", async () => {
    if (!state.dets.length) return;
    try { showLoader("마스킹 PDF를 생성하는 중…"); showResult(await buildRaster()); }
    catch (err) { console.error(err); showMessage("<b>생성 중 오류.</b> " + (err && err.message ? err.message : err), "err"); }
    finally { hideLoader(); }
  });
  async function buildRaster() {
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
      for (const det of state.dets) {
        if (det.pageIndex !== pageIndex) continue;
        for (const r of det.rects) {
          const rx = r.x * RASTER_SCALE, ry = (meta.heightPts - (r.y + r.h)) * RASTER_SCALE, rw = r.w * RASTER_SCALE, rh = r.h * RASTER_SCALE;
          if (det.style === "symbol") drawChars(ctx, rx, ry, rw, rh, r.chars);
          else { ctx.fillStyle = "#000"; ctx.fillRect(rx, ry, rw, rh); }
        }
      }
      const png = await new Promise((res, rej) => canvas.toBlob((b) => b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error("canvas")), "image/png"));
      const img = await out.embedPng(png);
      out.addPage([meta.widthPts, meta.heightPts]).drawImage(img, { x: 0, y: 0, width: meta.widthPts, height: meta.heightPts });
    }
    return out.save();
  }
  function drawChars(ctx, rx, ry, rw, rh, chars) {
    ctx.fillStyle = "#fff"; ctx.fillRect(rx, ry, rw, rh); ctx.fillStyle = "#000";
    ctx.font = Math.floor(rh * 0.8) + "px " + SYMBOL_FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    const n = chars && chars > 0 ? chars : Math.max(1, Math.round(rw / (rh * 0.62))), slot = rw / n;
    for (let i = 0; i < n; i++) ctx.fillText(state.maskChar, rx + slot * (i + 0.5), ry + rh / 2);
  }

  // ===== 결과 & 미리보기 =====
  function showResult(bytes) {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastBytes = bytes; lastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const name = state.fileName.replace(/\.pdf$/i, "") + "_masked.pdf";
    el.dlLink.href = lastUrl; el.dlLink.download = name; el.dlLink2.href = lastUrl; el.dlLink2.download = name;
    el.result.hidden = false; el.result.scrollIntoView({ block: "nearest", behavior: "smooth" }); openPreview();
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
  el.pvClose.addEventListener("click", () => { el.previewModal.hidden = true; });
  el.previewModal.addEventListener("click", (e) => { if (e.target === el.previewModal) el.previewModal.hidden = true; });
})();
