/**
 * detectors.js
 * ------------------------------------------------------------------
 * 정형화된 개인정보(주민등록번호·전화번호·이메일·계좌번호)를
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
  const CATEGORIES = {
    rrn:     { id: "rrn",     label: "주민등록번호", color: "#e11d48", priority: 4 },
    phone:   { id: "phone",   label: "전화번호",     color: "#2563eb", priority: 3 },
    email:   { id: "email",   label: "이메일",       color: "#7c3aed", priority: 2 },
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
  const RE_ACCOUNT = /(?<![0-9-])\d{2,6}(?:[-\s]{1,3}\d{2,6}){2,3}(?![0-9-])/g;

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

  global.PIIDetector = { CATEGORIES, detect };
})(window);
