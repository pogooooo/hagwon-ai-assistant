/**
 * 테스트용 가상 교습소. ⚠️ 모든 학원·반·원생은 가상 데이터다.
 * ID 는 RAG 평가 자료 `academies/AC_TEST_A/`(academy.json, students.json)와 같다.
 */
import type { AcademyConfig } from './types.ts';

export const DEMO_ACADEMY: AcademyConfig = {
  academyId: 'AC_TEST_A',
  name: '[가상] 테스트 교습소',
  capacity: 9,
  closeTime: '22:00',
  rooms: ['교실1'],
  holidays: { '2026-12-25': '성탄절', '2027-01-01': '신정' },
  classes: [
    {
      classId: 'TA_E_MATH',
      name: '초등 수학반',
      days: [1, 3],
      start: '16:00',
      end: '17:20',
      teacher: '원장',
      room: '교실1',
    },
    {
      classId: 'TA_M2_EXAM',
      name: '중2 내신반',
      days: [1, 3],
      start: '18:00',
      end: '19:50',
      teacher: '원장',
      room: '교실1',
    },
    {
      classId: 'TA_M3',
      name: '중3반',
      days: [2, 4],
      start: '18:00',
      end: '19:50',
      teacher: '원장',
      room: '교실1',
    },
    {
      classId: 'TA_H1',
      name: '고1반',
      days: [2, 4],
      start: '20:00',
      end: '21:50',
      teacher: '원장',
      room: '교실1',
    },
  ],
  students: [
    { studentId: 'TA_STU_001', name: '가상학생A', classIds: ['TA_E_MATH'] },
    { studentId: 'TA_STU_002', name: '가상학생B', classIds: ['TA_M2_EXAM'] },
    { studentId: 'TA_STU_003', name: '가상학생C', classIds: ['TA_M3'] },
    { studentId: 'TA_STU_004', name: '가상학생D', classIds: ['TA_H1'] },
    // 아래는 화면 시연용(보강 가능 시간 비교). RAG 평가 자료 students.json 에는 없다.
    { studentId: 'TA_STU_005', name: '가상학생E', classIds: ['TA_M2_EXAM'] },
    { studentId: 'TA_STU_006', name: '가상학생F', classIds: ['TA_M2_EXAM'] },
    { studentId: 'TA_STU_007', name: '가상학생G', classIds: ['TA_M3'] },
  ],
};
