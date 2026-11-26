/**
 * 웹/Capacitor 공용 상담 API 클라이언트.
 * - RAG 검색·권한·모델은 서버에만 있다. 클라이언트에는 키·인덱스·다른 학생 자료가 없다.
 * - 인증은 기존 앱의 규칙(쿠키 또는 Authorization 헤더)을 따른다.
 */
import axios, { type AxiosInstance } from 'axios';

import type { RagAnswer, RagQueryRequest } from '../contract.ts';

export interface RagClientOptions {
  /** 예: https://api.example.com/api/rag (NEXT_PUBLIC_ 값에는 비밀을 넣지 않는다) */
  baseUrl: string;
  /** 기존 인증 규칙에 맞는 헤더(예: Authorization). 쿠키 세션이면 생략하고 withCredentials 사용. */
  getAuthHeaders?: () =>
    Promise<Record<string, string>> | Record<string, string>;
  withCredentials?: boolean;
  timeoutMs?: number;
  http?: AxiosInstance;
}

export function createRagClient(options: RagClientOptions) {
  const http =
    options.http ??
    axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      timeout: options.timeoutMs ?? 15_000,
      withCredentials: options.withCredentials ?? false,
    });

  return {
    async ask(request: RagQueryRequest): Promise<RagAnswer> {
      const headers = {
        'content-type': 'application/json',
        ...(await options.getAuthHeaders?.()),
      };
      const response = await http.post<RagAnswer>('/query', request, {
        headers,
      });
      return response.data;
    },
  };
}
