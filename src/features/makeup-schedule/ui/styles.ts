'use client';

import styled, { css } from 'styled-components';

export const colors = {
  bg: '#f6f7f9',
  card: '#ffffff',
  line: '#e3e6eb',
  text: '#1f2328',
  muted: '#667085',
  primary: '#2f6fed',
  primarySoft: '#e8f0fe',
  danger: '#c62828',
  dangerSoft: '#fdecea',
  warn: '#a15c00',
  warnSoft: '#fff4e0',
  ok: '#1b7f3b',
  okSoft: '#e6f4ea',
};

export const Page = styled.main`
  min-height: 100vh;
  background: ${colors.bg};
  color: ${colors.text};
  padding: 20px 16px 48px;
  font-family:
    'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
`;

export const Inner = styled.div`
  max-width: 1100px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
`;

export const Header = styled.header`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  h1 {
    font-size: 20px;
    margin: 0;
  }
  p {
    margin: 2px 0 0;
    color: ${colors.muted};
  }
`;

export const Grid = styled.div`
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(0, 1fr);

  @media (min-width: 900px) {
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  }
`;

export const Card = styled.section`
  background: ${colors.card};
  border: 1px solid ${colors.line};
  border-radius: 12px;
  padding: 16px;
  min-width: 0;

  h2 {
    font-size: 16px;
    margin: 0 0 12px;
  }
`;

export const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-end;
  margin-bottom: 10px;
`;

export const Field = styled.label`
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: ${colors.muted};
  flex: 1 1 140px;
  min-width: 0;

  input,
  select {
    font: inherit;
    font-size: 14px;
    color: ${colors.text};
    padding: 7px 8px;
    border: 1px solid ${colors.line};
    border-radius: 8px;
    background: #fff;
    min-width: 0;
  }
`;

export const Button = styled.button<{
  $variant?: 'primary' | 'ghost' | 'danger';
}>`
  font: inherit;
  font-size: 13px;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid ${colors.line};
  background: #fff;
  color: ${colors.text};
  cursor: pointer;
  white-space: nowrap;

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  ${({ $variant }) =>
    $variant === 'primary' &&
    css`
      background: ${colors.primary};
      border-color: ${colors.primary};
      color: #fff;
    `}
  ${({ $variant }) =>
    $variant === 'danger' &&
    css`
      color: ${colors.danger};
      border-color: ${colors.dangerSoft};
    `}
`;

export const Segmented = styled.div`
  display: inline-flex;
  border: 1px solid ${colors.line};
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 12px;

  button {
    font: inherit;
    font-size: 13px;
    border: 0;
    padding: 7px 14px;
    background: #fff;
    cursor: pointer;
  }
  button[aria-pressed='true'] {
    background: ${colors.primarySoft};
    color: ${colors.primary};
    font-weight: 600;
  }
`;

export const Badge = styled.span<{
  $tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted';
}>`
  display: inline-block;
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  ${({ $tone = 'muted' }) => {
    const map = {
      ok: [colors.okSoft, colors.ok],
      warn: [colors.warnSoft, colors.warn],
      danger: [colors.dangerSoft, colors.danger],
      info: [colors.primarySoft, colors.primary],
      muted: ['#eef0f3', colors.muted],
    } as const;
    const [bg, fg] = map[$tone];
    return css`
      background: ${bg};
      color: ${fg};
    `;
  }}
`;

export const IssueList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0 0 10px;
  display: grid;
  gap: 4px;

  li {
    padding: 6px 8px;
    border-radius: 8px;
    font-size: 13px;
  }
  li[data-blocking='true'] {
    background: ${colors.dangerSoft};
    color: ${colors.danger};
  }
  li[data-blocking='false'] {
    background: ${colors.warnSoft};
    color: ${colors.warn};
  }
  li[data-ok='true'] {
    background: ${colors.okSoft};
    color: ${colors.ok};
  }
`;

export const Muted = styled.p`
  color: ${colors.muted};
  margin: 0 0 8px;
  font-size: 13px;
`;

export const TableWrap = styled.div`
  overflow-x: auto;
`;

export const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    text-align: left;
    padding: 7px 6px;
    border-bottom: 1px solid ${colors.line};
    white-space: nowrap;
  }
  th {
    color: ${colors.muted};
    font-weight: 500;
  }
`;

export const Stack = styled.div`
  display: grid;
  gap: 10px;
`;

export const Item = styled.article`
  border: 1px solid ${colors.line};
  border-radius: 10px;
  padding: 10px 12px;
  display: grid;
  gap: 6px;

  .title {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-weight: 600;
  }
  .meta {
    color: ${colors.muted};
    font-size: 13px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
`;

export const Pre = styled.pre`
  margin: 0;
  white-space: pre-wrap;
  word-break: keep-all;
  font: inherit;
  font-size: 13px;
  background: ${colors.bg};
  border-radius: 8px;
  padding: 8px 10px;
`;

export const Message = styled.p<{ $tone: 'ok' | 'danger' }>`
  margin: 0 0 10px;
  font-size: 13px;
  color: ${({ $tone }) => ($tone === 'ok' ? colors.ok : colors.danger)};
`;
