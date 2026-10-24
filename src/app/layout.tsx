import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import StyledComponentsRegistry from '@/lib/styled-components-registry';

import './globals.css';

export const metadata: Metadata = {
  title: 'AXR Prototype',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <StyledComponentsRegistry>{children}</StyledComponentsRegistry>
      </body>
    </html>
  );
}
