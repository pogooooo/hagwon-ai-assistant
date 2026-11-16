import type { OperationsDatabase, SQLInputValue } from './database.ts';

export type Role = 'admin' | 'teacher' | 'student' | 'guardian' | 'visitor';

export interface Actor {
  id: string;
  academyId: string;
  username: string;
  name: string;
  role: Role;
  studentId: string | null;
}

export interface PageContext {
  db: OperationsDatabase;
  actor: Actor;
  url: URL;
  maxDocumentBytes?: number;
  assertCurrentAccess?: () => void;
}

export interface OperationModule {
  path: string;
  label: string;
  roles: readonly Role[];
  setup(db: OperationsDatabase, documentsRoot?: string): void;
  render(ctx: PageContext): string | Promise<string>;
  submit(
    ctx: PageContext,
    data: FormData,
  ): void | string | Promise<void | string>;
}

export const roleLabels: Record<Role, string> = {
  admin: '관리자',
  teacher: '강사',
  student: '학생',
  guardian: '보호자',
  visitor: '방문자',
};

export class OperationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const htmlCharacters: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) => htmlCharacters[character],
  );
}

export function field(form: FormData, name: string, max = 500): string {
  const value = form.get(name);
  if (value === null) return '';
  if (typeof value !== 'string' || value.length > max) {
    throw new OperationError('입력한 값의 형식이나 길이를 확인해 주세요.');
  }
  return value.trim();
}

export function required(
  form: FormData,
  name: string,
  label: string,
  max?: number,
): string {
  const value = field(form, name, max);
  if (!value) throw new OperationError(label + ' 항목을 입력해 주세요.');
  return value;
}

export function rows<T>(
  db: OperationsDatabase,
  sql: string,
  ...params: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(
  db: OperationsDatabase,
  sql: string,
  ...params: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function transaction<T>(db: OperationsDatabase, write: () => T): T {
  if (db.transactionSync) return db.transactionSync(write);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
