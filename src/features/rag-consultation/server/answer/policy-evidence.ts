import { isAssistantDirective } from '../ingest/validation.ts';
import { canReadRecord } from '../retrieval/access-filter.ts';
import { compactText, splitSentences } from '../text/normalize.ts';
import {
  formatKstDate,
  isValidAt,
  kstStartOfDay,
  toKstDate,
} from '../text/time.ts';
import { resolveSubjects } from '../query/resolve-subjects.ts';
import {
  abstain,
  recordChunks,
  recordFacts,
  resolveEffectiveTime,
  type AnswerContext,
  type AnswerDraft,
  type EvidenceExcerpt,
} from './context.ts';
import { explicitClassIds } from './info.ts';
import { officialStatements } from './announcement-conflict.ts';
import { supportsExcerpt } from './verify.ts';
import {
  fromPublicExcerpts,
  isCleanPublicEvidence,
} from './public-evidence.ts';
import { tableDateAt } from './table-dates.ts';
import { answerReplacementFee } from './replacement-fee.ts';
import type { FactType, RagAccessScope } from '../types.ts';

interface PolicyField {
  label: string;
  optional?: boolean;
  value: (sentence: string) => string | undefined;
  quoteSelectedValue?: boolean;
}

interface PolicyRequest {
  anchor: string;
  applies: (heading: string, sentence: string) => boolean;
  fields: PolicyField[];
  specific?: (heading: string) => boolean;
  publicOffering?: string;
  boardReplies?: boolean;
  classScoped?: boolean;
  useSingleEnrollment?: boolean;
  factTypes?: readonly FactType[];
}

const EVALUATION =
  /레벨\s*(?:평가|테스트)|배치\s*(?:평가|시험)|반\s*배정\s*(?:시험|평가)/;
const TEST_PERIOD = /(?:시험|고사)\s*(?:대비\s*)?기간/;
const VIDEO = /영상|녹화/;
const SCHOOL_EXAM = /학교\s*(?:시험|고사)/;
const ACADEMY_EXAM_PERIOD =
  /(?:기말|중간)(?:고사|시험)?\s*(?:대비\s*)?(?:기간|때)/;

const absence = /결석|병결|빠(?:지|졌|져|진)|못\s*(?:가|갔|간)|불참/;
const illness = /질병|병결|아파|아팠|병원|독감|발열|감기|다쳐|부상|진료/;
const proof = /진료\s*확인서|진단서|소견서|진료\s*기록|증빙|확인서/;
const contact = /연락|알리|알려|통보|말해|말해야|신청/;
const speaking = /원어민|스피킹/;
const withoutArticle = (line: string) =>
  line.replace(
    /^\s*(?:\*\*)?(?:제\s*\d+\s*조(?:\([^)]*\))?|\d+[.)]|[-*])(?:\*\*)?\s*/,
    '',
  );
const contactDeadline =
  /(?:(?:수업|결석\s*예정일)\s*)?(?:(?:전날|당일|하루\s*전|\d+\s*(?:일|시간|분)\s*전)(?:\s*(?:오전|오후)?\s*(?:(?:[01]?\d|2[0-3]):[0-5]\d|\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?))?|(?:수업\s*(?:시작)?|당일\s*수업\s*시작)\s*전)\s*까지/;

function absenceMakeupRequest(
  text: string,
): PolicyRequest | 'personal_schedule' | undefined {
  if (
    !/보강|보충/.test(text) ||
    !absence.test(text) ||
    /휴강|휴원|휴일|공휴일|비용|환불|수강료|학원\s*사정|재보강|영상|녹화/.test(
      text,
    )
  )
    return;
  const scheduled =
    /보강\s*(?:일정|날짜|시각|시간)|몇\s*시(?:에)?\s*보강|보강(?:이|을)?\s*언제(?:에)?\s*(?:잡|시작)/.test(
      text,
    );
  if (scheduled) return 'personal_schedule';
  const exam = ACADEMY_EXAM_PERIOD.exec(text)?.[0];
  if (exam && SCHOOL_EXAM.test(text)) {
    const term = exam.startsWith('기말') ? '기말' : '중간';
    return {
      anchor:
        term + ' 대비 기간 학교 시험 결석 보강 예외 대체 프린트 해설 영상',
      applies: (heading, line) =>
        (heading.includes(term) ||
          Boolean(ACADEMY_EXAM_PERIOD.exec(line)?.[0].startsWith(term))) &&
        SCHOOL_EXAM.test(line) &&
        absence.test(line) &&
        /보강/.test(line) &&
        !/미정|검토|추후\s*안내|휴원|휴강/.test(line),
      fields: [
        {
          label: '학교 시험 결석 시 보강·대체 규정',
          value: (line) =>
            /보강.{0,32}(?:않|없|대신|제공|드립니다|합니다|가능|진행|받을\s*수)/.test(
              line,
            )
              ? withoutArticle(line)
              : undefined,
        },
      ],
      classScoped: true,
      useSingleEnrollment: true,
    };
  }
  const deadline =
    contact.test(text) &&
    /언제|며칠|몇\s*시|기한|마감|미리/.test(text) &&
    !scheduled;
  const sick = illness.test(text) && (!deadline || proof.test(text));
  const prospective =
    sick &&
    /결석\s*(?:하게|할|하면|예정)|빠(?:지면|져야)|못\s*가(?:면|게)/.test(text);
  const course =
    speaking.test(text) &&
    /따로|별도|대신|어떻게|받을\s*수|해\s*주|해줘|되나요|돼요|가능/.test(text);
  if (!deadline && !sick && !course) return;

  const matchesCourse = (line: string) =>
    (!/원어민/.test(text) || /(?<!비)원어민/.test(line)) &&
    (!/스피킹/.test(text) || /스피킹/.test(line));
  const belongsToCourse = (line: string) =>
    !speaking.test(line) || (course && matchesCourse(line));
  const fields: PolicyField[] = [];
  if (deadline || prospective)
    fields.push({
      label: '결석 사전 연락 기한',
      optional: !deadline,
      value: (line) => {
        if (!absence.test(line) || !/보강/.test(line) || !belongsToCourse(line))
          return;
        const match = contactDeadline.exec(line);
        if (!match) return;
        const start = Math.max(0, match.index - 18);
        const end = match.index + match[0].length + 15;
        return contact.test(line.slice(start, end)) ? match[0] : undefined;
      },
    });
  if (sick)
    fields.push({
      label: '질병 결석 시 보강 조건',
      value: (line) => {
        if (
          !illness.test(line) ||
          !absence.test(line) ||
          !belongsToCourse(line) ||
          (proof.test(text) && !proof.test(line)) ||
          !/보강|사전(?:에)?\s*(?:연락|통보)한\s*결석과\s*(?:같이|동일하게)\s*처리|사전\s*(?:연락|통보)\s*결석으로\s*인정/.test(
            line,
          )
        )
          return;
        return withoutArticle(line);
      },
    });
  if (prospective && !deadline && !proof.test(text) && !course)
    fields.push({
      label: '일반 보강 진행 방식',
      optional: true,
      value: (line) =>
        !speaking.test(line) &&
        /^보강은.{0,90}(?:클리닉|자습실|다른\s*반|별도\s*시간|영상).{0,42}(?:진행|합니다)/.test(
          withoutArticle(line),
        )
          ? withoutArticle(line)
          : undefined,
    });
  if (course)
    fields.push({
      label: '원어민 스피킹 결석 대체 방식',
      value: (line) => {
        if (
          !speaking.test(line) ||
          !matchesCourse(line) ||
          !absence.test(line) ||
          !/보강|대체|대신/.test(line) ||
          !/피드백|과제|다른\s*반|다음\s*수업|별도|진행하지\s*않|없습니다/.test(
            line,
          )
        )
          return;
        return withoutArticle(line);
      },
    });
  return {
    anchor: [
      '결석 보강 규정',
      deadline || prospective ? '사전 연락 기한 수업 전날' : '',
      sick ? '당일 질병 진료 확인서 증빙' : '',
      course ? '원어민 스피킹 대체 과제 피드백' : '',
    ].join(' '),
    applies: (heading, line) =>
      /결석|출결|보강/.test(heading) && !/휴강|휴원|학원\s*사정/.test(line),
    fields,
    classScoped: true,
  };
}

