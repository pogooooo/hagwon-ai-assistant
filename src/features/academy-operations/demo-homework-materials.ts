import { accessibleClasses } from './directory.ts';
import { escapeHtml as h, type PageContext } from './shared.ts';

export const demoHomeworkMaterials = [
  {
    academyId: 'AC_TEST_A',
    academyName: '[가상] 테스트 교습소',
    classId: 'TA_E_MATH',
    teacherId: 'TA_TEACHER',
    title: '분수 계산 복습 활동지',
    book: '온답 수학 활동지',
    file: 'assets/demo-homework-fractions.pdf',
    subject: 'MATH',
    skill: '분수의 덧셈과 뺄셈',
    page: 1,
    rights: 'rights_ondap_fractions_original',
    requestKey: 'ondap-demo-fractions-homework-v1',
    workbookId: '2cdd42f5-2504-4c35-bafd-75b92accdf22',
  },
  {
    academyId: 'AC_ONDAP_LANGUAGE_DEMO',
    academyName: '[가상] 온답 어학원',
    classId: 'ONDAP_DEMO_ENGLISH',
    teacherId: 'ONDAP_LANGUAGE_TA_TEACHER',
    title: '일과와 약속 시간 복습',
    book: '온답 영어 회화',
    file: 'assets/demo-homework-english.pdf',
    subject: 'ENG',
    skill: '시간 전치사',
    page: 9,
    rights: 'rights_ondap_language_original',
    requestKey: 'ondap-demo-language-homework-v1',
    workbookId: 'bd58e497-c80f-4cc9-8fc2-06ac513d33e5',
  },
] as const;

export function homeworkMaterial(ctx: PageContext) {
  if (!ctx.showDemoRecords) return;
  const material = demoHomeworkMaterials.find(
    (m) => m.academyId === ctx.actor.academyId,
  );
  if (
    material &&
    accessibleClasses(ctx.db, ctx.actor).some((c) => c.id === material.classId)
  )
    return material;
}

export function renderHomeworkMaterial(
  material: (typeof demoHomeworkMaterials)[number],
  assignmentHref?: string,
  assignmentAction = '과제로 이동',
) {
  return (
    '<section class="panel homework-material" aria-labelledby="homework-material-title">' +
    '<div><h2 id="homework-material-title">숙제 자료</h2><p><strong>' +
    h(material.title) +
    '</strong><span>PDF · 1페이지</span></p></div>' +
    '<div class="actions"><a class="button-link subtle-link" href="/' +
    h(material.file) +
    '" download>문제지 PDF 다운로드</a>' +
    (assignmentHref
      ? '<a class="workspace-link" href="' +
        h(assignmentHref) +
        '">' +
        h(assignmentAction) +
        '</a>'
      : '') +
    '</div></section>'
  );
}
