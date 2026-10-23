import { useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { Workflow } from '../../shared/schema/types';
import { CsvError, parseCsv, toColumnName, toCsv, uniqueNames } from '../../shared/csv';
import { LIMITS } from '../../shared/schema/zod';
import { flatten } from '../../shared/schema/tree';
import { downloadFile, slugify } from '../api';
import type { EditorAction } from './state';

const PAGE_SIZE = 50;

export function DataPanel({ workflow, dispatch }: { workflow: Workflow; dispatch: Dispatch<EditorAction> }) {
  const data = workflow.data ?? { columns: [], rows: [] };
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const rowLoops = flatten(workflow.steps).filter((s) => s.type === 'forEachRow');
  const loopName = rowLoops[0]?.type === 'forEachRow' ? rowLoops[0].params.loopVariable : 'row';
  const pages = Math.max(1, Math.ceil(data.rows.length / PAGE_SIZE));
  const visibleRows = data.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const set = (next: typeof data) => dispatch({ type: 'setData', data: next.columns.length ? next : undefined });

  const importCsv = async (f: File) => {
    setError(null);
    try {
      const parsed = parseCsv(await f.text());
      set({ columns: parsed.columns, rows: parsed.rows });
      setPage(0);
    } catch (e) {
      setError(e instanceof CsvError ? e.message : 'Could not read the file');
    }
  };

  const renameColumn = (i: number, raw: string) => {
    const columns = [...data.columns];
    columns[i] = toColumnName(raw, i);
    set({ ...data, columns: uniqueNames(columns) });
  };

  const setCell = (r: number, c: number, value: string) =>
    set({ ...data, rows: data.rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row)) });

  return (
    <div className="stack card-pad">
      <h2>Data</h2>
      <p className="muted small">
        Rows used by <strong>For each data row</strong> loops. Each column becomes a variable inside the loop, e.g.{' '}
        <code>{`{{${loopName}_${data.columns[0] ?? 'email'}}}`}</code>. You can also pick a different CSV each time you run.
      </p>
      {rowLoops.length === 0 && data.columns.length > 0 && (
        <div className="banner info small">
          <span aria-hidden>ℹ</span>
          <div className="banner-body">Add a “For each data row” step to use this data.</div>
        </div>
      )}
      <div className="row">
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          aria-label="Import CSV file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importCsv(f);
            e.target.value = '';
          }}
        />
        <button className="btn btn-sm" onClick={() => file.current?.click()}>
          Import CSV
        </button>
        <button className="btn btn-sm" disabled={!data.columns.length} onClick={() => downloadFile(`${slugify(workflow.name)}-data.csv`, toCsv(data.columns, data.rows), 'text/csv')}>
          Export CSV
        </button>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          disabled={data.columns.length >= LIMITS.maxDataColumns}
          onClick={() => set({ columns: uniqueNames([...data.columns, `column_${data.columns.length + 1}`]), rows: data.rows.map((r) => [...r, '']) })}
        >
          ＋ Column
        </button>
        <button
          className="btn btn-sm"
          disabled={!data.columns.length || data.rows.length >= LIMITS.maxDataRows}
          onClick={() => {
            set({ ...data, rows: [...data.rows, data.columns.map(() => '')] });
            setPage(Math.floor(data.rows.length / PAGE_SIZE));
          }}
        >
          ＋ Row
        </button>
      </div>
      {error && (
        <div className="banner danger small" role="alert">
          <span aria-hidden>⚠</span>
          <div className="banner-body">{error}</div>
        </div>
      )}
      {data.columns.length === 0 ? (
        <p className="muted small">No data yet. Import a CSV (first row = column names) or add a column.</p>
      ) : (
        <>
          <div className="table-wrap data-grid">
            <table className="table">
              <thead>
                <tr>
                  <th className="muted">#</th>
                  {data.columns.map((c, i) => (
                    <th key={i}>
                      <div className="row" style={{ flexWrap: 'nowrap', gap: 2 }}>
                        <input
                          className="mono"
                          aria-label={`Column ${i + 1} name`}
                          defaultValue={c}
                          key={c}
                          onBlur={(e) => e.target.value !== c && renameColumn(i, e.target.value)}
                        />
                        <button
                          className="icon-btn"
                          aria-label={`Delete column ${c}`}
                          onClick={() => set({ columns: data.columns.filter((_, j) => j !== i), rows: data.rows.map((r) => r.filter((_, j) => j !== i)) })}
                        >
                          ✕
                        </button>
                      </div>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, vi) => {
                  const r = page * PAGE_SIZE + vi;
                  return (
                    <tr key={r}>
                      <td className="muted small">{r + 1}</td>
                      {data.columns.map((c, ci) => (
                        <td key={ci}>
                          <input aria-label={`Row ${r + 1} ${c}`} value={row[ci] ?? ''} onChange={(e) => setCell(r, ci, e.target.value)} />
                        </td>
                      ))}
                      <td>
                        <button className="icon-btn" aria-label={`Delete row ${r + 1}`} onClick={() => set({ ...data, rows: data.rows.filter((_, i) => i !== r) })}>
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row small muted">
            <span>
              {data.rows.length} row{data.rows.length === 1 ? '' : 's'} · {data.columns.length} column{data.columns.length === 1 ? '' : 's'}
            </span>
            {pages > 1 && (
              <>
                <span className="spacer" />
                <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  ‹ Prev
                </button>
                <span>
                  Page {page + 1} of {pages}
                </span>
                <button className="btn btn-sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                  Next ›
                </button>
              </>
            )}
          </div>
          <p className="muted small">Data is stored with the workflow (unencrypted) and included when you export it.</p>
        </>
      )}
    </div>
  );
}
