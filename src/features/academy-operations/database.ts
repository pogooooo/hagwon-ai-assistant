import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type { SQLInputValue };

export interface OperationsDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): { changes: number | bigint };
  };
  transactionSync?<T>(write: () => T): T;
}
