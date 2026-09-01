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
  // 앞에 쉼표가 오면 시작하지 않음 → 금액("1,840,000")의 끝자리가 뒤이어 나오는
  // 다른 숫자와 이어붙어 잘못된 매치를 만드는 것을 방지(SEP가 구분자 0개도
  // 허용해 순수 숫자 나열도 매치되기 때문— RE_PHONE 주석 참고).
  const RE_RRN = new RegExp("(?<![0-9,])(\\d{6})" + SEP + "([1-8]\\d{6})(?![0-9])", "g");

  // 전화번호: 휴대전화(01X) 및 유선(0XX).
  // SEP가 구분자 0개(빈 문자열)도 허용하므로, 실제로는 "숫자만 있어도" 매치될 수
  // 있다. 그래서 "1,840,000 110-234-567890"처럼 쉼표로 끊긴 금액의 끝자리 0들과
  // 그 뒤 계좌번호 앞부분이 공백 하나로 이어붙어 "000 301-0123" 같은 실재하지
  // 않는 전화번호로 오탐되는 사례가 실제 문서 검증 중 발견됐다. 쉼표 바로
  // 뒤에서는 시작하지 않게 해 이 경로를 차단한다.
  const RE_PHONE = new RegExp("(?<![0-9,])(0\\d{1,2})" + SEP + "(\\d{3,4})" + SEP + "(\\d{4})(?![0-9])", "g");

  // 이메일
  const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  // 계좌번호(추정): 하이픈/공백으로 구분된 3~4개 숫자 그룹. 총 자리수로 후처리 필터링.
  // 앞뒤에 쉼표/마침표/숫자가 붙으면 시작하지 않음 → 금액("612,000") 끝자리를 계좌에 끌어오지 않도록
  const RE_ACCOUNT = /(?<![0-9,.\-])\d{2,6}(?:[-\s]{1,3}\d{2,6}){2,3}(?![0-9,.\-])/g;

  // 카드번호: 국내 카드(신용·체크) 표준 표기인 4자리씩 4묶음(16자리). 구분자는
  // 하이픈/공백 0~1개(표 안에서는 구분자 없이 붙여쓰기도 흔함). 15자리(Amex류
  // 4-6-5 구성)는 국내 실무 문서에서 드물어 이 MVP 범위 밖으로 둔다.
  const RE_CARD = /(?<![0-9,])\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?![0-9])/g;

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
  //  · 형식이 없어 정규식으로 못 잡으므로 네 가지 신호를 조합한다:
  //    (1) 사용자가 입력한 단어 목록
  //    (2) 조직 접미어 규칙(센터/사무소/과 등으로 끝나는 이름의 앞부분)
  //    (3) 성명 라벨 규칙 — "성명:", "작성자 " 같은 라벨 바로 뒤의 한글 토큰
  //        (문맥 기반이라 사전 없이도 정확도가 높아 기본으로 켜둔다)
  //    (4) 성씨 사전 자동탐지(베타) — 흔한 성씨로 시작하는 2~4글자 한글 토큰
  //        (문맥이 없어 오탐 위험이 있으므로 기본은 꺼두고 사용자가 켜야 함)
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

  // ---------------- (3) 성명 라벨 규칙 ----------------
  // 공문서·감사 서식에서 사람 이름을 소개하는 라벨. 라벨과 이름 사이에
  // 구분자가 반드시 있어야 매치되므로, "성명이 다르다" 같은 문장 속 조사
  // 결합("성명" 바로 뒤에 "이"가 붙어 구분자 없음)은 걸리지 않는다.
  //
  // "성명"·"이름"은 서식 라벨(→ 뒤에 실제 이름)로도, 평범한 문장 속 일반명사
  // (예: "성명 확인을 위해")로도 쓰여 공백만으로는 구분이 안 된다. 그래서
  // 이 둘은 **콜론이 있을 때만**(STRICT) 인정하고, 사람을 직접 가리켜 일반
  // 명사로 쓰일 일이 거의 없는 나머지 라벨(LOOSE)만 공백 구분도 허용한다.
  const NAME_LABELS_STRICT = ["성명", "이름"];
  // "감사담당자"처럼 "담당자" 앞에 수식어가 붙는 복합어는 일부러 넣지 않는다 —
  // 실제 문서에서는 "감사담당자 연락처:", "감사담당자 이메일:"처럼 그 뒤에
  // 사람 이름이 아니라 "또 다른 항목명"이 이어지는 경우가 더 흔해서, 넣으면
  // 그 항목명(예: "연락처")을 이름으로 오탐하는 사례가 실제 문서 검증 중
  // 나왔다. 이름을 직접 소개하는 홑낱말 라벨만 남긴다.
  const NAME_LABELS_LOOSE = [
    "담당자", "작성자", "검토자", "확인자", "결재자",
    "피감사자", "감사대상자", "대표자", "면담자", "보고자", "인수자", "인계자",
  ];
  const NAME_LABELS = NAME_LABELS_STRICT.concat(NAME_LABELS_LOOSE);
  // 라벨 앞에 한글이 더 있으면(예: "감사담당자"의 "담당자") 그 라벨의 일부가
  // 아니라 더 긴 낱말의 뒷부분일 뿐이므로 매치하지 않는다. 이 가드가 없으면
  // "감사담당자 연락처: …"에서 "담당자"가 라벨로 오매치되고, 바로 뒤의
  // "연락처"라는 낱말이 사람 이름인 것처럼 잘못 잡힌다.
  const NOT_PRECEDED_BY_HANGUL = "(?<![가-힣])";
  const PAREN = "(?:\\([^)]{0,10}\\))?"; // 괄호 부기(예: "성명(직급)") 선택적으로 허용
  const NAME_CAPTURE = "([가-힣]{2,4})(?![가-힣])"; // 이름 2~4글자(뒤에 한글이 더 이어지면 제외)
  const RE_LABELED_NAME_STRICT = new RegExp(
    NOT_PRECEDED_BY_HANGUL + "(?:" + NAME_LABELS_STRICT.join("|") + ")" + PAREN + "[\\s]*[:：]\\s*" + NAME_CAPTURE, "g"
  );
  const RE_LABELED_NAME_LOOSE = new RegExp(
    NOT_PRECEDED_BY_HANGUL + "(?:" + NAME_LABELS_LOOSE.join("|") + ")" + PAREN + "[\\s:：]+" + NAME_CAPTURE, "g"
  );

  // "담당자 이메일:", "성명 확인란" 처럼 라벨 바로 뒤에 사람 이름이 아니라
  // "또 다른 항목명"이 이어지는 복합 표현에서, 그 항목명 자체가 이름으로
  // 잘못 캡처되는 걸 막기 위한 차단 목록(실제 문서 검증 중 발견).
  const NON_NAME_FIELD_WORDS = [
    "이메일", "연락처", "전화", "전화번호", "휴대폰", "휴대전화", "팩스",
    "부서", "직급", "직위", "직책", "소속", "계좌", "계좌번호", "카드", "카드번호",
    "주소", "이름", "성명", "생년월일", "주민등록번호", "성별", "비고", "은행",
    "명단", "현황", "목록", "내역", "명세",
  ];

  function execAllNames(re, text, out) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (!NON_NAME_FIELD_WORDS.includes(name)) {
        const start = m.index + m[0].length - name.length;
        out.push({ start, end: start + name.length, maskStart: start, maskEnd: start + name.length, kind: "name-label" });
      }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  /** (3) 라벨 바로 뒤 이름 토큰 수집 */
  function collectLabeledNames(text) {
    const out = [];
    execAllNames(RE_LABELED_NAME_STRICT, text, out);
    execAllNames(RE_LABELED_NAME_LOOSE, text, out);
    return out;
  }

  // ---------------- (4) 성씨 사전 자동탐지 (베타) ----------------
  // 통계청 인구주택총조사 기준 상위 성씨 위주. 완전한 목록이 아니며, 사전에
  // 없는 성씨나 드문 이름은 여전히 놓칠 수 있다(그래서 기본값은 꺼짐).
  const SURNAMES2 = ["남궁", "황보", "제갈", "선우", "서문", "독고", "사공"]; // 2글자 성(복성)
  const SURNAMES1 = [
    "김", "이", "박", "최", "정", "강", "조", "윤", "장", "임",
    "한", "오", "서", "신", "권", "황", "안", "송", "전", "홍",
    "유", "고", "문", "양", "손", "배", "백", "허", "남", "심",
    "노", "하", "곽", "성", "차", "주", "우", "구", "민", "진",
    "지", "엄", "채", "원", "천", "방", "공", "현", "함", "변",
    "염", "여", "추", "도", "소", "석", "선", "설", "마", "길",
    "위", "표", "기", "반", "왕", "금", "옥", "육", "인", // "명"은 사람 수를 세는 단위("두 명이")로 훨씬 자주 쓰여 제외
    "맹", "제", "모", "피", "어", "감", "판", "예", "연", "매",
    "갈", "국", "경", "계", "봉", "편", "두", "견", "형", "좌",
    "목", "부", "빈", "승", "시", "온", "옹", "은", "음", "탁",
  ];

  // 성씨로 시작하지만 이름이 아닌 흔한 낱말(오탐 방지용, 완전한 목록 아님).
  // "candidate.startsWith(단어)" 로 검사하므로, 이 단어로 시작하는 더 긴
  // 후보("김치찌개"의 "김치찌" 등)까지 함께 걸러진다.
  const NAME_EXCLUDE_WORDS = [
    "김치", "김밥", "김포", "김장",
    "이용", "이후", "이상", "이하", "이번", "이제", "이날", "이곳", "이유", "이력", "이의", "이관", "이체", "이첩", "이송", "이행", "이해",
    "박수", "박탈", "박물관", "박람회",
    "최근", "최대", "최소", "최초", "최종", "최고", "최선", "최저", "최신",
    "정보", "정리", "정도", "정말", "정지", "정확", "정책", "정기", "정상", "정산", "정정", "정당", "정의", "정황", "정례", "정원", "정착", "정비", "정문", "정면",
    "강조", "강의", "강화", "강남", "강북", "강원", "강행", "강제", "강도", "강수", "강습", "강구",
    "조사", "조치", "조건", "조정", "조직", "조금", "조례", "조회", "조성", "조합", "조서", "조율", "조언", "조기", "조속",
    "윤리", "윤곽", "윤허",
    "장소", "장비", "장기", "장부", "장관", "장려", "장애", "장점", "장차",
    "임시", "임대", "임명", "임원", "임기", "임의", "임차", "임무", "임용",
    "한편", "한번", "한계", "한국", "한글", "한파", "한도", "한다", "한것", "한바", "한테", "한창", "한몫", "한숨",
    "오전", "오후", "오늘", "오해", "오류", "오차", "오염", "오히려",
    "서류", "서명", "서비스", "서울", "서면", "서식", "서두", "서약", "서열",
    "신청", "신고", "신용", "신분", "신원", "신규", "신뢰", "신속", "신중", "신설",
    "권한", "권리", "권고", "권장", "권역", "권익",
    "황당", "황급",
    "안내", "안전", "안건", "안정", "안심", "안착",
    "송부", "송달", "송금", "송치",
    "전화", "전체", "전자", "전달", "전산", "전결", "전용", "전면", "전문", "전임", "전년", "전월", "전입", "전출",
    "홍보", "홍수",
    "유의", "유지", "유효", "유출", "유형", "유사", "유무", "유예", "유관", "유일",
    "고려", "고발", "고소", "고지", "고용", "고령", "고객", "고충",
    "문서", "문의", "문제", "문화", "문항", "문구", "문안", "문책",
    "양식", "양측", "양자", "양호", "양해", "양성",
    "손님", "손해", "손실", "손목", "손상", "손질",
    "배정", "배부", "배포", "배치", "배제", "배상",
    "백화점", "백분율", "백서", "백지",
    "허가", "허용", "허위", "허점",
    "남자", "남은", "남부", "남녀", "남짓",
    "심사", "심의", "심각", "심리", "심층", "심화",
    "노력", "노출", "노동", "노약자",
    "하지", "하나", "하루", "하위", "하락", "하청", "하반기", "하수",
    // 감사 문서·공공기관 서식에서 특히 자주 나오는 낱말(라벨 자체가 성씨로 시작하는 경우 포함).
    "감사", "감사원", "감사실", "감사관", "감사결과", "감사대상", "감사보고서", "감사위원회", "감사국", "감안", "감소", "감독", "감경", "감면",
    "기관", "기간", "기준", "기록", "기타", "기존", "기본", "기재", "기획", "기능",
    "국가", "국민", "국세", "국고", "국장", "국정", "국내", "국회",
    "공공", "공무원", "공단", "공사", "공개", "공고", "공문", "공지", "공동", "공익", "공정", "공공기관",
    "제출", "제공", "제한", "제거", "제안", "제도", "제시", "제재", "제외",
    "성명", "성별", "성실", "성과", "성적", "성향", "성립", "성격",
    "차량", "차이", "차단", "차원", "차기", "차질", "차례",
    "구청", "구체", "구성", "구분", "구역", "구매", "구조", "구비", "구제",
    "원인", "원래", "원칙", "원본", "원장", "원가", "원상", "원활", "원자", "원조",
    "방문", "방법", "방지", "방안", "방침", "방식", "방향", "방재",
    "현재", "현황", "현장", "현행", "현실", "현금",
    // "피-"(피감사·피조사 등): 감사 대상을 가리키는 접두어라 감사 문서에 매우 자주 등장.
    "피감사", "피감사자", "피감사기관", "피조사", "피조사자", "피의자", "피고", "피고인", "피해", "피해자", "피추천", "피추천인", "피고발", "피고발인", "피청구인", "피신청인",
    // "-기 위하여/위해", "-으로 인하여/인해" 처럼 띄어써서 그 자체가 한글 덩어리가 되는 보조 표현.
    "위하여", "위해서", "위한", "위해", "위반", "위원", "위촉", "위치", "위험",
    "인하여", "인해서", "인한",
    "도움", "도착", "도입", "도출", "도로", "도대체", "도저히", "도구",
    // "하다" 어간이 붙어 만들어지는 흔한 연결/활용형(그 자체로 낱말 덩어리가 되는 경우).
    "하기", "하며", "하고", "하는", "하여",
    "주민", "주민등록번호", "주요", "주의", "주간", "주소", "주최", "주관", "주무관", "주요사항",
    "연락처", "연락", "연구", "연구원", "연관", "연결", "연기", "연말", "연도", "연령", "연습", "연장",
    "마스킹", "마스크", "마감", "마무리", "마련", "마찬가지", "마당", "마을", "마지막",
    // 감사보고서에 흔한 일반 낱말이 우연히 성씨로 시작하는 나머지 경우들.
    "예산", "예정", "예방", "예상", "예외", "예시", "예금", "예약",
    "부적정", "부적절", "부서", "부문", "부담", "부합", "부족", "부분", "부여", "부과", "부속",
    "판단", "판정", "판결", "판례", "판사",
    "계좌", "계좌번호", "계획", "계약", "계속", "계기", "계층",
    "목적", "목표", "목록", "목차", "목격",
  ];

  /** candidate가 흔한 낱말(또는 그 낱말로 시작하는 문자열)이면 true */
  function isExcludedWord(candidate) {
    return NAME_EXCLUDE_WORDS.some((w) => candidate.startsWith(w));
  }

  /**
   * (4) 문서 전체 한글 덩어리에서 "성씨+1~2글자" 패턴 후보 수집.
   * 덩어리(공백·문장부호로 구분된 한글 연속 구간)의 **맨 앞**에서만 성씨를
   * 찾는다 — 덩어리 중간의 아무 글자나 성씨와 우연히 같으면(예: "점심으로"의
   * "심", "제출한다"의 "한") 이름이 아닌데도 걸리는 경우가 압도적으로 많아서다.
   * 이 제한 때문에 띄어쓰기 없이 이름과 앞말이 붙어버린 문서에서는 놓칠 수
   * 있지만(재현율 손해), 그 대가로 오탐이 크게 줄어든다(베타 기능이라 재현율보다
   * 정밀도를 우선함).
   */
  function collectDictionaryNames(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (!HANGUL.test(text[i])) { i++; continue; }
      let j = i;
      while (j < n && HANGUL.test(text[j])) j++;
      const run = text.slice(i, j);
      let surnameLen = 0;
      if (run.length >= 2 && SURNAMES2.includes(run.slice(0, 2))) surnameLen = 2;
      else if (run.length >= 2 && SURNAMES1.includes(run[0])) surnameLen = 1; // 덩어리 길이 2 미만(성 한 글자뿐)이면 이름이 될 수 없음
      if (surnameLen) {
        // 가장 긴 후보(성+2글자)만 시도한다 — 그게 제외 단어에 걸리면 더 짧게
        // 잘라서(성+1글자) 다시 시도하지 않는다. 제외 단어는 대개 "그 낱말
        // 자체가 이름이 아니다"라는 뜻이라, 그걸 더 잘라낸 부분 문자열은
        // 이름일 가능성이 오히려 더 낮다(예: "피감사기관"에서 "피감사"가
        // 제외됐다고 "피감"을 이름으로 보는 건 말이 안 됨).
        const len = Math.min(surnameLen + 2, run.length);
        const candidate = run.slice(0, len);
        if (!isExcludedWord(candidate)) {
          out.push({ start: i, end: i + len, maskStart: i, maskEnd: i + len, kind: "name-dict" });
        }
      }
      i = j;
    }
    return out;
  }

  // ---------------- (5) 표 열 구조 인식 ----------------
  // 감사보고서에 가장 흔한 표 형태 명단은 "연번·소속·성명·주민등록번호…" 같은
  // 열 헤더가 맨 위에 한 번만 있고, 그 아래 각 행에는 라벨 없이 이름만 있다.
  // (3)의 라벨 규칙은 라벨이 이름 바로 앞에 있을 때만 잡으므로 이런 표는
  // 놓친다 — 대신 "성명" 헤더가 있는 열의 x좌표를 찾아, 그 아래로 같은
  // x범위에 있는 칸들을 전부 이름 후보로 채택한다.
  //
  // PDF 텍스트 조각(item)은 좌표(transform)를 가지고 있어, 표를 만드는 도구
  // (워드프로세서·리포트 라이브러리 대부분)는 각 칸을 별도 조각으로 그린다는
  // 전제 위에서 동작한다 — 한 조각 안에 여러 칸이 합쳐진 표(예: 셀 사이에
  // 탭 문자로만 구분)에는 적용되지 않는다(별도 한계로 남김).
  const NAME_COLUMN_HEADERS = ["성명", "이름", "성명(직급)", "성명/직급", "직원성명", "사용자"];

  function itemX0(item) { return item.transform[4]; }
  function itemX1(item) { return item.transform[4] + (item.width || 0); }
  function itemY(item) { return item.transform[5]; }
  function itemFontHeight(item) { return Math.hypot(item.transform[2], item.transform[3]) || 10; }

  // OCR로 만든 items는 글자 하나당 하나씩이라(js/ocr-bridge.js 참고), 표 헤더
  // 문구("성명" 등)조차 여러 조각으로 쪼개져 있어 그대로는 헤더를 찾을 수
  // 없다. 그래서 같은 줄 안에서 조각 사이 간격이 좁으면(글자 높이 대비) 같은
  // 칸의 일부로 보고 하나로 합친다 — 진짜 표 열 사이 간격(칸과 칸 사이
  // 여백)은 실측상 이 기준보다 몇 배 넓어 잘못 합쳐지지 않는다. 이 병합은
  // 일반 PDF 텍스트(칸마다 이미 조각이 나뉜 경우)에도 안전하게 적용된다 —
  // 같은 이유로 그런 문서에서는 애초에 합쳐질 만큼 좁은 간격이 서로 다른
  // 칸 사이에 나타나지 않는다.
  const MERGE_GAP_RATIO = 1.0;
  function mergeRowCells(cells) {
    if (cells.length <= 1) return cells;
    const out = [];
    let cur = cells[0];
    for (let i = 1; i < cells.length; i++) {
      const next = cells[i];
      const gap = itemX0(next) - itemX1(cur);
      const h = Math.max(itemFontHeight(cur), itemFontHeight(next));
      if (gap <= h * MERGE_GAP_RATIO && cur._gStart + cur.str.length === next._gStart) {
        cur = {
          str: cur.str + next.str,
          transform: cur.transform,
          width: itemX1(next) - itemX0(cur),
          _gStart: cur._gStart,
        };
      } else {
        out.push(cur);
        cur = next;
      }
    }
    out.push(cur);
    return out;
  }

  // 칸 구분 없이 표를 흉내 낸 문서(예: 단순 텍스트를 그대로 PDF로 찍어낸
  // 경우) 대응 — 표 전체가 칸별로 나뉘지 않고 "성명    소속    연락처"처럼
  // 공백(3칸 이상)이나 탭 문자로만 줄을 맞춘 한 덩어리 조각(item)으로 되어
  // 있으면, 그 구분자를 기준으로 여러 개의 가짜 조각(virtual item)으로
  // 쪼갠다. x좌표는 조각 폭을 글자 수 비율로 나눈 근사치일 뿐이지만 — 열
  // 구역(zone) 판정에는 이 정도 정확도면 충분하고, 실제 마스킹 박스는
  // 어차피 이 함수가 아니라 원본 조각의 실측 글자 폭(rangeRects/itemSubRect,
  // mask-engine.js)으로 그려지므로 근사치가 최종 결과 정확도에 영향을 주지
  // 않는다(_gStart를 원본 문자열 안의 진짜 오프셋으로 정확히 넘기기만 하면 됨).
  const WIDE_ITEM_SEP = /\t+| {3,}/g;
  function splitWideItems(items) {
    const out = [];
    for (const it of items) {
      WIDE_ITEM_SEP.lastIndex = 0;
      const str = it.str;
      const parts = []; // [start,end) 구분자가 아닌 구간들
      let last = 0, m;
      while ((m = WIDE_ITEM_SEP.exec(str)) !== null) {
        if (m.index > last) parts.push([last, m.index]);
        last = m.index + m[0].length;
      }
      if (last < str.length) parts.push([last, str.length]);
      if (parts.length < 2 || !it.transform) { out.push(it); continue; } // 구분자가 없거나 한 조각뿐이면 그대로
      const x0 = itemX0(it), w = it.width || 0;
      for (const [s, e] of parts) {
        const segX0 = x0 + w * (s / str.length);
        const segW = w * ((e - s) / str.length);
        const t = it.transform.slice(); t[4] = segX0; // 조각별 x0만 바꾼 가짜 transform
        out.push({ str: str.slice(s, e), transform: t, width: segW, _gStart: it._gStart + s });
      }
    }
    return out;
  }

  /** items를 y좌표 기준으로 행(row)으로 묶는다(같은 줄 = y가 거의 같음). 위→아래 순. */
  function groupRows(items) {
    items = splitWideItems(items);
    const withY = items.filter((it) => it.str && it.str.trim() && it.transform).map((it) => ({ it, y: itemY(it) }));
    const rows = [];
    for (const w of withY) {
      let row = rows.find((r) => Math.abs(r.y - w.y) <= 3); // 3pt 이내면 같은 줄(대부분의 표는 같은 줄 오차가 1pt 미만)
      if (!row) { row = { y: w.y, cells: [] }; rows.push(row); }
      row.cells.push(w.it);
    }
    rows.sort((a, b) => b.y - a.y); // PDF 좌표는 아래로 갈수록 y가 작아짐 → 내림차순이 위→아래
    for (const r of rows) {
      r.cells.sort((a, b) => itemX0(a) - itemX0(b));
      r.cells = mergeRowCells(r.cells);
    }
    return rows;
  }

  /** row 안에서 헤더 셀의 열 구역(zone)—좌우 이웃 헤더와의 중간점—을 계산 */
  function columnZone(row, headerCell) {
    const idx = row.cells.indexOf(headerCell);
    const left = idx > 0 ? (itemX1(row.cells[idx - 1]) + itemX0(headerCell)) / 2 : -Infinity;
    const right = idx < row.cells.length - 1 ? (itemX1(headerCell) + itemX0(row.cells[idx + 1])) / 2 : Infinity;
    return { left, right };
  }

  /** 셀 안에서 맨 앞 한글 2~4글자(이름으로 추정되는 부분)만 추출 */
  function leadingHangulName(item) {
    const lead = item.str.match(/^\s*/)[0].length;
    const rest = item.str.slice(lead);
    const m = rest.match(/^[가-힣]{2,4}/);
    if (!m) return null;
    if (NAME_COLUMN_HEADERS.includes(m[0])) return null; // 다음 표의 헤더를 다시 만난 경우
    const start = item._gStart + lead;
    return { start, end: start + m[0].length };
  }

  /**
   * @param {Array} items  extractText()가 반환한 페이지의 item 배열
   *                       (item.transform/.width/.str/._gStart 필요)
   */
  function collectTableColumnNames(items) {
    if (!items || !items.length) return [];
    const rows = groupRows(items);
    const out = [];
    for (let hi = 0; hi < rows.length; hi++) {
      const headerCell = rows[hi].cells.find((c) => NAME_COLUMN_HEADERS.includes(c.str.trim()));
      if (!headerCell) continue;
      const zone = columnZone(rows[hi], headerCell);
      // 헤더 아래 행들을 순서대로 훑되, 그 열에 이름처럼 생기지 않은 칸이
      // 나오면(표가 끝났거나 다음 표의 헤더를 만난 경우) 바로 멈춘다.
      for (let ri = hi + 1; ri < rows.length && ri < hi + 200; ri++) {
        const row = rows[ri];
        const cell = row.cells.find((c) => {
          const cx = (itemX0(c) + itemX1(c)) / 2;
          return cx >= zone.left && cx < zone.right;
        });
        if (!cell) break;
        const name = leadingHangulName(cell);
        if (!name) break;
        out.push({ start: name.start, end: name.end, maskStart: name.start, maskEnd: name.end, kind: "name-column" });
      }
    }
    return out;
  }

  /**
   * @param {string} text  페이지 텍스트
   * @param {object} opts  { words: string[], useSuffixRule: boolean,
   *                          useNameLabelRule: boolean, useNameDict: boolean,
   *                          useTableColumnRule: boolean, items: Array }
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

    // (3) 성명 라벨 규칙: 문맥(라벨) 기반이라 사전 없이도 정확도가 높음
    if (opts.useNameLabelRule) results.push(...collectLabeledNames(text));

    // (4) 성씨 사전 자동탐지(베타): 문맥 없이 사전만으로 판단해 오탐 위험이 있음
    if (opts.useNameDict) results.push(...collectDictionaryNames(text));

    // (5) 표 열 구조 인식: "성명" 등 열 헤더 아래 칸을 전부 이름으로 간주
    if (opts.useTableColumnRule && opts.items) results.push(...collectTableColumnNames(opts.items));

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

  global.PIIDetector = {
    CATEGORIES, detect, findEntities, ORG_SUFFIXES,
    SURNAMES1, SURNAMES2, NAME_EXCLUDE_WORDS, NAME_LABELS, NAME_COLUMN_HEADERS,
  };
})(window);
