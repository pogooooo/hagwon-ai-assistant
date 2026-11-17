import { z } from 'zod';
import {
  SUPERVISOR_TIMEOUT_MS,
  type SupervisorSelector,
  type SupervisorTool,
} from '../service.ts';
import type { ClovaApi } from '../generation/clova-api.ts';

export const supervisorTools = {
  schedule: '수업 일정·휴강·보강 조회',
  tuition_timetable: '수강료·교재비·시간표 조회',
  documents: '학원 공지·시설·운영 규정 등 문서 조회',
  learning: '권한이 있는 원생의 확정 학습 분석 조회',
  handoff: '원장 또는 담당자에게 연결',
} as const;

const toolArguments = z.strictObject({
  classId: z.string().optional(),
  studentId: z.string().optional(),
});
const resultSchema = z.object({
  message: z.object({
    toolCalls: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.enum(Object.keys(supervisorTools) as SupervisorTool[]),
            arguments: z.union([
              toolArguments,
              z.string().transform((value, ctx) => {
                try {
                  return toolArguments.parse(JSON.parse(value));
                } catch {
                  ctx.addIssue({
                    code: 'custom',
                    message: 'Invalid tool arguments',
                  });
                  return z.NEVER;
                }
              }),
            ]),
          }),
        }),
      )
      .length(1),
  }),
});

export function selectClovaTool(
  api: ClovaApi,
  record: (tool: SupervisorTool) => void,
  timeoutMs = SUPERVISOR_TIMEOUT_MS,
): SupervisorSelector {
  const deadline = performance.now() + timeoutMs;
  let remaining = 4;
  return async (ctx) => {
    const timeLeft = Math.ceil(deadline - performance.now());
    if (remaining-- <= 0 || timeLeft <= 0) return 'handoff';
    const { catalog, access, frame } = ctx;
    const classes = catalog.classes
      .filter(
        ({ classId }) =>
          access.allowedClassIds.includes(classId) &&
          [...frame.classIds, ...ctx.studentClassIds].includes(classId) &&
          !frame.negatedClassIds.includes(classId),
      )
      .map(({ classId, name }) => ({ classId, name }));
    const students = access.studentRefs
      .filter(
        ({ studentId }) =>
          access.allowedStudentIds.includes(studentId) &&
          frame.matchedStudentIds.includes(studentId),
      )
      .map(({ studentId, displayLabel }) => ({ studentId, displayLabel }));
    const ids = {
      ...(classes.length
        ? {
            classId: {
              type: 'string',
              enum: classes.map(({ classId }) => classId),
            },
          }
        : {}),
      ...(students.length
        ? {
            studentId: {
              type: 'string',
              enum: students.map(({ studentId }) => studentId),
            },
          }
        : {}),
    };
    try {
      const result = resultSchema.parse(
        await api.post(
          '/v3/chat-completions/HCX-007',
          {
            messages: [
              {
                role: 'system',
                content:
                  '상담 질문의 담당 도구 하나만 호출하라. 답이나 값을 생성하지 말고, 질문에서 명확한 대상만 등록된 ID로 지정하라. 해석이 불가능하면 handoff를 호출하라.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  question: ctx.question,
                  classes,
                  students,
                }),
              },
            ],
            tools: Object.entries(supervisorTools).map(
              ([name, description]) => ({
                type: 'function',
                function: {
                  name,
                  description,
                  parameters: {
                    type: 'object',
                    properties: name === 'handoff' ? {} : ids,
                    additionalProperties: false,
                  },
                },
              }),
            ),
            toolChoice: 'auto',
            maxCompletionTokens: 1024,
          },
          AbortSignal.timeout(timeLeft),
        ),
      );
      const { name, arguments: args } = result.message.toolCalls[0].function;
      if (
        performance.now() > deadline ||
        (args.classId &&
          !classes.some(({ classId }) => classId === args.classId)) ||
        (args.studentId &&
          !students.some(({ studentId }) => studentId === args.studentId)) ||
        (name === 'handoff' &&
          (args.classId !== undefined || args.studentId !== undefined))
      ) {
        return 'handoff';
      }
      if (args.classId === '' || args.studentId === '') return 'handoff';
      record(name);
      return name;
    } catch {
      return 'handoff';
    }
  };
}
