import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CodeExplanation } from '../api/types';

/** Plan + per-line notes for `source`, refreshed shortly after the code stops changing. */
export function useCodeExplanation(source: string, level: 'kid' | 'standard'): CodeExplanation | null {
  const [result, setResult] = useState<CodeExplanation | null>(null);
  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      api
        .explainCode(source, level)
        .then((r) => alive && setResult(r))
        .catch(() => alive && setResult(null));
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [source, level]);
  return result;
}