function policyRequest(
  text: string,
  role: RagAccessScope['role'],
): PolicyRequest | undefined {
  const transfer =
    /전반|반\s*(?:이동|변경|전환)|반(?:으?로|을)\s*(?:옮기|바꾸|이동|변경)|반을\s*바꿔/;
  const adjustment = /재정산|정산|재계산|다시\s*계산|차액|일할/;
  const tuition = /수강료|학원비|교습비/;
  if (transfer.test(text) && adjustment.test(text) && tuition.test(text)) {
    return {
      anchor: '반 이동 변경 전반 수강료 재정산 차액 일할 계산',
      applies: (_heading, line) =>
        transfer.test(line) &&
        tuition.test(line) &&
        adjustment.test(line) &&
        !/미정|확인\s*중|추후|검토|예정/.test(line),
      fields: [
        {
          label: '반 이동 시 수강료 정산 규정',
          value: (line) =>
            /(?:정산|계산|차액|일할).{0,28}(?:합니|받습니|없습니|않습니|됩니|돌려|반환|납부|반영|없음|없다)/.test(
              line,
            )
              ? line
              : undefined,
        },
      ],
      classScoped: true,
    };
  }
  const weekday = /([월화수목금토일])요일/.exec(text)?.[1];
  const asksEntryLead =
    /강의실|교실/.test(text) &&
    /입실|들어가|들어갈/.test(text) &&
    /몇\s*분\s*전부터|언제\s*부터|일찍.{0,18}들어갈/.test(text) &&
    !/보강|셔틀|방학|특강|휴강|공사/.test(text);
  if (asksEntryLead) {
    return {
      anchor: '강의실 입실 수업 시작 몇 분 전부터 입실 가능',
      applies: (heading, line) =>
        /강의실|교실/.test(heading + ' ' + line) &&
        /입실(?:할\s*수|이\s*가능|\s*가능)|들어갈\s*수/.test(line) &&
        !/입실(?:할\s*수\s*없|\s*불가)|시험|특강/.test(line),
      fields: [
        {
          label: '수업 전 입실 가능 시점',
          value: (line) =>
            /(?:수업\s*시작\s*)?\d{1,2}\s*분\s*전부터/.exec(line)?.[0],
        },
      ],
    };
  }

  const studyRoom = /자습실|자습\s*(?:하는|할)\s*방|공부방|독서실/;
  const admissionTest =
    EVALUATION.test(text) ||
    /(?:학원|입학|등록).{0,12}(?:들어가|등록|입학|시작)?\s*전(?:에|의)?.{0,12}(?:시험|평가)/.test(
      text,
    );
  const wantsHours =
    /몇\s*시(?!간)|시간대|운영\s*시간|여는\s*시간|닫는\s*시간/.test(text);
  const wantsStudyRoom = studyRoom.test(text) && !/수업|보강|레슨/.test(text);
  if (
    weekday &&
    wantsHours &&
    !/이번|다음|지난|방학|공휴일|휴강|변경|\d{1,2}\s*월\s*\d{1,2}\s*일|비용|얼마|신청|결과|걸려/.test(
      text,
    ) &&
    wantsStudyRoom !== admissionTest
  ) {
    const subject = admissionTest ? '입학 레벨테스트' : '자습실';
    const clock = '(?:[01]?\\d|2[0-3]):[0-5]\\d';
    const period = new RegExp(
      weekday + '요일\\s*[:：]?\\s*' + clock + '\\s*[~～–-]\\s*' + clock,
    );
    return {
      anchor: subject + ' ' + weekday + '요일 운영 시간',
      applies: (_heading, line) =>
        (admissionTest
          ? EVALUATION.test(line)
          : /(?:자습실|독서실|자습\s*공간).{0,18}(?:운영|개방|열)/.test(
              line,
            )) &&
        !/상담|강의실|주차|셔틀|변경|임시|휴무|방학|공휴일/.test(line),
      fields: [
        {
          label: subject + ' 운영 시간',
          value: (line) => period.exec(line)?.[0],
          quoteSelectedValue: true,
        },
      ],
    };
  }

  if (
    studyRoom.test(text) &&
    /이용료|요금|비용|무료|유료|돈.{0,10}(?:따로|내)|별도.{0,6}(?:비용|금액)/.test(
      text,
    ) &&
    !/시간|보강|수업료|환불|예약|특강|내년|다음\s*달/.test(text)
  ) {
    return {
      anchor: '자습실 이용료 재원생 추가 비용 무료 유료',
      applies: (heading, line) =>
        /자습실|독서실|자습\s*공간/.test(heading + ' ' + line) &&
        !/주차|상담|셔틀|교재|수강료/.test(line) &&
        /이용/.test(line),
      fields: [
        {
          label: '자습실 이용 요금',
          value: (line) =>
            /추가\s*비용\s*없이|무료(?:로|이며)?\s*(?:이용|제공)|유료(?:로|이며)?\s*(?:이용|제공)|이용료.{0,15}\d[\d,]*\s*원/.test(
              line,
            )
              ? withoutArticle(line)
              : undefined,
        },
      ],
    };
  }

  if (
    weekday &&
    /입학\s*상담/.test(text) &&
    /몇\s*시|시간|언제|되나요|가능/.test(text) &&
    !/휴일|공휴일|이번|다음|변경|레벨\s*테스트|소요|예약\s*방법/.test(text)
  ) {
    const hours = new RegExp(
      weekday +
        '요일\\s*((?:[01]?\\d|2[0-3]):[0-5]\\d\\s*[~–-]\\s*(?:[01]?\\d|2[0-3]):[0-5]\\d)',
    );
    return {
      anchor: '입학 상담 가능 시간 ' + weekday + '요일',
      applies: (heading, line) =>
        /입학\s*상담/.test(heading) && /상담\s*가능\s*시간/.test(line),
      fields: [
        { label: '상담 가능 시간', value: (line) => hours.exec(line)?.[1] },
      ],
    };
  }
  if (
    /조퇴/.test(text) &&
    /카톡|카카오톡|연락|통화|전화|메시지|문자/.test(text) &&
    !/결석(?:도|은|는|하고|이랑)|보강|출결\s*기록/.test(text)
  ) {
    return {
      anchor: '조퇴 연락 전화 통화 카카오톡',
      applies: (heading, line) => /조퇴/.test(heading) && /조퇴/.test(line),
      fields: [
        {
          label: '조퇴 연락 방법',
          value: (line) =>
            /조퇴.{0,70}(?:직접\s*통화|전화.{0,16}만)|보호자가.{0,45}(?:직접\s*통화|전화).{0,24}조퇴/.exec(
              line,
            )?.[0],
        },
      ],
    };
  }
  if (
    /돌봄\s*(?:자습반|수업|실)/.test(text) &&
    /수업/.test(text) &&
    /숙제|지도|가르치/.test(text) &&
    !/시간표|보강|할인|비용|수강료|예약/.test(text)
  ) {
    return {
      anchor: '돌봄 자습반 숙제 정규 수업 운영 시간',
      applies: (heading, line) =>
        /돌봄\s*자습반/.test(heading) && /돌봄|숙제/.test(line),
      fields: [
        {
          label: '돌봄 수업 방식',
          value: (line) =>
            /숙제를.{0,35}(?:정규\s*)?수업.{0,18}(?:하지\s*않|없|진행)/.exec(
              line,
            )?.[0],
        },
        {
          label: '돌봄 운영 시간',
          optional: true,
          value: (line) =>
            /돌봄\s*자습반.{0,35}\b\d{1,2}:\d{2}까지\s*운영/.exec(line)?.[0],
        },
      ],
    };
  }
  if (
    /와이파이|wi[\s-]*fi/i.test(text) &&
    /비번|비밀\s*번호|접속|이용/.test(text) &&
    !/관리자|공유기|직원용|변경|재설정/.test(text)
  ) {
    const target = /(?:원생|학생|방문객|학부모)(?=용|\s*도)/.exec(text)?.[0];
    const audience =
      target === '학생' || target === '원생'
        ? /원생|학생/
        : target
          ? new RegExp(target)
          : role === 'student'
            ? /원생|학생/
            : undefined;
    return {
      anchor: '시설 와이파이 이용 제공 운영 여부 ' + (target ?? ''),
      applies: (_heading, line) => {
        const stated = /(?:원생|학생|방문객|학부모)(?=용)/.exec(line)?.[0];
        return (
          /와이파이/.test(line) &&
          (!stated || !audience || audience.test(stated))
        );
      },
      fields: [
        {
          label: '와이파이 이용',
          value: (line) =>
            /(?:(?:원생|학생|방문객|학부모)용\s*)?와이파이.{0,20}(?:(?:제공|운영)하지\s*않(?:습니다|음)|이용할\s*수\s*없(?:습니다|음))/.exec(
              line,
            )?.[0],
          quoteSelectedValue: true,
        },
      ],
      factTypes: ['facility'],
    };
  }
  const room = /질문\s*(?:방|클리닉)/.exec(text)?.[0];
  if (
    room &&
    /조교|어떤\s*선생님|담당|누가/.test(text) &&
    /몇\s*시|언제|어떤|누가|계세|봐\s*주|담당/.test(text) &&
    !/비용|환불|신청|예약|보강|특강/.test(text)
  ) {
    const asksHours = /몇\s*시|언제/.test(text);
    return {
      anchor: room + ' 조교 담당 운영 시간',
      boardReplies: true,
      applies: (heading, line) =>
        compactText(heading + ' ' + line).includes(compactText(room)),
      fields: [
        {
          label: asksHours ? '조교 근무 시간' : '담당 강사',
          value: (line) =>
            asksHours
              ? /(?:조교|담당\s*강사).{0,34}\b(\d{1,2}:\d{2})\s*(?:부터|[~–-]\s*\d{1,2}:\d{2})/.exec(
                  line,
                )?.[1]
              : /담당\s*(?:강사|교사)\s*[:：]\s*[가-힣]{2,5}(?=\s|[.!?,]|$)/.exec(
                  line,
                )?.[0],
        },
      ],
    };
  }
  const examScope =
    /시험\s*범위/.test(text) && /어디|알려|뭐|어떤|범위가/.test(text);
  const school = /([가-힣]{2,}(?:초|중|고))(?=\s|$)/.exec(text)?.[1];
  if (examScope && school && /기말|중간/.test(text)) {
    const exam = /기말|중간/.exec(text)?.[0] ?? '';
    return {
      anchor: school + ' ' + exam + ' 시험 범위',
      applies: (heading, line) =>
        (heading + line).includes(school) && (heading + line).includes(exam),
      fields: [
        {
          label: '시험 범위',
          value: (line) =>
            /시험\s*범위\s*[:：]\s*([^.!?]{3,100})/.exec(line)?.[1],
        },
      ],
    };
  }
  const benefit = /([가-힣]{2,}(?:카드|바우처|상품권))/.exec(text)?.[1];
  if (benefit && /추가\s*할인|할인\s*(?:되|돼|적용|가능|있)/.test(text)) {
    return {
      anchor: benefit + ' 할인 적용 조건',
      applies: (_heading, line) =>
        compactText(line).includes(compactText(benefit)),
      fields: [
        {
          label: '요청한 할인 적용 조건',
          value: (line) =>
            /할인.{0,25}(?:적용|가능|불가|받|제외|없|않)|\d+(?:\.\d+)?\s*%를?\s*할인/.exec(
              line,
            )?.[0],
        },
      ],
    };
  }
  const asksDuration =
    /얼마나|몇\s*(?:시간|분|일|주)|며칠|얼마\s*동안|소요/.test(text);
  const reservationType = /첨삭|상담|클리닉|보강/.exec(text)?.[0];
  if (
    reservationType &&
    /예약/.test(text) &&
    /(?:일주일|한\s*주|주간|주당).{0,20}(?:몇\s*(?:번|회)|한도|제한)/.test(
      text,
    ) &&
    !/변경|취소|환불|할인|결제|비용/.test(text)
  ) {
    const asksAvailability = /자리.{0,8}(?:남|있)|빈\s*(?:시간|자리)|잔여/.test(
      text,
    );
    const weekday = /[월화수목금토일]요일/.exec(text)?.[0];
    const time = /오전|오후|저녁|\d{1,2}\s*시/.exec(text)?.[0];
    const month = /(?<!\d)\d{1,2}\s*월/.exec(text)?.[0];
    const fields: PolicyField[] = [
      {
        label: '주간 예약 횟수',
        value: (line) =>
          /예약/.test(line)
            ? /(?:같은\s*주에|일주일에|주당|한\s*주에).{0,10}(\d+\s*(?:회|번))\s*까지/.exec(
                line,
              )?.[1]
            : undefined,
      },
    ];
    if (asksAvailability)
      fields.push({
        label: '요청 시간대의 예약 가능 자리',
        value: (line) =>
          weekday &&
          time &&
          line.includes(weekday) &&
          line.includes(time) &&
          (!month || compactText(line).includes(compactText(month)))
            ? /잔여\s*\d+\s*(?:석|자리|건)|예약\s*마감/.exec(line)?.[0]
            : undefined,
      });
    return {
      anchor: reservationType + ' 예약 횟수 운영',
      applies: (heading, line) =>
        heading.includes(reservationType) || line.includes(reservationType),
      fields,
      publicOffering: /(?:초등|중등|고등)\s*첨삭/.exec(text)?.[0],
    };
  }
  if (
    EVALUATION.test(text) &&
    !/몇\s*점|통과|승급\s*(?:조건|기준)|응시료|수강료|비용|정답률|성적표/.test(
      text,
    )
  ) {
    const label = EVALUATION.exec(text)?.[0] ?? '';
    const assessment = compactText(label);
    const fields: PolicyField[] = [];
    if (asksDuration && /시간|몇\s*분|소요/.test(text))
      fields.push({
        label: '평가 소요 시간',
        value: (line) =>
          /(?:평가|테스트|시험|실습|응시)\s*(?:(?:소요\s*)?시간(?:은|이)?\s*)?[:(]?\s*(?:실습\s*)?(\d+\s*(?:분|시간))/.exec(
            line,
          )?.[1],
      });
    if (/결과.{0,22}(?:언제|며칠|몇\s*일|통보\s*시기|발표\s*시점)/.test(text))
      fields.push({
        label: '결과 안내 시점',
        value: (line) =>
          /결과.{0,44}?(\d+\s*(?:일|주|개월)\s*(?:안에|이내|뒤|후)).{0,20}(?:안내|발표|통보|알려)/.exec(
            line,
          )?.[1],
      });
    if (fields.length)
      return {
        anchor: label,
        applies: (heading, sentence) =>
          compactText(heading).includes(assessment) ||
          compactText(sentence).includes(assessment),
        fields,
      };
  }
  const item = /원고|과제|보고서|서류/.exec(text)?.[0];
  if (
    item &&
    /올려|올리|제출|내야|내는/.test(text) &&
    /언제\s*까지|몇\s*(?:시|일)\s*까지|마감/.test(text) &&
    !/몇\s*(?:개|장)|분량|환불|취소|양식|파일\s*형식/.test(text)
  ) {
    const editing = /첨삭/.test(text);
    return {
      anchor: [editing ? '첨삭' : '', item, '제출 마감'].join(' '),
      applies: (heading, line) =>
        (!editing || /첨삭/.test(heading + ' ' + line)) &&
        line.includes(item) &&
        /제출|올리|올립|내야|냅니/.test(line) &&
        !/않으면|못\s*내|기한을\s*넘|올리면|제출하면|제출\s*(?:한|완료)\s*뒤/.test(
          line,
        ),
      fields: [
        {
          label: item + ' 제출 기한',
          value: (line) =>
            /(?:\d+\s*일\s*전\s*)?(?:\d{1,2}:\d{2}|\d{1,2}\s*시|(?:\d{1,2}\s*월\s*)?\d+\s*일(?:\s*전)?)(?:\s*\([월화수목금토일]\))?\s*(?:까지|이내)/.exec(
              line,
            )?.[0],
        },
      ],
    };
  }
  if (
    VIDEO.test(text) &&
    /결석|보강|빠지|녹화/.test(text) &&
    !/보내\s*줘|다운로드|공유|비용|얼마|어디|로그인/.test(text)
  ) {
    const exam = TEST_PERIOD.test(text);
    if (!exam && !asksDuration) return;
    const fields: PolicyField[] = [];
    if (asksDuration)
      fields.push({
        label: '영상 시청 기간',
        value: (line) =>
          /(\d+\s*(?:시간|분|일|주|개월))\s*(?:동안|이내(?:에)?)\s*(?:볼\s*수|시청)/.exec(
            line,
          )?.[1] ??
          /시청\s*(?:가능\s*)?기간(?:은|이|:)\s*(\d+\s*(?:시간|분|일|주|개월))/.exec(
            line,
          )?.[1],
      });
    else
      fields.push({
        label: '시험 기간 결석 시 영상 제공',
        value: (line) => {
          const prohibited =
            /영상.{0,12}(?:제공|대체|시청).{0,8}(?:않|불가|대신)|영상(?:으로)?\s*대체\s*대신/.test(
              line,
            );
          const allowed =
            /영상.{0,12}(?:제공합니다|대체할\s*수\s*있|시청할\s*수\s*있)/.test(
              line,
            );
          if (!prohibited && !allowed) return;
          const session = /\d{1,2}:\d{2}\s*[~–-]\s*\d{1,2}:\d{2}/.exec(
            line,
          )?.[0];
          return [prohibited ? '미제공' : '제공', session ?? ''].join('|');
        },
      });
    return {
      anchor: exam ? '시험 기간 결석 영상 대체' : '결석 녹화 영상 시청 기간',
      applies: (heading, line) =>
        VIDEO.test(line) &&
        /결석|보강|빠지|녹화/.test(heading + ' ' + line) &&
        (exam
          ? /시험|고사|변경\s*시간표\s*기간/.test(line) &&
            /결석|보강|빠지/.test(line)
          : !/시험|고사/.test(heading + ' ' + line)),
      fields,
      specific: exam ? (heading) => /시험|고사/.test(heading) : undefined,
    };
  }
}

async function answerAdvancementThreshold(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const level = /(?<![a-z0-9])L\s*(\d+)(?!\d)/i;
  const requested = level.exec(frame.normalized);
  if (
    !requested ||
    !EVALUATION.test(frame.normalized) ||
    !/몇\s*점|기준\s*점수|커트라인/.test(frame.normalized) ||
    !/올라가|승급|진급/.test(frame.normalized) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativePeriod ||
    /지난|다음\s*달|내년|예상|합격\s*가능/.test(frame.normalized)
  )
    return;
  const targets = explicitClassIds(ctx);
  const refs = ctx.access.studentRefs.filter(
    ({ studentId }) =>
      !frame.matchedStudentIds.length ||
      frame.matchedStudentIds.includes(studentId),
  );
  if (refs.length !== 1 || targets.length !== 1) return;
  const [ref] = refs;
  const [target] = ctx.catalog.classes.filter(
    ({ classId }) => classId === targets[0],
  );
  const track = (name: string) => /^\s*L\s*(\d+)\s+(.+)$/i.exec(name);
  const desired = target && track(target.name);
  if (!desired || Number(desired[1]) !== Number(requested[1])) return;
  const sameTrack = ctx.catalog.classes.filter(({ classId, name, subject }) => {
    const enrolled = track(name);
    return (
      ref.classIds?.includes(classId) &&
      enrolled &&
      subject === target.subject &&
      compactText(enrolled[2]) === compactText(desired[2])
    );
  });
  if (
    sameTrack.length !== 1 ||
    Number(level.exec(sameTrack[0].name)?.[1]) + 1 !== Number(desired[1])
  )
    return;
  const facts = await ctx.facts.queryApprovedFacts({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    factTypes: ['notice'],
  });
  recordFacts(ctx.trace, facts);
  const thresholds = facts.flatMap((fact) => {
    if (
      fact.subjectType !== 'academy' ||
      fact.value.kind !== 'text' ||
      isAssistantDirective(fact.value.text)
    )
      return [];
    const text = fact.value.text;
    const match =
      /^레벨\s*(?:평가|테스트)(?:에서|는)?\s*(\d+)\s*점\s*(이상|초과)(?:이면|일\s*경우)\s*다음\s*레벨(?:로)?\s*(?:승급|진급)(?:합니다|됩니다)[.!]?$/.exec(
        text.trim(),
      );
    return match ? [{ fact, text, key: match[1] + match[2] }] : [];
  });
  if (!thresholds.length) return;
  if (new Set(thresholds.map(({ key }) => key)).size !== 1)
    return abstain(
      '같은 승급 단계의 승인 기준이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  const [{ fact, text }] = thresholds;
  ctx.trace.intent = 'level_advancement_threshold';
  return {
    status: 'answered',
    text,
    citations: [{ kind: 'fact', fact }],
    usedFacts: [fact],
  };
}

function absenceDayOffset(frame: AnswerContext['frame']): number | null {
  if (frame.relativeDay !== null) return frame.relativeDay;
  const days = [
    ...new Set(
      [
        ...frame.normalized.matchAll(
          /(?<![가-힣])(그저께|어제)(?:에)?(?=\s|$)/g,
        ),
      ].map(([, day]) => day),
    ),
  ];
  return days.length === 1 ? (days[0] === '어제' ? -1 : -2) : null;
}

async function answerPersonalMakeupSchedule(
  ctx: AnswerContext,
  studentIdHint: string | undefined,
): Promise<AnswerDraft> {
  const { access, frame, state, asOf } = ctx;
  const missing = () =>
    abstain(
      '결석과 연결된 개인 보강 일정을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['확정된 개인 보강 일정'],
    );
  const resolution = resolveSubjects({ access, frame, state, studentIdHint });
  if (resolution.kind !== 'resolved' || resolution.studentIds.length !== 1)
    return missing();
  const relativeDay = absenceDayOffset(frame);
  if (
    frame.explicitDates.length > 1 ||
    frame.explicitDates.some(({ operator }) => operator !== 'at') ||
    (frame.explicitDates.length && relativeDay !== null)
  )
    return missing();
  const today = toKstDate(asOf);
  const absenceDay =
    relativeDay === null
      ? resolveEffectiveTime(frame, asOf).explicitDay
      : kstStartOfDay({ ...today, day: today.day + relativeDay });
  if (absenceDay === null) return missing();

  const [studentId] = resolution.studentIds;
  ctx.trace.targetStudentIds = [studentId];
  const facts = await ctx.facts.queryApprovedFacts({
    access,
    studentIds: [studentId],
    factTypes: ['schedule_change'],
    asOf,
  });
  recordFacts(ctx.trace, facts);
  const linkedDate =
    /(\d{4}-\d{2}-\d{2}|(?:\d{4}년\s*)?\d{1,2}월\s*\d{1,2}일(?:\s*\([월화수목금토일]\))?)\s*(?:수업\s*)?(?=결석)/g;
  const candidates = facts.flatMap((fact) => {
    const { value } = fact;
    if (
      fact.subjectType !== 'student' ||
      fact.subjectId !== studentId ||
      value.kind !== 'schedule_change' ||
      value.changeType !== 'makeup' ||
      (frame.classIds.length > 0 &&
        (!fact.classId || !frame.classIds.includes(fact.classId))) ||
      isAssistantDirective(value.text)
    )
      return [];
    const dates = [...value.text.matchAll(linkedDate)];
    if (
      dates.length !== 1 ||
      tableDateAt(dates[0][1], toKstDate(absenceDay).year) !== absenceDay
    )
      return [];
    const appointment = tableDateAt(value.date, today.year);
    const time =
      /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[~–-]\s*(?:[01]?\d|2[0-3]):[0-5]\d)?$/.test(
        value.time ?? '',
      )
        ? value.time
        : null;
    if (
      appointment === undefined ||
      appointment < absenceDay ||
      (/몇\s*시|보강\s*(?:시간|시각)/.test(frame.normalized) && !time)
    )
      return [];
    return [{ fact, appointment, time }];
  });
  if (
    new Set(
      candidates.map(
        ({ appointment, time }) => appointment + '|' + (time ?? ''),
      ),
    ).size > 1
  )
    return abstain(
      '같은 결석에 대해 승인된 보강 일정이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  if (!candidates.length) return missing();
  const [{ fact, appointment, time }] = candidates;
  ctx.trace.intent = 'personal_makeup_schedule';
  return {
    status: 'answered',
    text:
      formatKstDate(absenceDay) +
      ' 결석분 보강 일정은 ' +
      formatKstDate(appointment) +
      (time ? ' ' + time : '') +
      '입니다.',
    citations: [{ kind: 'fact', fact }],
    usedFacts: [fact],
    instants: [asOf, absenceDay, appointment],
  };
}

async function answerMaterialTakeHomeDeadline(
  ctx: AnswerContext,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const q = compactText(frame.normalized);
  const item = /키트|교구/.exec(q)?.[0];
  const oldItem = /기존|원래|쓰던|사용하던/.test(q);
  if (
    !item ||
    !/언제까지|기한|마감/.test(q) ||
    !/집|가정/.test(q) ||
    !/가져가|가져와|챙겨가|들고가/.test(q) ||
    /새키트|구매|비용|가격|반납|대여|환불|비교/.test(q) ||
    frame.explicitDates.length ||
    frame.months.length ||
    frame.relativeWeek ||
    frame.relativePeriod ||
    frame.relativeDay !== null ||
    frame.unboundProgram ||
    frame.unknownPrograms.length
  )
    return;
  const ids = explicitClassIds(ctx);
  const klass =
    ids.length === 1
      ? ctx.catalog.classes.find(({ classId }) => classId === ids[0])
      : undefined;
  const course = compactText(klass?.name ?? '').replace(
    /^[초중고][1-6](?:학년)?/,
    '',
  );
  const school = /^(초|중|고)/.exec(klass?.grade ?? '')?.[1];
  const names = klass ? [klass.name, ...klass.aliases].map(compactText) : [];
  const hits = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [klass?.name, item, '기존 가정으로 가져가 날짜 기한'].join(' '),
    documentTypes: ['announcement', 'policy', 'schedule', 'fee'],
    limit: 45,
  });
  recordChunks(
    ctx.trace,
    hits.map(({ chunk }) => chunk),
  );
  const options = hits.flatMap(({ chunk }) => {
    if (
      chunk.location.kind !== 'paragraph' ||
      (chunk.classId && chunk.classId !== klass?.classId) ||
      !isCleanPublicEvidence(chunk, ctx.asOf)
    )
      return [];
    return splitSentences(chunk.text).flatMap((line) => {
      const text = compactText(line);
      const bindsClass =
        (klass && chunk.classId === klass.classId) ||
        names.some((name) => text.includes(name)) ||
        (school && course && text.includes(school + '등' + course)) ||
        /(?:모든반|전원생|전체원생|모든원생)/.test(text);
      if (
        !bindsClass ||
        !text.includes(item) ||
        (oldItem && !/기존|사용하던|쓰던/.test(text)) ||
        !/(?:집|가정)(?:에|으로)?.{0,16}(?:가져가|챙겨가|들고가)/.test(text) ||
        /미정|추후|확인중|(?:가져|챙겨)가지않/.test(text)
      )
        return [];
      const deadlines = [
        ...text.matchAll(
          /(?<!\d)((?:20\d{2}년)?\d{1,2}월\d{1,2}일(?:\([월화수목금토일](?:요일)?\))?)까지/g,
        ),
      ];
      if (deadlines.length !== 1) return [];
      const at = tableDateAt(deadlines[0][1], toKstDate(chunk.validFrom).year);
      const excerpt = { chunk, line };
      return at !== undefined && supportsExcerpt(excerpt)
        ? [{ at, excerpt }]
        : [];
    });
  });
  if (!options.length)
    return abstain(
      '가정으로 가져갈 기한을 승인 안내에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      ['가정으로 가져갈 기한'],
    );
  if (new Set(options.map(({ at }) => at)).size > 1)
    return abstain(
      '승인 자료의 반별 가져갈 기한이 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );
  ctx.trace.intent = 'material_take_home_deadline';
  return fromPublicExcerpts([options[0].excerpt]);
}

/** Public administrative questions must retrieve the policy field they ask for. */
export async function answerPolicyEvidence(
  ctx: AnswerContext,
  studentIdHint?: string,
): Promise<AnswerDraft | undefined> {
  const { frame } = ctx;
  const replacementFee = await answerReplacementFee(ctx);
  if (replacementFee) return replacementFee;
  const materialDeadline = await answerMaterialTakeHomeDeadline(ctx);
  if (materialDeadline) return materialDeadline;
  const makeup = absenceMakeupRequest(frame.normalized);
  const asksCause =
    frame.flags.causal &&
    (!makeup || /원인|이유|(?:^|\s)왜(?:\s|$)|탓/.test(frame.normalized));
  if (
    frame.unknownPrograms.length ||
    frame.unboundProgram ||
    frame.flags.previousRevision ||
    frame.flags.attitude ||
    asksCause ||
    frame.flags.prediction ||
    frame.flags.compare ||
    /내년|다음\s*(?:달|기수)|지난\s*(?:달|기수)/.test(frame.normalized)
  )
    return;

  if (makeup === 'personal_schedule')
    return answerPersonalMakeupSchedule(ctx, studentIdHint);
  const advancement = await answerAdvancementThreshold(ctx);
  if (advancement) return advancement;
  const equipment = /노트북|태블릿|충전기|기기/.exec(frame.normalized)?.[0];
  const offsite = /반출|학원\s*밖|집(?:에|으로).{0,10}(?:가져|들고)/.test(
    frame.normalized,
  );
  const prior = ctx.state?.previousFrame;
  const loan =
    equipment ??
    (prior?.domain === 'info' &&
    /빌린\s*(?:거|것)|대여한\s*(?:거|것)/.test(frame.normalized)
      ? prior.loanItem
      : undefined);
  if (
    loan &&
    offsite &&
    (!equipment || /대여|빌린|빌려/.test(frame.normalized)) &&
    !/반납|언제|수강료|사용료|얼마|요금|신청|분실|파손/.test(frame.normalized)
  ) {
    const facts = await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      factTypes: ['notice'],
    });
    recordFacts(ctx.trace, facts);
    const matching = facts.flatMap((fact) => {
      if (fact.subjectType !== 'academy' || fact.value.kind !== 'text')
        return [];
      const line = fact.value.text;
      if (
        !compactText(line).includes(compactText(loan)) ||
        !/대여|빌린/.test(line) ||
        !/반출|학원\s*밖/.test(line) ||
        isAssistantDirective(line)
      )
        return [];
      const denied =
        /반출.{0,16}(?:없|불가|금지|안\s*됩)|학원\s*밖.{0,18}(?:없|불가|금지)/.test(
          line,
        );
      const allowed = /반출.{0,14}(?:가능|할\s*수\s*있)/.test(line);
      return denied || allowed ? [{ fact, line }] : [];
    });
    if (!matching.length)
      return abstain(
        '해당 대여 품목의 외부 반출 규정을 승인 자료에서 확인할 수 없습니다.',
        'INSUFFICIENT_EVIDENCE',
      );
    if (new Set(matching.map(({ line }) => compactText(line))).size > 1)
      return abstain(
        '같은 대여 품목의 외부 반출 규정이 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    const [match] = matching;
    ctx.trace.intent = 'equipment_offsite_policy';
    return {
      status: 'answered',
      text: match.line,
      citations: [{ kind: 'fact', fact: match.fact }],
      usedFacts: [match.fact],
      conversationUpdate: {
        previousFrame: {
          domain: 'info',
          units: [],
          periods: [],
          loanItem: loan,
        },
      },
    };
  }
  if (
    equipment &&
    /대여|빌리|빌릴/.test(frame.normalized) &&
    /신청|어떻게\s*빌/.test(frame.normalized) &&
    !/얼마|비용|요금|내야|언제|며칠|반납|할인/.test(frame.normalized)
  ) {
    const facts = await ctx.facts.queryApprovedFacts({
      access: ctx.access,
      studentIds: [],
      asOf: ctx.asOf,
      factTypes: ['notice'],
    });
    recordFacts(ctx.trace, facts);
    const candidates = facts.filter(
      (fact) =>
        fact.subjectType === 'academy' &&
        fact.value.kind === 'text' &&
        !isAssistantDirective(fact.value.text) &&
        fact.value.text.includes(equipment) &&
        /대여|빌리/.test(fact.value.text) &&
        /신청(?:서|을|하면|하)|예약(?:을|하면|하)/.test(fact.value.text),
    );
    const lines = candidates.flatMap(({ value }) =>
      value.kind === 'text' ? [value.text] : [],
    );
    if (new Set(lines.map(compactText)).size > 1)
      return abstain(
        '대여 신청에 대한 승인 안내가 서로 다릅니다.',
        'CONFLICTING_EVIDENCE',
      );
    if (candidates.length) {
      ctx.trace.intent = 'equipment_application';
      return {
        status: 'answered',
        text: lines[0],
        citations: [{ kind: 'fact', fact: candidates[0] }],
        usedFacts: [candidates[0]],
      };
    }
  }

  const request = makeup ?? policyRequest(frame.normalized, ctx.access.role);
  if (!request) return;
  const effective = resolveEffectiveTime(frame, ctx.asOf);
  const today = toKstDate(ctx.asOf);
  const relativeDay = request.classScoped ? absenceDayOffset(frame) : null;
  const at =
    effective.explicitDay === null && relativeDay
      ? kstStartOfDay({ ...today, day: today.day + relativeDay })
      : effective.at;
  const scopedClasses = frame.matchedStudentIds.length
    ? ctx.studentClassIds
    : explicitClassIds(ctx);
  const soleStudent =
    ctx.access.allowedStudentIds.length === 1
      ? ctx.access.studentRefs.find(
          ({ studentId }) => studentId === ctx.access.allowedStudentIds[0],
        )
      : undefined;
  const classIds =
    request.useSingleEnrollment &&
    !scopedClasses.length &&
    !frame.unresolvedRelationWords.length &&
    !frame.groupReference
      ? (soleStudent?.classIds ?? []).filter(
          (id) => !frame.negatedClassIds.includes(id),
        )
      : scopedClasses;
  const found = await ctx.documents.searchApprovedChunks({
    access: ctx.access,
    studentIds: [],
    asOf: ctx.asOf,
    query: [request.anchor, ...request.fields.map(({ label }) => label)].join(
      ' ',
    ),
    documentTypes: [
      'policy',
      'academy_info',
      'announcement',
      'schedule',
      'facility',
    ],
    limit: 48,
    upcomingUntil: request.classScoped && at > ctx.asOf ? at : undefined,
  });
  recordChunks(
    ctx.trace,
    found.map(({ chunk }) => chunk),
  );
  const offeringSources = new Set(
    found.flatMap(({ chunk }) => {
      if (
        !request.publicOffering ||
        classIds.length ||
        chunk.visibility !== 'academy_public' ||
        !canReadRecord(ctx.access, chunk, []) ||
        chunk.location.kind !== 'table_row' ||
        chunk.suspicious ||
        isAssistantDirective(chunk.text) ||
        chunk.extraction?.needsReview ||
        chunk.extraction?.uncertainTokens.length ||
        !isValidAt(chunk.validFrom, chunk.validTo, at)
      )
        return [];
      const { header, cells } = chunk.location;
      const key =
        header?.findIndex((field) =>
          /^(?:과정|과정명|반|강좌|코스)$/.test(compactText(field)),
        ) ?? -1;
      return compactText((cells?.[key] ?? '').replace(/\(.*\)$/, '')) ===
        compactText(request.publicOffering)
        ? [chunk.sourceId]
        : [];
    }),
  );

  type Claim = { value: string; excerpt: EvidenceExcerpt };
  const groups = new Map<string, Map<string, Claim[]>>();
  const exactClassGroups = new Set<string>();
  for (const { chunk } of found) {
    if (
      chunk.location.kind !== 'paragraph' ||
      chunk.suspicious ||
      !canReadRecord(ctx.access, chunk, []) ||
      !isValidAt(chunk.validFrom, chunk.validTo, at) ||
      isAssistantDirective(chunk.text) ||
      chunk.extraction?.needsReview ||
      chunk.extraction?.uncertainTokens.length ||
      (chunk.classId &&
        ((request.classScoped && classIds.length !== 1) ||
          (!classIds.includes(chunk.classId) &&
            !offeringSources.has(chunk.sourceId)))) ||
      (!request.boardReplies &&
        /게시판|질문\s*답변|문의\s*모음/.test(chunk.title))
    )
      continue;
    const heading = [chunk.title, chunk.location.section ?? ''].join(' ');
    const headingKey = compactText(heading);
    const namedClasses = request.classScoped
      ? ctx.catalog.classes
          .filter(({ name }) => headingKey.includes(compactText(name)))
          .map(({ classId }) => classId)
      : [];
    if (
      namedClasses.length &&
      (!classIds.length || !classIds.every((id) => namedClasses.includes(id)))
    )
      continue;
    const exactClass =
      request.classScoped &&
      classIds.length === 1 &&
      (chunk.classId === classIds[0] || namedClasses.includes(classIds[0]));
    const level = /(?:^|\s)(초|중|고)등부(?=\s|$)/.exec(heading)?.[1];
    if (
      level &&
      (classIds.length === 0 ||
        !classIds.every((id) =>
          ctx.catalog.classes.some(
            ({ classId, grade }) => classId === id && grade?.startsWith(level),
          ),
        ))
    )
      continue;
    const key = chunk.sourceId + '|' + (chunk.location.section ?? '');
    const statements = request.boardReplies
      ? officialStatements(chunk).flatMap(({ text }) => splitSentences(text))
      : splitSentences(chunk.text);
    for (const line of statements) {
      if (!request.applies(heading, line)) continue;
      for (const { label, value, quoteSelectedValue } of request.fields) {
        const selected = value(line);
        if (!selected) continue;
        const excerpt = { chunk, line: quoteSelectedValue ? selected : line };
        if (!supportsExcerpt(excerpt)) continue;
        const slots = groups.get(key) ?? new Map<string, Claim[]>();
        const claims = slots.get(label) ?? [];
        claims.push({ value: compactText(selected), excerpt });
        slots.set(label, claims);
        groups.set(key, slots);
        if (exactClass) exactClassGroups.add(key);
      }
    }
  }
  const candidates = [...groups]
    .filter(([key]) => !exactClassGroups.size || exactClassGroups.has(key))
    .map(([, slots]) => slots);
  if (!candidates.length)
    return abstain(
      '요청하신 규정 항목을 승인 자료에서 확인할 수 없습니다.',
      'INSUFFICIENT_EVIDENCE',
      request.fields.map(({ label }) => label),
    );
  if (
    request.fields.some(
      ({ label }) =>
        new Set(
          candidates.flatMap((slots) =>
            (slots.get(label) ?? []).map(({ value }) => value),
          ),
        ).size > 1,
    )
  )
    return abstain(
      '같은 규정 항목의 승인 안내가 서로 다릅니다.',
      'CONFLICTING_EVIDENCE',
    );

  const specificity = (slots: Map<string, Claim[]>) =>
    Number(
      [...slots.values()].some((claims) =>
        claims.some(({ excerpt: { chunk } }) =>
          request.specific?.(
            chunk.title + ' ' + (chunk.location.section ?? ''),
          ),
        ),
      ),
    );
  const selected = candidates.sort(
    (a, b) => b.size - a.size || specificity(b) - specificity(a),
  )[0];
  const excerpts = [
    ...new Set(
      request.fields.flatMap(({ label }) => {
        const claim = selected.get(label)?.[0];
        return claim ? [claim.excerpt] : [];
      }),
    ),
  ];
  const missing = request.fields
    .filter(({ label, optional }) => !optional && !selected.has(label))
    .map(({ label }) => label);
  const factTypes =
    request.factTypes ??
    (request.classScoped ? (['makeup_policy'] as const) : []);
  const approved = factTypes.length
    ? await ctx.facts.queryApprovedFacts({
        access: ctx.access,
        studentIds: [],
        factTypes,
        asOf: ctx.asOf,
        effectiveAt: at,
      })
    : [];
  recordFacts(ctx.trace, approved);
  const supportedFacts = approved.filter(
    ({ value, subjectType, subjectId, sourceId }) =>
      value.kind === 'text' &&
      (subjectType === 'academy' ||
        (subjectType === 'class' &&
          classIds.length === 1 &&
          subjectId === classIds[0])) &&
      excerpts.some(
        ({ chunk, line }) =>
          chunk.sourceId === sourceId &&
          compactText(withoutArticle(line).replace(/\*\*/g, '')) ===
            compactText(value.text),
      ),
  );
  ctx.trace.intent = 'policy_fields';
  return {
    status: missing.length ? 'partial' : 'answered',
    reasonCode: missing.length ? 'PARTIAL_EVIDENCE' : undefined,
    missingFields: missing.length ? missing : undefined,
    text: [
      ...excerpts.map(({ line }) => line),
      ...(missing.length ? ['확인되지 않은 항목: ' + missing.join(', ')] : []),
    ].join('\n'),
    excerpts,
    citations: [
      ...excerpts.map(({ chunk }) => ({
        kind: 'chunk' as const,
        chunk,
        ...(request.classScoped ? { effectiveAt: at } : {}),
      })),
      ...supportedFacts.map((fact) => ({
        kind: 'fact' as const,
        fact,
        effectiveAt: at,
      })),
    ],
    usedFacts: supportedFacts,
  };
}
