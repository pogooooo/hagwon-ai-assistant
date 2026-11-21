import { roleLabels, type Role } from './shared.ts';

function isAcceptanceAcademy(academyId: string) {
  return academyId === 'AC_TEST_A' || academyId === 'AC_ONDAP_LANGUAGE_DEMO';
}

export function accountDisplayName(
  academyId: string,
  name: string,
  role: Role,
) {
  if (!isAcceptanceAcademy(academyId) || name !== '브라우저 검증 ' + role)
    return name;
  return role === 'admin'
    ? '원장'
    : role === 'guardian'
      ? '학부모'
      : roleLabels[role];
}

export function isAcceptanceRecord(academyId: string, title: string) {
  return (
    isAcceptanceAcademy(academyId) &&
    /^(?:\[가상 검증 전용\]|\[체험 검증\]|가상 검증\s)|가상 일정 확인입니다\.$/.test(
      title,
    )
  );
}
