import type { ScheduleState } from '../makeup-schedule/model/types.ts';
import type { OperationsDatabase } from './database.ts';

export function saveTeamSchedule(
  db: OperationsDatabase,
  academy: string,
  version: number,
  author: string,
  config: unknown,
  state: ScheduleState,
  now: string,
) {
  db.prepare(
    'INSERT INTO op_team_schedule VALUES (?, ?, ?, ?) ON CONFLICT(academy_id) DO UPDATE SET version=excluded.version, config=excluded.config, state=excluded.state',
  ).run(academy, version, JSON.stringify(config), JSON.stringify(state));
  db.prepare('INSERT INTO op_team_schedule_history VALUES (?, ?, ?, ?, ?)').run(
    academy,
    version,
    author,
    JSON.stringify({ config, state }),
    now,
  );
}
