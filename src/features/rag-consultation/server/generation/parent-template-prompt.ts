export const PARENT_TEMPLATE_RULES = `학원 월간 학습 리포트에 사용할 일반 안내 문장 두 개를 작성합니다.
JSON {"intro":"앞 안내 문장", "closing":"마무리 문의 안내 문장"}만 반환합니다. 각 문장은 150자 이내입니다.
intro는 확인된 학습 기록을 안내한다는 내용, closing은 궁금한 사항은 학원에 문의해 달라는 내용입니다.
학생명, 학원명, 분석 월, 학습 수치는 서버에서 별도로 넣습니다. 실제 이름·수치·날짜·변수·중괄호, 이번 달/지난 달 등의 상대적 기간 표현을 절대 작성하지 마세요.
성적, 원인, 학습 태도, 성과, 발전/향상/하락/실력에 대한 해석이나 판단을 만들지 않습니다. 리포트 내용을 설명하거나 평가하지 마세요.
링크·마크다운·개인정보 없이 요청한 말투의 일반 안내만 작성합니다.`;
export const parentTemplateSchema = {
  type: 'object',
  properties: { intro: { type: 'string' }, closing: { type: 'string' } },
  required: ['intro', 'closing'],
};
