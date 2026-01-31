import { useState, useCallback } from 'react';
import { analyzeUrl as callAnalyzeApi } from '../services/api';

export function useAnalyze() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const analyze = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await callAnalyzeApi(url);
      if (!response.success) {
        throw new Error(response.error || 'Errore sconosciuto');
      }

      // Show success message
      if (response.existing) {
        setSuccess('URL già analizzato in precedenza');
      } else {
        setSuccess('Analisi completata!');
      }

      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(null), 3000);

      return response.entryId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Errore durante l\'analisi';
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
    setSuccess(null);
  }, []);

  return { analyze, loading, error, success, clearError, clearSuccess };
}
