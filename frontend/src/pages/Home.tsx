import { Header } from '../components/Header';
import { UrlInput } from '../components/UrlInput';
import { Journal } from '../components/Journal';
import { useJournal } from '../hooks/useJournal';
import { useAnalyze } from '../hooks/useAnalyze';

export function Home() {
  const { entries, stats, loading: journalLoading } = useJournal();
  const { analyze, loading: analyzeLoading, error, success, clearError } = useAnalyze();

  const handleSubmit = async (url: string) => {
    clearError();
    await analyze(url);
  };

  return (
    <div className="home">
      <Header stats={stats} />
      <main className="main-content">
        <UrlInput
          onSubmit={handleSubmit}
          loading={analyzeLoading}
          error={error}
          success={success}
        />
        <Journal entries={entries} loading={journalLoading} />
      </main>
    </div>
  );
}
