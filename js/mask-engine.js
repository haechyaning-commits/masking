/**
 * mask-engine.js
 * ------------------------------------------------------------------
 * PDF 마스킹의 "엔진" — 좌표/폰트 계산, 드래그·클릭 스냅, 부분 마스킹
 * 규칙, 마스킹 기호 배정, 최종 래스터 생성까지 전부 여기 있다.
 *
 * detectors.js(정규식 탐지)와 마찬가지로 화면(review 오버레이, 버튼,
 * 카드 등)에 의존하지 않는 순수 로직 모듈이다 — canvas·pdf.js/pdf-lib
 * 객체는 다루지만 특정 HTML 마크업이나 상태 관리 방식(vanilla state
 * 객체든 React state든)을 전제하지 않는다. 화면 프레임워크를 나중에
 * 바꾸더라도(예: React) 이 파일은 그대로 가져다 쓸 수 있도록 만들었다.
 */
(function (global) {
  "use strict";

  // ================= 텍스트 추출 =================
  // pdf.js의 getTextContent() 결과를 페이지 전체 문자열 + 문자별 위치
  // 매핑(charMap)으로 펼친다. items[i]._gStart 는 그 조각의 첫 글자가
  // 페이지 텍스트에서 갖는 전역 인덱스 — 클릭/드래그 좌표를 텍스트
  // 인덱스로 빠르게 되돌리는 데 쓴다.
  async function extractText(page) {
    const content = await page.getTextContent();
    let text = ""; const charMap = [], items = [];
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      if (item.str.length) { item._gStart = charMap.length; items.push(item); }
      for (let i = 0; i < item.str.length; i++) { text += item.str[i]; charMap.push({ item, offset: i }); }
      if (item.hasEOL) { text += "\n"; charMap.push(null); }
    }
    return { text, charMap, items };
  }

  // ================= 글자 위치/폭 측정 =================
  const TOKEN_DELIM = /[\s,()\[\]{}·:;/\\|"'“”‘’「」『』【】、。]/;
  const isWordChar = (ch) => ch && !TOKEN_DELIM.test(ch);

  function itemBBox(item) {
    const t = item.transform, fh = Math.hypot(t[2], t[3]) || 10;
    return { x0: t[4], top: t[5] + fh * 0.9, bottom: t[5] - fh * 0.28, w: item.width || fh * (item.str.length || 1), fh };
  }

  // ================= 회전(세로쓰기 등) 텍스트 판별 =================
  // 이 파일의 좌표 계산(itemBBox/itemSubRect/itemCharXs 등)은 전부 가로쓰기를
  // 전제한다 — transform 행렬 [a,b,c,d,e,f]에서 b,c가 0(글자가 x축과 나란함)이라고
  // 가정하고 폭·베이스라인을 계산한다. 세로쓰기·기울어진 도장처럼 실제로 회전된
  // 조각에 같은 계산을 적용하면 마스킹 박스가 엉뚱한 자리에 그려질 수 있어
  // 위험하다. "완전한 회전 지원"(임의 각도로 정확히 박스를 그리는 것) 대신,
  // 회전된 조각은 자동탐지·클릭선택·드래그스냅에서 전부 제외하고(있는 그대로
  // 두면 아래 각 함수가 안전하게 건너뛴다) 사용자가 직접 드래그로 가리도록
  // 안내하는 "안전한" 접근을 택했다(README 로드맵 참고).
  const ROTATION_TOLERANCE_RAD = 0.06; // 약 3.4도 — 폰트 렌더링 오차 정도는 허용
  function itemRotationRad(item) {
    const t = item.transform;
    return Math.atan2(t[1], t[0]);
  }
  // 위아래가 뒤집힌 가로쓰기(180도)는 b,c가 0에 가까워 이 함수 기준으로는
  // "회전 아님"으로 잡힌다 — 아직 그 케이스까지 다루진 않지만 흔치 않고,
  // 여기서 걸러내려는 것은 세로쓰기처럼 좌표 계산 자체가 틀어지는 경우다.
  function isRotatedItem(item) {
    const t = item.transform; if (!t) return false;
    let a = itemRotationRad(item) % Math.PI;
    if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
    return Math.abs(a) > ROTATION_TOLERANCE_RAD;
  }

  // 클릭 지점을 조각(item)에 맞춘다. 정확히 얹히지 않아도 가장 가까운 글자 조각을
  // (약 1.2줄 높이 이내) 채택 → 드래그/클릭 위치가 조금 어긋나도 단어를 잡는다.
  function itemAtPoint(rec, px, py) {
    let best = null, bestDist = Infinity;
    for (const item of rec.items) {
      if (isRotatedItem(item)) continue; // 회전된 글자는 좌표 계산이 안 맞음 — 클릭 선택에서 제외(드래그로 가려야 함)
      const b = itemBBox(item);
      const inX = px >= b.x0 - 1 && px <= b.x0 + b.w + 1;
      const inY = py >= b.bottom && py <= b.top;
      if (inX && inY) return { item, exact: true };
      const dx = px < b.x0 ? b.x0 - px : (px > b.x0 + b.w ? px - (b.x0 + b.w) : 0);
      const dy = py < b.bottom ? b.bottom - py : (py > b.top ? py - b.top : 0);
      const d = Math.hypot(dx, dy);
      if (d < bestDist) { bestDist = d; best = item; }
    }
    if (best && bestDist <= (itemBBox(best).fh * 1.2)) return { item: best, exact: false };
    return null;
  }

  // 클릭 지점의 단어를 페이지 텍스트 인덱스 [start,end) 로 반환.
  // 조각 경계를 넘어(예: '홍','길','동'이 따로 저장된 경우) 단어 전체를 이어 붙인다.
  function findTokenAtPoint(rec, px, py) {
    const found = itemAtPoint(rec, px, py);
    if (!found) return null;
    const hit = found.item, b = itemBBox(hit), s0 = hit.str;
    let off = Math.floor(Math.max(0, Math.min(1, (px - b.x0) / b.w)) * s0.length);
    off = Math.max(0, Math.min(s0.length - 1, off));
    let g = hit._gStart + off;
    const txt = rec.text;
    if (!isWordChar(txt[g])) {
      if (isWordChar(txt[g + 1])) g++;
      else if (g > 0 && isWordChar(txt[g - 1])) g--;
      else return null;
    }
    let s = g, e = g;
    while (s > 0 && isWordChar(txt[s - 1])) s--;
    while (e < txt.length - 1 && isWordChar(txt[e + 1])) e++;
    return { start: s, end: e + 1, token: txt.slice(s, e + 1) };
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
    if (isRotatedItem(item)) return null; // 세로쓰기 등 회전된 글자 — 자동 마스킹에서 안전하게 제외(위 설명 참고)
    const x0 = t[4], yBaseline = t[5];
    const fontHeight = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const str = item.str, totalWidth = item.width || fontHeight * (str.length || 1);
    _mc.font = '32px ' + (item._font ? '"' + item._font + '"' : "sans-serif"); // 실제 폰트로 측정
    const measuredFull = _mc.measureText(str).width || 1, scale = totalWidth / measuredFull;
    const preWidth = _mc.measureText(str.slice(0, startOffset)).width * scale;
    const matchWidth = _mc.measureText(str.slice(startOffset, endOffset + 1)).width * scale;
    // 검토 박스는 글자에 딱 맞게(여백 없음). 출력 커버 여백은 drawPageMasks에서 추가.
    return { x: x0 + preWidth, y: yBaseline - fontHeight * 0.2, w: matchWidth, h: fontHeight * 1.06, chars: endOffset - startOffset + 1 };
  }

  // 한 조각(item)의 글자별 왼쪽 x오프셋 누적 목록(실제 폰트로 측정) — 드래그 스냅용
  function itemCharXs(item) {
    const t = item.transform;
    const fontHeight = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
    const str = item.str, totalWidth = item.width || fontHeight * (str.length || 1);
    _mc.font = '32px ' + (item._font ? '"' + item._font + '"' : "sans-serif");
    const measuredFull = _mc.measureText(str).width || 1, scale = totalWidth / measuredFull;
    const xs = [];
    for (let i = 0; i <= str.length; i++) xs.push(_mc.measureText(str.slice(0, i)).width * scale);
    return { xs, x0: t[4], baseline: t[5], fontHeight };
  }

  // 드래그한 사각형(PDF 좌표: x=왼쪽, y=아래, w, h) 안에 든 글자를 찾아
  // 정확한 글자 위치로 '스냅'된 사각형들을 돌려준다. 텍스트가 없으면 null.
  function snapDragToText(rec, box) {
    const bx0 = box.x, bx1 = box.x + box.w, by0 = box.y, by1 = box.y + box.h;
    const hits = [];
    for (const item of rec.items) {
      // 회전된 글자는 이 함수의 가로쓰기 전제(itemCharXs)가 맞지 않아 건너뛴다.
      // 드래그 영역이 회전된 글자 위뿐이면 hits가 비어 null을 돌려주고,
      // 호출부(app-artifact.js)가 사용자가 드래그한 사각형을 그대로 쓴다 —
      // 이게 세로쓰기 페이지에서 "직접 지정"이 안전하게 동작하는 이유다.
      if (isRotatedItem(item)) continue;
      const info = itemCharXs(item);
      const top = info.baseline + info.fontHeight * 0.8, bot = info.baseline - info.fontHeight * 0.2;
      // 세로: 어중간하게 스치기만 한 옆줄까지 끌려오지 않도록, 줄 높이의 40% 이상
      // 확실히 겹칠 때만 그 줄을 인정한다.
      const lineH = top - bot, vOverlap = Math.min(top, by1) - Math.max(bot, by0);
      if (vOverlap < lineH * 0.4) continue;
      for (let i = 0; i < item.str.length; i++) {
        // 가로: 글자의 "중심점"이 드래그 영역 안에 있을 때만 포함한다.
        // 가장자리가 살짝만 스쳐도 포함시키면(부분 겹침) 표의 옆 칸(다른 열)
        // 글자까지 끌려와 버려서, 중심점 기준으로 되돌린다.
        const cx = info.x0 + (info.xs[i] + info.xs[i + 1]) / 2;
        if (cx >= bx0 && cx <= bx1) hits.push(item._gStart + i);
      }
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a - b);
    // 드래그가 실제로 닿은 글자만 범위로 잡는다(단어 경계로 확장하지 않음).
    // 공백 문자 없이 좌표만 벌려 배치된 문서가 많아, 경계까지 확장하면
    // 줄 전체가 딸려오는 과다 확장이 생겨서 이 확장은 넣지 않는다.
    const ranges = []; let s = hits[0], prev = hits[0];
    for (let k = 1; k < hits.length; k++) {
      if (hits[k] === prev + 1) prev = hits[k];
      else { ranges.push([s, prev + 1]); s = hits[k]; prev = hits[k]; }
    }
    ranges.push([s, prev + 1]);
    const rects = [], tokens = [];
    for (const [a, b] of ranges) {
      const rr = rangeRects(a, b, rec.charMap);
      if (rr.length) { rects.push(...rr); tokens.push(rec.text.slice(a, b)); }
    }
    return rects.length ? { rects, text: tokens.join(" "), tokens } : null;
  }

  // ================= 부분 마스킹 표준 규칙: 가릴 하위 범위 [a,b) 반환 =================
  function digitIdx(v) { const a = []; for (let i = 0; i < v.length; i++) if (v[i] >= "0" && v[i] <= "9") a.push(i); return a; }
  function piiPartial(category, text, start, end) {
    const v = text.slice(start, end), d = digitIdx(v);
    if (category === "rrn" && d.length >= 7) return [start + d[d.length - 7], start + d[d.length - 1] + 1];   // 뒤 7자리
    if (category === "phone" && d.length >= 4) return [start + d[d.length - 4], start + d[d.length - 1] + 1]; // 뒤 4자리
    if (category === "account" && d.length > 6) return [start + d[6], start + d[d.length - 1] + 1];           // 앞 6자리 유지
    // 카드번호: 앞 6자리(발급사 식별번호)·뒤 4자리를 남기고 중간만 가림(여신전문금융업법
    // 감독규정·PCI 마스킹 관행 참고, 예: "123456******1234"). 자리수가 10 이하면
    // 남길 두 구간이 겹치므로 규칙을 적용하지 않고 전체를 가린다(폴백).
    if (category === "card" && d.length > 10) return [start + d[6], start + d[d.length - 4]];
    if (category === "email") { const at = v.indexOf("@"); if (at > 0) { const keep = at <= 3 ? Math.max(1, at - 1) : 3; return [start + keep, start + at]; } }
    return [start, end]; // 규칙 없으면 전체
  }

  // ================= 이름·직접지정 마스킹 기호 순환 배정 =================
  // 같은 사람(단어)은 항상 같은 기호, 다른 사람은 다른 기호로 순환 배정해
  // 표에서 서로 다른 사람임을 구분할 수 있게 한다(실제 공공기관 문서의
  // "김○○"·"이△△" 관례 참고). 번호류는 이 팔레트를 쓰지 않는다.
  const ENTITY_SYMBOL_PALETTE = ["○", "●", "△", "▲", "□", "■", "◇", "◆", "☆", "★"];
  function createSymbolAssigner(palette) {
    const pal = palette || ENTITY_SYMBOL_PALETTE;
    const map = new Map();
    return {
      // key(사람/단어)에 배정된 기호를 돌려준다. 처음 보는 key면 팔레트에서 순서대로 새로 배정.
      get(key, fallback) {
        if (!key) return fallback;
        if (map.has(key)) return map.get(key);
        const sym = pal[map.size % pal.length];
        map.set(key, sym);
        return sym;
      },
      clear() { map.clear(); },
    };
  }

  // ================= 최종 마스킹 문자 그리기 =================
  // 흰색으로 덮고 마스킹 문자를 채워 넣는다.
  function drawChars(ctx, rx, ry, rw, rh, chars, char, symbolFont) {
    const ch = char || "*";
    ctx.fillStyle = "#fff"; ctx.fillRect(rx, ry, rw, rh);
    ctx.fillStyle = "#000";
    // 가려진 글자 수만큼 정확히 채움(없으면 폭으로 근사 — 드래그 영역 등)
    const n = chars && chars > 0 ? chars : Math.max(1, Math.round(rw / (rh * 0.62)));
    const slot = rw / n;
    // 칸(slot) 폭보다 글자가 넓으면 옆 글자와 겹쳐 하나의 덩어리처럼 보이므로,
    // 실제 렌더링 폭을 측정해 칸에 맞을 때까지 폰트 크기를 줄인다.
    let fs = Math.floor(rh * 0.8);
    ctx.font = fs + "px " + symbolFont;
    const maxCharW = slot * 0.78; // 글자 사이 최소 여백 확보
    const measured = ctx.measureText(ch).width || 1;
    if (measured > maxCharW) fs = Math.max(6, Math.floor(fs * maxCharW / measured));
    ctx.font = fs + "px " + symbolFont; ctx.textBaseline = "middle"; ctx.textAlign = "center";
    for (let i = 0; i < n; i++) ctx.fillText(ch, rx + slot * (i + 0.5), ry + rh / 2);
  }

  // 한 페이지 안의 모든 마스킹 사각형(pageRects: [{rx,ry,rw,rh,useChar,chars,char}])을
  // 서로 겹치지 않게 여백을 계산해 그린다. 옆/위아래에 다른 마스킹이 가까이
  // 있으면 그 간격의 40%를 넘지 않도록 여백 상한을 둬서, 전화번호·이메일처럼
  // 마스킹 대상끼리 붙어 있어도 겹치지 않게 한다.
  function drawPageMasks(ctx, pageRects, symbolFont) {
    for (const cur of pageRects) {
      let hGap = Infinity, vGap = Infinity;
      for (const other of pageRects) {
        if (other === cur) continue;
        const vOverlap = Math.min(cur.ry + cur.rh, other.ry + other.rh) - Math.max(cur.ry, other.ry);
        if (vOverlap > 0) {
          const gap = other.rx >= cur.rx + cur.rw ? other.rx - (cur.rx + cur.rw)
            : (cur.rx >= other.rx + other.rw ? cur.rx - (other.rx + other.rw) : 0);
          if (gap < hGap) hGap = gap;
        }
        const hOverlap = Math.min(cur.rx + cur.rw, other.rx + other.rw) - Math.max(cur.rx, other.rx);
        if (hOverlap > 0) {
          const gap = other.ry >= cur.ry + cur.rh ? other.ry - (cur.ry + cur.rh)
            : (cur.ry >= other.ry + other.rh ? cur.ry - (other.ry + other.rh) : 0);
          if (gap < vGap) vGap = gap;
        }
      }
      // 출력 시에만 커버 여백을 더해 글자를 확실히 가림(검토 박스는 그대로 둠).
      // 가로 여백은 높이 기준값에 폭 기준 상한을 둔다 — 이름 가운데 한 글자처럼
      // 폭이 좁은 마스킹에서 옆 글자까지 침범하지 않도록.
      const padY = Math.min(cur.rh * 0.02, vGap * 0.4);
      const padX = Math.min(cur.rh * 0.16, cur.rw * 0.12, hGap * 0.4);
      const fx = cur.rx - padX, fy = cur.ry - padY, fw = cur.rw + padX * 2, fh2 = cur.rh + padY * 2;
      if (cur.useChar) drawChars(ctx, fx, fy, fw, fh2, cur.chars, cur.char, symbolFont);
      else { ctx.fillStyle = "#000"; ctx.fillRect(fx, fy, fw, fh2); }
    }
  }

  // ================= 최종 마스킹 PDF(래스터) 생성 =================
  // 페이지 전체를 이미지로 다시 그려 원본 텍스트 레이어 자체를 없앤다(보안 설계,
  // README 참고). opts:
  //   pdfjsLib, PDFLib          — 각 라이브러리 참조
  //   originalBytes             — 원본 PDF 바이트(ArrayBuffer)
  //   pages                     — [{ pageIndex, meta:{widthPts,heightPts} }, ...]
  //   RASTER_SCALE              — 출력 해상도 배율
  //   symbolFont                — 마스킹 문자 렌더링용 폰트
  //   getPageRects(pageIndex)   — 그 페이지에 그릴 pageRects 배열을 돌려주는 콜백
  //                                (어떤 det을 포함할지·기호 배정은 호출자의 상태 관리 몫)
  //   onProgress(n, total)      — 진행 상황 콜백(선택)
  async function buildRaster(opts) {
    const { pdfjsLib, PDFLib, originalBytes, pages, RASTER_SCALE, symbolFont, getPageRects, onProgress } = opts;
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    // 보안: 원본 메타데이터(작성자·제목 등)를 남기지 않도록 새 문서 메타데이터를 비운다.
    try {
      out.setTitle(""); out.setAuthor(""); out.setSubject(""); out.setKeywords([]);
      out.setProducer("개인정보 마스킹 도구"); out.setCreator("개인정보 마스킹 도구");
    } catch (e) {}
    const pdf = await pdfjsLib.getDocument({ data: originalBytes.slice(0) }).promise;
    for (let n = 1; n <= pdf.numPages; n++) {
      if (onProgress) onProgress(n, pdf.numPages);
      const page = await pdf.getPage(n);
      const pageIndex = n - 1, meta = pages[pageIndex].meta;
      const viewport = page.getViewport({ scale: RASTER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pageRects = getPageRects(pageIndex, meta) || [];
      drawPageMasks(ctx, pageRects, symbolFont);
      const png = await new Promise((res, rej) => canvas.toBlob((b) => b ? b.arrayBuffer().then((a) => res(new Uint8Array(a)), rej) : rej(new Error("canvas")), "image/png"));
      const img = await out.embedPng(png);
      out.addPage([meta.widthPts, meta.heightPts]).drawImage(img, { x: 0, y: 0, width: meta.widthPts, height: meta.heightPts });
    }
    return out.save({ updateMetadata: false }); // 위에서 비운 메타데이터 유지
  }

  global.MaskEngine = {
    extractText,
    TOKEN_DELIM, isWordChar, itemBBox, itemAtPoint, findTokenAtPoint,
    itemSubRect, rangeRects, itemCharXs, snapDragToText,
    itemRotationRad, isRotatedItem,
    digitIdx, piiPartial,
    ENTITY_SYMBOL_PALETTE, createSymbolAssigner,
    drawChars, drawPageMasks, buildRaster,
  };
})(window);
