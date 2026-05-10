import { useEffect, useState } from 'react';
import { Header } from '../components/Header';
import { useLanguage } from '../i18n';
import {
  getAdminStorage,
  adminPurge,
  getRetention,
  updateRetention,
  cleanupOrphans,
  StorageStats,
  RetentionConfig,
  PurgeFilter,
  PurgeDryRunResponse,
  PurgeExecuteResponse,
  CleanupResult,
} from '../services/api';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTs(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function Admin() {
  const { t: _t } = useLanguage();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [retention, setRetention] = useState<RetentionConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Purge form
  const [pPlatform, setPPlatform] = useState<string>('');
  const [pStatus, setPStatus] = useState<string>('');
  const [pOlder, setPOlder] = useState<string>('');
  const [pEmpty, setPEmpty] = useState<boolean>(false);
  const [preview, setPreview] = useState<PurgeDryRunResponse | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeResult, setPurgeResult] = useState<PurgeExecuteResponse | null>(null);

  // Retention form
  const [retDays, setRetDays] = useState<string>('');
  const [orphanDays, setOrphanDays] = useState<string>('7');
  const [retSaving, setRetSaving] = useState(false);
  const [retMsg, setRetMsg] = useState<string | null>(null);

  // Cleanup
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanResult, setCleanResult] = useState<CleanupResult | null>(null);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const [s, r] = await Promise.all([getAdminStorage(), getRetention()]);
      setStats(s);
      setRetention(r);
      setRetDays(r.retentionDays == null ? '' : String(r.retentionDays));
      setOrphanDays(String(r.orphanTtlDays));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const buildFilter = (): PurgeFilter => ({
    platform: pPlatform || null,
    status: pStatus || null,
    olderThanDays: pOlder === '' ? null : Number(pOlder),
    emptyResultsOnly: pEmpty,
  });

  const doPreview = async (): Promise<void> => {
    setPurgeBusy(true);
    setPreview(null);
    setPurgeResult(null);
    try {
      const res = (await adminPurge({ ...buildFilter(), dryRun: true })) as PurgeDryRunResponse;
      setPreview(res);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPurgeBusy(false);
    }
  };

  const doExecute = async (): Promise<void> => {
    if (!preview) return;
    const confirmed = window.confirm(`Eliminare DEFINITIVAMENTE ${preview.wouldDelete} entries e i loro file? Operazione irreversibile.`);
    if (!confirmed) return;
    setPurgeBusy(true);
    try {
      const res = (await adminPurge({ ...buildFilter(), confirm: 'YES' })) as PurgeExecuteResponse;
      setPurgeResult(res);
      setPreview(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPurgeBusy(false);
    }
  };

  const saveRetention = async (): Promise<void> => {
    setRetSaving(true);
    setRetMsg(null);
    try {
      const updated = await updateRetention({
        retentionDays: retDays === '' ? null : Number(retDays),
        orphanTtlDays: Number(orphanDays),
      });
      setRetention(updated);
      setRetMsg('Salvato');
    } catch (e) {
      setRetMsg('Errore: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRetSaving(false);
    }
  };

  const runCleanup = async (): Promise<void> => {
    setCleanBusy(true);
    setCleanResult(null);
    try {
      const r = await cleanupOrphans();
      setCleanResult(r);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCleanBusy(false);
    }
  };

  const journalStats = {
    totalEntries: stats?.totals.entries ?? 0,
    totalSongs: 0, totalFilms: 0, totalNotes: 0,
  };

  return (
    <div className="page">
      <Header stats={journalStats} />
      <main className="main-content" style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ marginTop: 0 }}>Admin / Storage</h1>
        {err && <div style={{ color: '#f87171', padding: 12, border: '1px solid #7f1d1d', borderRadius: 8, marginBottom: 16 }}>Errore: {err}</div>}
        {loading && <p>Caricamento…</p>}

        {stats && (
          <section style={{ marginBottom: 32 }}>
            <h2>Panoramica</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              <Card label="Entries" value={String(stats.totals.entries)} />
              <Card label="Dir media" value={String(stats.totals.mediaDirs)} />
              <Card label="File media" value={String(stats.totals.mediaFiles)} />
              <Card label="Storage" value={fmtBytes(stats.totals.mediaBytes)} />
              <Card label="Orphan dirs" value={`${stats.orphans.count} (${fmtBytes(stats.orphans.bytes)})`} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 20 }}>
              <Table title="Per piattaforma" rows={stats.byPlatform.map((r) => [r.platform, String(r.count)])} />
              <Table title="Per status" rows={stats.byStatus.map((r) => [r.status, String(r.count)])} />
              <Table title="Per età" rows={stats.byAge.map((r) => [r.label, String(r.count)])} />
            </div>

            <h3 style={{ marginTop: 24 }}>Top 20 entry per dimensione</h3>
            <div style={{ overflow: 'auto', border: '1px solid #334', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#1e293b' }}>
                    <th style={th}>Entry ID</th>
                    <th style={th}>Bytes</th>
                    <th style={th}>Files</th>
                    <th style={th}>Modificato</th>
                    <th style={th}>Orphan?</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topLargest.map((d) => (
                    <tr key={d.entryId} style={{ borderTop: '1px solid #334' }}>
                      <td style={td}><code>{d.entryId}</code></td>
                      <td style={td}>{fmtBytes(d.bytes)}</td>
                      <td style={td}>{d.files}</td>
                      <td style={td}>{fmtTs(d.mtime)}</td>
                      <td style={td}>{d.orphan ? 'SI' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section style={{ marginBottom: 32 }}>
          <h2>Purge (bulk delete)</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Platform">
              <select value={pPlatform} onChange={(e) => setPPlatform(e.target.value)} style={input}>
                <option value="">(any)</option>
                {stats?.byPlatform.map((p) => (<option key={p.platform} value={p.platform}>{p.platform} ({p.count})</option>))}
              </select>
            </Field>
            <Field label="Status">
              <select value={pStatus} onChange={(e) => setPStatus(e.target.value)} style={input}>
                <option value="">(any)</option>
                <option value="completed">completed</option>
                <option value="processing">processing</option>
                <option value="error">error</option>
              </select>
            </Field>
            <Field label="Più vecchi di (giorni)">
              <input type="number" min={0} value={pOlder} onChange={(e) => setPOlder(e.target.value)} style={input} placeholder="(nessun filtro)" />
            </Field>
            <Field label="Solo entries vuote (0 songs+films)">
              <input type="checkbox" checked={pEmpty} onChange={(e) => setPEmpty(e.target.checked)} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={doPreview} disabled={purgeBusy} style={btn}>Anteprima (dry-run)</button>
            <button onClick={doExecute} disabled={!preview || purgeBusy} style={{ ...btn, background: '#7f1d1d' }}>
              Esegui delete ({preview?.wouldDelete ?? 0})
            </button>
          </div>
          {preview && (
            <div style={{ marginTop: 16, padding: 12, background: '#0f172a', borderRadius: 8, border: '1px solid #334' }}>
              <p><strong>{preview.wouldDelete}</strong> entries verrebbero eliminate. Bytes stimati (primi 500): {fmtBytes(preview.sampleBytesFreedFromFirst500)}.</p>
              <details>
                <summary style={{ cursor: 'pointer' }}>Sample (primi 20)</summary>
                <ul style={{ fontSize: 12, marginTop: 8 }}>
                  {preview.sample.map((e) => <li key={e.id}><code>{e.id.slice(0, 8)}</code> — {e.sourcePlatform} — {fmtTs(e.createdAt)} — {e.status} — {e.sourceUrl.slice(0, 80)}</li>)}
                </ul>
              </details>
            </div>
          )}
          {purgeResult && (
            <div style={{ marginTop: 16, padding: 12, background: '#052e16', borderRadius: 8, border: '1px solid #14532d' }}>
              Eliminate <strong>{purgeResult.entriesDeleted}</strong> entries. Dir rimosse: {purgeResult.dirsDeleted}. Spazio liberato: {fmtBytes(purgeResult.bytesFreed)}.
            </div>
          )}
        </section>

        <section style={{ marginBottom: 32 }}>
          <h2>Retention policy</h2>
          {retention && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <Field label="Retention entries (giorni). Vuoto = mai eliminare.">
                <input type="number" min={0} value={retDays} onChange={(e) => setRetDays(e.target.value)} style={input} placeholder="(nessuna)" />
              </Field>
              <Field label="TTL orphan dirs (giorni)">
                <input type="number" min={0} value={orphanDays} onChange={(e) => setOrphanDays(e.target.value)} style={input} />
              </Field>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={saveRetention} disabled={retSaving} style={btn}>Salva retention</button>
            <button onClick={runCleanup} disabled={cleanBusy} style={btn}>Esegui cleanup ora</button>
          </div>
          {retMsg && <p style={{ marginTop: 8, color: retMsg.startsWith('Errore') ? '#f87171' : '#4ade80' }}>{retMsg}</p>}
          {cleanResult && (
            <div style={{ marginTop: 16, padding: 12, background: '#0f172a', borderRadius: 8, border: '1px solid #334' }}>
              <p>Orphan: {cleanResult.orphanDirsDeleted} dir, {fmtBytes(cleanResult.orphanBytesFreed)} liberati</p>
              <p>Retention: {cleanResult.retentionEntriesDeleted} entries, {cleanResult.retentionDirsDeleted} dir, {fmtBytes(cleanResult.retentionBytesFreed)} liberati</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 12, color: '#94a3b8' };
const td: React.CSSProperties = { padding: '8px 12px' };
const input: React.CSSProperties = {
  width: '100%', padding: '6px 10px', background: '#0f172a', border: '1px solid #334', color: '#e2e8f0', borderRadius: 6,
};
const btn: React.CSSProperties = {
  padding: '8px 16px', background: '#1e293b', color: '#e2e8f0', border: '1px solid #334', borderRadius: 6, cursor: 'pointer',
};

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: 12, background: '#0f172a', borderRadius: 8, border: '1px solid #334' }}>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div style={{ padding: 12, background: '#0f172a', borderRadius: 8, border: '1px solid #334' }}>
      <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>{title}</div>
      <table style={{ width: '100%', fontSize: 13 }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}><td style={{ padding: '3px 0' }}>{r[0]}</td><td style={{ textAlign: 'right' }}>{r[1]}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#cbd5e1' }}>
      <span>{label}</span>
      {children}
    </label>
  );
}
