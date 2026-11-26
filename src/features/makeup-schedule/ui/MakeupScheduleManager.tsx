'use client';

import { useSyncExternalStore } from 'react';

import { DEMO_ACADEMY } from '../model/demo-academy.ts';
import { useScheduleStore } from '../store.ts';
import { EventForm } from './EventForm.tsx';
import { EventList } from './EventList.tsx';
import {
  OutboxPanel,
  RagPreviewPanel,
  StudentSchedulePanel,
} from './Panels.tsx';
import { Badge, Button, Grid, Header, Inner, Page, Stack } from './styles.ts';

const noopSubscribe = () => () => {};

/** 기능 13 휴·보강 일정 관리(원장 화면). ⚠️ 가상 데이터 */
export function MakeupScheduleManager() {
  const academy = DEMO_ACADEMY;
  const { schedule, apply, reset, loadExample } = useScheduleStore();
  // 정적 빌드: 브라우저 저장값을 읽은 뒤에 그린다(서버 HTML 과 불일치 방지)
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  return (
    <Page>
      <Inner>
        <Header>
          <div>
            <h1>휴·보강 일정 관리</h1>
            <p>
              {academy.name} · 확정한 일정은 안내문과 상담봇 답변에 같은 값으로
              쓰입니다.
            </p>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Badge $tone="warn">가상 데이터</Badge>
            <Button type="button" onClick={loadExample}>
              예시 일정 불러오기
            </Button>
            <Button
              type="button"
              $variant="danger"
              onClick={() => {
                if (
                  window.confirm('이 브라우저에 저장된 일정을 모두 지울까요?')
                )
                  reset();
              }}
            >
              초기화
            </Button>
          </div>
        </Header>
        {mounted && (
          <Grid>
            <Stack>
              <EventForm academy={academy} schedule={schedule} apply={apply} />
              <StudentSchedulePanel
                academy={academy}
                schedule={schedule}
                defaultFrom="2026-11-09"
              />
            </Stack>
            <Stack>
              <EventList academy={academy} schedule={schedule} apply={apply} />
              <OutboxPanel academy={academy} schedule={schedule} />
              <RagPreviewPanel academy={academy} schedule={schedule} />
            </Stack>
          </Grid>
        )}
      </Inner>
    </Page>
  );
}
