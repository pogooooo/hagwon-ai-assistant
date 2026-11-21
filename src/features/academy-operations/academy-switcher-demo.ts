import type { OperationsDatabase } from './database.ts';
import { transaction } from './shared.ts';

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
    for (const [source, role] of [
      ['TA_DIRECTOR', 'admin'],
      ['TA_TEACHER', 'teacher'],
      ['TA_STUDENT_001', 'student'],
      ['TA_GUARDIAN_E_MATH', 'guardian'],
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
          role === 'student' ? student : null,
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
        ).run(profile, student);
    }
  });
}
