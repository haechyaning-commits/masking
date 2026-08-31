/**
 * detectors.js
 * ------------------------------------------------------------------
 * 정형화된 개인정보(주민등록번호·전화번호·이메일·계좌번호·카드번호)를
 * 정규식으로 탐지한다. 문맥 판단이 필요한 비정형 정보(이름·주소 등)는
 * 이 MVP 범위 밖이다.
 *
 * 반환 형식: [{ start, end, category, value }] (start/end는 페이지 텍스트 내 문자 인덱스)
 *
 * 한국 실무 문서(HWP→PDF 변환본 등)에서 흔한 변형에 대응한다:
 *  - 자리 구분자에 공백이 섞임: "900101 - 1234567", "010 - 1234 - 5678"
 *  - 전각(full-width) 숫자·하이픈: "９００１０１－１２３４５６７"
 */

(function (global) {
  "use strict";

  // 카테고리 메타데이터. priority가 높을수록 겹칠 때 우선 채택된다.
  // 카드번호는 계좌번호 정규식(RE_ACCOUNT)에도 걸릴 수 있는 자릿수(16자리)라,
  // priority를 계좌보다 높여 겹칠 때 카드로 채택되게 한다.
  const CATEGORIES = {
    rrn:     { id: "rrn",     label: "주민등록번호", color: "#e11d48", priority: 5 },
    phone:   { id: "phone",   label: "전화번호",     color: "#2563eb", priority: 4 },
    email:   { id: "email",   label: "이메일",       color: "#7c3aed", priority: 3 },
    card:    { id: "card",    label: "카드번호",     color: "#db2777", priority: 2 },
    account: { id: "account", label: "계좌번호",     color: "#059669", priority: 1 },
  };

  // 구분자: 하이픈/공백/점 0~3개 (자리 사이 공백 허용). \s 에는 개행도 포함.
  const SEP = "[-\\s.]{0,3}";

  // 주민등록번호: 앞 6자리(생년월일) + 뒤 7자리. 성별코드(뒤 첫자리) 1~4(내국인)·5~8(외국인).
  const RE_RRN = new RegExp("(?<![0-9])(\\d{6})" + SEP + "([1-8]\\d{6})(?![0-9])", "g");

  // 전화번호: 휴대전화(01X) 및 유선(0XX).
  const RE_PHONE = new RegExp("(?<![0-9])(0\\d{1,2})" + SEP + "(\\d{3,4})" + SEP + "(\\d{4})(?![0-9])", "g");

  // 이메일
  const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  // 계좌번호(추정): 하이픈/공백으로 구분된 3~4개 숫자 그룹. 총 자리수로 후처리 필터링.
  // 앞뒤에 쉼표/마침표/숫자가 붙으면 시작하지 않음 → 금액("612,000") 끝자리를 계좌에 끌어오지 않도록
  const RE_ACCOUNT = /(?<![0-9,.\-])\d{2,6}(?:[-\s]{1,3}\d{2,6}){2,3}(?![0-9,.\-])/g;

  // 카드번호: 국내 카드(신용·체크) 표준 표기인 4자리씩 4묶음(16자리). 구분자는
  // 하이픈/공백 0~1개(표 안에서는 구분자 없이 붙여쓰기도 흔함). 15자리(Amex류
  // 4-6-5 구성)는 국내 실무 문서에서 드물어 이 MVP 범위 밖으로 둔다.
  const RE_CARD = /(?<![0-9])\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?![0-9])/g;

  /**
   * 정규식 매칭 전 텍스트를 정규화한다. 반드시 "길이 보존"이어야
   * 매치 인덱스가 원본 텍스트/좌표 매핑과 그대로 일치한다.
   * (전각 숫자→반각, 각종 대시→'-', 전각 공백→' ')
   */
  function normalizeForMatch(text) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(c - 0xff10 + 0x30); // 전각 0-9
      else if (c === 0xff0d || c === 0x2010 || c === 0x2011 || c === 0x2012 ||
               c === 0x2013 || c === 0x2014 || c === 0x2015 || c === 0x2212) out += "-"; // 각종 하이픈/대시
      else if (c === 0x3000) out += " "; // 전각 공백
      else out += text[i];
    }
    return out;
  }

  /** 주민등록번호 앞 6자리의 월/일이 상식적인 범위인지 확인 (오탐 감소용) */
  function isPlausibleRrnDate(six) {
    const mm = parseInt(six.slice(2, 4), 10);
    const dd = parseInt(six.slice(4, 6), 10);
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
  }

  /** 문자열에서 숫자 개수 */
  function digitCount(s) {
    return (s.match(/\d/g) || []).length;
  }

  /**
   * 정규식을 정규화된 텍스트(norm)에 적용해 후보 목록 생성.
   * value/필터는 매치 그룹 기준으로 계산한다.
   */
  function collect(norm, regex, category, filterFn) {
    const out = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(norm)) !== null) {
      if (filterFn && !filterFn(m)) {
        if (m.index === regex.lastIndex) regex.lastIndex++;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, category, value: m[0] });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    return out;
  }

  /**
   * 페이지 텍스트에서 모든 카테고리를 탐지하고,
   * 겹치는 후보는 priority가 높은 것만 남긴다.
   */
  function detect(text) {
    if (!text) return [];
    const norm = normalizeForMatch(text);

    let candidates = [];
    candidates = candidates.concat(collect(norm, RE_RRN, "rrn", (m) => isPlausibleRrnDate(m[1])));
    candidates = candidates.concat(collect(norm, RE_PHONE, "phone"));
    candidates = candidates.concat(collect(norm, RE_EMAIL, "email"));
    candidates = candidates.concat(collect(norm, RE_CARD, "card"));
    candidates = candidates.concat(
      collect(norm, RE_ACCOUNT, "account", (m) => {
        const n = digitCount(m[0]);
        return n >= 10 && n <= 16; // 지나치게 짧거나 긴 숫자 나열 제외
      })
    );

    // 겹침 해소: priority 내림차순 정렬 후, 이미 채택된 구간과 겹치지 않는 것만 채택.
    candidates.sort((a, b) => {
      const pa = CATEGORIES[a.category].priority;
      const pb = CATEGORIES[b.category].priority;
      if (pb !== pa) return pb - pa;
      return a.start - b.start;
    });

    const accepted = [];
    for (const c of candidates) {
      const overlaps = accepted.some((a) => c.start < a.end && a.start < c.end);
      if (!overlaps) accepted.push(c);
    }

    accepted.sort((a, b) => a.start - b.start);
    return accepted;
  }

  // ================================================================
  // 비정형 정보(기관·부서·시설명, 사람 이름) 탐지 — 기호 치환용
  //  · 형식이 없어 정규식으로 못 잡으므로: (1) 사용자가 입력한 단어 목록,
  //    (2) 조직 접미어 규칙(센터/사무소/과 등으로 끝나는 이름의 앞부분)으로 찾는다.
  //  · 반환: [{ start, end, maskStart, maskEnd, kind }]
  //    maskStart~maskEnd 만 기호로 가리고 접미어(센터 등)는 남긴다.
  // ================================================================

  // 접미어(길이 긴 것부터 매칭). 조직/시설/부서에서 흔한 일반명사.
  const ORG_SUFFIXES = [
    "관리사무소", "주식회사", "유한회사", "어린이집", "대학교", "연구원", "연구소",
    "위원회", "출장소", "사무소", "사무국", "관리단", "관리소", "유치원", "지방청",
    "센터", "지사", "지점", "지부", "지회", "본부", "본청", "구청", "시청", "도청",
    "군청", "병원", "의원", "학교", "대학", "조합", "공사", "공단", "재단", "법인",
    "협회", "은행", "지구대", "파출소", "경찰서", "소방서", "교육청", "우체국",
    "청", "과", "팀", "실", "국", "부", "관", "원",
  ];

  const HANGUL = /[가-힣]/;

  /** 문자열 끝에서 알려진 접미어를 찾아 길이를 반환 (없으면 0) */
  function trailingSuffixLen(word) {
    for (const s of ORG_SUFFIXES) {
      if (word.length > s.length && word.endsWith(s)) return s.length;
    }
    return 0;
  }

  /**
   * @param {string} text  페이지 텍스트
   * @param {object} opts  { words: string[], useSuffixRule: boolean }
   */
  function findEntities(text, opts) {
    if (!text) return [];
    opts = opts || {};
    const words = (opts.words || []).map((w) => w.trim()).filter(Boolean);
    const results = [];

    // (1) 사용자 지정 단어 목록: 문서 전체에서 모든 출현을 찾음
    for (const w of words) {
      let from = 0, idx;
      while ((idx = text.indexOf(w, from)) !== -1) {
        const end = idx + w.length;
        const sufLen = trailingSuffixLen(w); // 접미어가 있으면 남김
        results.push({ start: idx, end, maskStart: idx, maskEnd: end - sufLen, kind: "list" });
        from = idx + 1;
      }
    }

    // (2) 접미어 규칙: 접미어 바로 앞의 한글 고유명사 덩어리를 가림
    if (opts.useSuffixRule) {
      for (const suf of ORG_SUFFIXES) {
        if (suf.length < 2) continue; // 1글자 접미어(과/청 등)는 오탐이 커서 규칙 자동에서는 제외
        let from = 0, idx;
        while ((idx = text.indexOf(suf, from)) !== -1) {
          from = idx + suf.length;
          // 앞으로 한글이 연속되는 만큼 고유명사로 간주 (최대 15자)
          let s = idx;
          while (s > 0 && HANGUL.test(text[s - 1]) && idx - s < 15) s--;
          if (s < idx) {
            results.push({ start: s, end: idx + suf.length, maskStart: s, maskEnd: idx, kind: "suffix" });
          }
        }
      }
    }

    // 겹침 정리: 시작이 이르고 길이가 긴 것 우선, 겹치면 뒤 후보 버림
    results.sort((a, b) => (a.start - b.start) || (b.end - a.end));
    const out = [];
    for (const r of results) {
      if (r.maskEnd <= r.maskStart) continue;
      if (out.some((a) => r.start < a.end && a.start < r.end)) continue;
      out.push(r);
    }
    return out;
  }

  global.PIIDetector = { CATEGORIES, detect, findEntities, ORG_SUFFIXES };
})(window);
