import type { Metadata } from 'next';

import { MakeupScheduleManager } from '@/features/makeup-schedule/ui/MakeupScheduleManager.tsx';

export const metadata: Metadata = {
  title: '휴·보강 일정 관리',
};

export default function MakeupSchedulePage() {
  return <MakeupScheduleManager />;
}
