/**
 * detectors.js
 * ------------------------------------------------------------------
 * 정형화된 개인정보(주민등록번호·전화번호·이메일·계좌번호)를
 * 정규식으로 탐지한다. 문맥 판단이 필요한 비정형 정보(이름·주소 등)는
 * 이 MVP 범위 밖이다.
 *
 * 반환 형식: [{ start, end, category, value }] (start/end는 페이지 텍스트 내 문자 인덱스)
 */

(function (global) {
  "use strict";

  // 카테고리 메타데이터. priority가 높을수록 겹칠 때 우선 채택된다.
  // (예: "990101-1234567"은 주민번호이면서 계좌번호 형태와 겹칠 수 있는데,
  //  더 구체적인 주민번호를 우선한다.)
  const CATEGORIES = {
    rrn:     { id: "rrn",     label: "주민등록번호", color: "#e11d48", priority: 4 },
    phone:   { id: "phone",   label: "전화번호",     color: "#2563eb", priority: 3 },
    email:   { id: "email",   label: "이메일",       color: "#7c3aed", priority: 2 },
    account: { id: "account", label: "계좌번호",     color: "#059669", priority: 1 },
  };

  // ----- 개별 정규식 -----
  // 주민등록번호: 앞 6자리(생년월일) + 뒤 7자리. 성별코드(뒤 첫자리)는 1~4(내국인)·5~8(외국인).
  const RE_RRN = /(?<![0-9])(\d{6})[-\s]?([1-8]\d{6})(?![0-9])/g;

  // 전화번호: 휴대전화(01X) 및 유선(0XX). 구분자는 하이픈/공백/점 허용.
  const RE_PHONE = /(?<![0-9])(0\d{1,2})[-\s.]?(\d{3,4})[-\s.]?(\d{4})(?![0-9])/g;

  // 이메일
  const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  // 계좌번호(추정): 하이픈으로 구분된 3~4개 숫자 그룹. 총 자리수로 후처리 필터링.
  const RE_ACCOUNT = /(?<![0-9-])\d{2,6}-\d{2,6}-\d{2,6}(?:-\d{1,6})?(?![0-9-])/g;

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

  /** 정규식을 전체 텍스트에 적용해 후보 목록 생성 */
  function collect(text, regex, category, filterFn) {
    const out = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const value = m[0];
      if (filterFn && !filterFn(m)) continue;
      out.push({ start: m.index, end: m.index + value.length, category, value });
      // 빈 매치 방지
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

    let candidates = [];
    candidates = candidates.concat(
      collect(text, RE_RRN, "rrn", (m) => isPlausibleRrnDate(m[1]))
    );
    candidates = candidates.concat(collect(text, RE_PHONE, "phone"));
    candidates = candidates.concat(collect(text, RE_EMAIL, "email"));
    candidates = candidates.concat(
      collect(text, RE_ACCOUNT, "account", (m) => {
        const n = digitCount(m[0]);
        return n >= 10 && n <= 16; // 지나치게 짧거나 긴 숫자 나열 제외
      })
    );

    // 겹침 해소: priority 내림차순으로 정렬 후, 이미 채택된 구간과
    // 겹치지 않는 후보만 채택한다.
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
