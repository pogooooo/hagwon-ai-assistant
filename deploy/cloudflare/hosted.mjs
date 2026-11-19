import { readFileSync } from 'node:fs';
import { handleAsNodeRequest } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import { createExternalServices } from '../../src/features/academy-operations/external-services.ts';
import { createOperationsServer } from '../../src/features/academy-operations/application.ts';
import {
  configureOperationsGeneration,
  createOperationsGeneration,
  createOperationsScanVision,
} from '../../src/features/academy-operations/runtime-generation.ts';
import { configurePdfRuntime } from '../../src/features/rag-consultation/server/ingest/parsers/pdf.ts';
import { runParentMessageJobs } from '../../src/features/academy-operations/parent-messages-model.ts';
import { gradingService } from '../../src/features/homework-grading/module.ts';

import { configureGradingMedia } from '../../src/features/homework-grading/media.ts';
import { workerGradingMedia } from './grading-media.mjs';

configureGradingMedia(workerGradingMedia);

const fixtureRoot = '/bundle/academies/';

configurePdfRuntime(async () => {
  const library = await import('pdfjs-dist/build/pdf.mjs');
  const { WorkerMessageHandler } =
    await import('pdfjs-dist/build/pdf.worker.mjs');
  globalThis.pdfjsWorker = { WorkerMessageHandler };
  return {
    library,
    options: {
      cMapUrl: '/bundle/cmaps/',
      standardFontDataUrl: '/bundle/standard_fonts/',
      useWorkerFetch: false,
      useWasm: false,
      BinaryDataFactory: class {
        constructor(paths) {
          this.paths = paths;
        }
        async fetch({ kind, filename }) {
          if (
            !['cMapUrl', 'standardFontDataUrl'].includes(kind) ||
            !/^[\w.-]+$/.test(filename) ||
            filename === '..'
          ) {
            throw new Error('Unsupported PDF resource');
          }
          return new Uint8Array(readFileSync(this.paths[kind] + filename));
        }
      },
    },
  };
});

function database(storage) {
  return {
    exec: (query) => storage.sql.exec(query).toArray(),
    transactionSync: (write) => storage.transactionSync(write),
    prepare(query) {
      const select = (...params) => storage.sql.exec(query, ...params);
      return {
        all: (...params) => select(...params).toArray(),
        get: (...params) => select(...params).next().value,
        run(...params) {
          const cursor = select(...params);
          cursor.toArray();
          return { changes: cursor.rowsWritten };
        },
      };
    },
  };
}

export class AcademyDemo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.messageStorage = ctx.storage;
    this.parentMessageDb = database(ctx.storage);
    if (!env.AXR_HOSTED_DEMO_PASSWORD) throw new Error('Missing demo password');
    configureOperationsGeneration(
      createOperationsGeneration(env, fetch, database(ctx.storage)),
    );
    const server = createOperationsServer({
      services: createExternalServices(env, fetch, database(ctx.storage)),
      scanVision: createOperationsScanVision(env, fetch, database(ctx.storage)),
      scanPdfAvailable: false,
      db: database(ctx.storage),
      publicOrigin: new URL(env.AXR_OPERATIONS_PUBLIC_ORIGIN),
      demoPassword: env.AXR_HOSTED_DEMO_PASSWORD,
      showDemoAccounts: true,
      assetsRoot: null,
      fixturesRoot: new URL('file://' + fixtureRoot + 'AC_TEST_A/'),
      documentsRoot: fixtureRoot,
      maxDocumentBytes: 5 * 1024 * 1024,
    });
    server.listen(0);
    this.port = server.address().port;
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null)
        await ctx.storage.setAlarm(Date.now() + 60000);
    });
  }

  async fetch(request) {
    const alarm = await this.messageStorage.getAlarm();
    if (alarm === null || alarm > Date.now() + 60000)
      await this.messageStorage.setAlarm(Date.now() + 60000);
    return handleAsNodeRequest(this.port, request);
  }
  async alarm() {
    try {
      await gradingService(this.parentMessageDb).sweep();
      runParentMessageJobs(this.parentMessageDb);
    } finally {
      const active = this.parentMessageDb
        .prepare(
          "SELECT academy_id FROM op_parent_policies WHERE enabled=1 UNION ALL SELECT academy_id FROM op_parent_messages WHERE state='queued' UNION ALL SELECT tenant FROM grading_v3_submissions WHERE raw_state<>'VERIFIED' LIMIT 1",
        )
        .get();
      await this.messageStorage.setAlarm(
        Date.now() + (active ? 60000 : 3600000),
      );
    }
  }
}

const worker = {
  fetch(request, env) {
    if (new URL(request.url).origin !== env.AXR_OPERATIONS_PUBLIC_ORIGIN) {
      return new Response('주소를 확인해 주세요.', { status: 404 });
    }
    return env.ACADEMY.getByName('academy-demo').fetch(request);
  },
};

export default worker;
