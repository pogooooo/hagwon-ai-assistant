import type { OperationsDatabase } from './database.ts';
import { runParentMessageJobs } from './parent-messages-model.ts';

/** Server-owned timer; tests invoke the same durable job with a fixed clock. */
export function startParentMessageScheduler(db: OperationsDatabase) {
  const tick = () => {
    try {
      runParentMessageJobs(db);
    } catch {
      console.error(
        'AXR parent message schedule could not complete; next tick will retry.',
      );
    }
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
