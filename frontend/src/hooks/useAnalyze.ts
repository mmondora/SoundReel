import { useState, useCallback } from 'react';
import { analyzeUrl as callAnalyzeApi } from '../services/api';

export type SuccessStatus = 'existing' | 'completed' | null;

export function useAnalyze() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successStatus, setSuccessStatus] = useState<SuccessStatus>(null);

  const analyze = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);
    setSuccessStatus(null);

    try {
      const response = await callAnalyzeApi(url);
      if (!response.success) {
        throw new Error(response.error || 'GENERIC_ERROR');
      }

      // Set success status code
      if (response.existing) {
        setSuccessStatus('existing');
      } else {
        setSuccessStatus('completed');
      }

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessStatus(null), 3000);

      return response.entryId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GENERIC_ERROR';
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const clearSuccess = useCallback(() => {
    setSuccessStatus(null);
  }, []);

  return { analyze, loading, error, successStatus, clearError, clearSuccess };
}
