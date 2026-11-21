import type { OperationsDatabase } from './database.ts';
import { rows, transaction } from './shared.ts';

const academyId = 'AC_ONDAP_LANGUAGE_DEMO';

// Provision only the second, synthetic academy. Never recreate a removed membership at startup.
export function seedAcademyChoices(db: OperationsDatabase) {
  if (db.prepare('SELECT 1 FROM academies WHERE id=?').get(academyId)) return;
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM academies WHERE id=?').get(academyId)) return;
    if (
      !db
        .prepare('SELECT 1 FROM academies WHERE id=? AND name=?')
        .get('AC_TEST_A', '[가상] 테스트 교습소')
    )
      return;
    db.prepare('INSERT INTO academies(id,name) VALUES (?,?)').run(
      academyId,
      '[가상] 온답 어학원',
    );
    const classroom = 'ONDAP_DEMO_ENGLISH',
      student = 'ONDAP_DEMO_LEARNER';
    db.prepare(
      'INSERT INTO classes(id,academy_id,name,subject,grade) VALUES (?,?,?,?,?)',
    ).run(classroom, academyId, '영어 회화반', '영어', '중등');
    db.prepare(
      'INSERT INTO students(id,academy_id,class_id,name) VALUES (?,?,?,?)',
    ).run(student, academyId, classroom, '가상 원생');
    const notice = {
      academyId,
      documentId: 'ONDAP_LANGUAGE_HOURS',
      revision: 1,
      documentType: 'academy_info',
      visibility: 'academy_public',
      title: '온답 어학원 운영시간 안내',
      text: '온답 어학원 운영시간은 평일 오후 2시부터 오후 9시까지입니다.',
      validFrom: '2026-01-01T00:00:00+09:00',
      approvedAt: '2026-01-01T00:00:00+09:00',
    };
    db.prepare(
      "INSERT INTO op_document_versions(academy_id,document_id,revision,input,state) VALUES (?,?,1,?,'published')",
    ).run(academyId, notice.documentId, JSON.stringify(notice));
    // The hosted acceptance accounts also belong to this synthetic roster. Bind their
    // immutable account IDs once, when creating the empty demo academy.
    const qa = rows<{ id: string; role: string }>(
      db,
      `SELECT id,role FROM accounts WHERE academy_id='AC_TEST_A'
      AND ((username='AXR_CHECK_ADMIN_20261119' AND role='admin')
        OR (username='AXR_CHECK_TEACHER_20261119' AND role='teacher')
        OR (username='AXR_CHECK_STUDENT_20261119' AND role='student')
        OR (username='AXR_CHECK_GUARDIAN_20261119' AND role='guardian'))`,
    );
    const qaStudent = 'ONDAP_DEMO_QA_LEARNER';
    if (qa.length)
      db.prepare(
        'INSERT INTO students(id,academy_id,class_id,name) VALUES (?,?,?,?)',
      ).run(qaStudent, academyId, classroom, '체험 원생');
    for (const [source, role, learner] of [
      ['TA_DIRECTOR', 'admin', student],
      ['TA_TEACHER', 'teacher', student],
      ['TA_STUDENT_001', 'student', student],
      ['TA_GUARDIAN_E_MATH', 'guardian', student],
      ...qa.map((p) => [p.id, p.role, qaStudent]),
    ]) {
      const profile = 'ONDAP_LANGUAGE_' + source;
      // Non-login profiles keep each academy's own class, child and permission records.
      const created = db
        .prepare(
          `INSERT INTO accounts(id,academy_id,username,name,role,student_id,password_hash)
        SELECT ?,?,?,name,role,?,'!' FROM accounts WHERE id=? AND academy_id='AC_TEST_A' AND role=?`,
        )
        .run(
          profile,
          academyId,
          profile,
          role === 'student' ? learner : null,
          source,
          role,
        );
      if (!created.changes) continue;
      db.prepare(
        'INSERT INTO op_academy_memberships(login_id,profile_id) VALUES (?,?)',
      ).run(source, profile);
      if (role === 'teacher')
        db.prepare(
          'INSERT INTO teacher_classes(teacher_id,class_id) VALUES (?,?)',
        ).run(profile, classroom);
      if (role === 'guardian')
        db.prepare(
          'INSERT INTO guardian_students(guardian_id,student_id) VALUES (?,?)',
        ).run(profile, learner);
    }
  });
}

/** Add the public program guide to existing demos as well as fresh installs. */
export function seedDemoConsultationGuides(db: OperationsDatabase) {
  const course = db
    .prepare(
      `SELECT c.name FROM classes c JOIN academies a ON a.id=c.academy_id
    WHERE c.id='ONDAP_DEMO_ENGLISH' AND a.id=? AND a.name='[가상] 온답 어학원'
      AND c.name='영어 회화반' AND c.grade='중등'`,
    )
    .get(academyId);
  if (!course) return;
  const guides = [
    {
      documentId: 'ONDAP_LANGUAGE_COURSES',
      documentType: 'academy_info',
      title: '온답 어학원 정규 수업 안내',
      text: '## 교육 대상 및 개설 과목\n\n| 과목 | 개설 반 | 수강 대상 |\n| --- | --- | --- |\n| 영어 | 영어 회화반 | 중학생 |',
    },
    {
      documentId: 'ONDAP_LANGUAGE_FEES',
      documentType: 'fee',
      title: '영어 회화반 수강료',
      text: '# 영어 회화반 월 수강료\n\n| 반 | 월 수강료 |\n| --- | --- |\n| 영어 회화반 | 210,000원 |',
    },
    {
      documentId: 'ONDAP_LANGUAGE_TIMETABLE',
      documentType: 'schedule',
      title: '영어 회화반 정규 시간표',
      text: '# 영어 회화반 정규 시간표\n\n| 반 | 요일 | 수업 시간 |\n| --- | --- | --- |\n| 영어 회화반 | 화요일·목요일 | 17:00~18:20 |',
    },
    {
      documentId: 'ONDAP_LANGUAGE_VISIT',
      documentType: 'academy_info',
      title: '온답 어학원 방문과 상담 안내',
      text: '# 학원 위치\n\n학원 주소는 가상시 온답구 배움로 24, 온답센터 2층입니다.\n\n## 주차\n\n온답센터는 방문자 주차장을 운영하지 않습니다.\n\n## 상담 신청 방법\n\n상담 예약은 앱의 일정·예약 메뉴에서 희망 시간대를 선택하여 신청합니다.',
    },
  ];
  const add = db.prepare(
    `INSERT INTO op_document_versions(academy_id,document_id,revision,input,state)
    SELECT ?,?,1,?,'published' WHERE NOT EXISTS
    (SELECT 1 FROM op_document_versions WHERE academy_id=? AND document_id=?)`,
  );
  transaction(db, () => {
    for (const guide of guides) {
      const input = {
        ...guide,
        academyId,
        revision: 1,
        visibility: 'academy_public',
        validFrom: '2026-01-01T00:00:00+09:00',
        approvedAt: '2026-01-01T00:00:00+09:00',
      };
      add.run(
        academyId,
        guide.documentId,
        JSON.stringify(input),
        academyId,
        guide.documentId,
      );
    }
  });
}
