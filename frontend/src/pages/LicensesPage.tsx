import { Link } from 'react-router-dom';
import { useLanguage } from '../i18n';
import licenses from '../licenses.json';

interface LicenseRow {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  side: 'frontend' | 'backend' | 'both';
}

const rows = licenses as LicenseRow[];

/** Open-source dependencies with their licenses, plus data-provider attributions. */
export function LicensesPage() {
  const { t } = useLanguage();

  return (
    <div className="list-page">
      <div className="list-page-content">
        <div className="list-page-header">
          <Link to="/" className="list-page-back">{t.back}</Link>
          <h1>{t.licensesTitle}</h1>
        </div>

        <div className="licenses-attribution">
          <h2>{t.licensesDataProviders}</h2>
          <p>
            Streaming data by{' '}
            <a href="https://www.watchmode.com/" target="_blank" rel="noopener noreferrer">Watchmode</a>
            {' · '}
            Film metadata by{' '}
            <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">TMDb</a>
            {' '}(this product uses the TMDB API but is not endorsed or certified by TMDB)
          </p>
        </div>

        <h2 className="licenses-section-title">{t.licensesOssTitle} ({rows.length})</h2>
        <div className="licenses-table-wrap">
          <table className="licenses-table">
            <thead>
              <tr>
                <th>{t.licensesPackage}</th>
                <th>{t.licensesVersion}</th>
                <th>{t.licensesLicense}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.name}@${row.version}`}>
                  <td>
                    {row.repository ? (
                      <a href={row.repository} target="_blank" rel="noopener noreferrer">{row.name}</a>
                    ) : (
                      row.name
                    )}
                  </td>
                  <td className="list-item-muted">{row.version}</td>
                  <td>{row.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
