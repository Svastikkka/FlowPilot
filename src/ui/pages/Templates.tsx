import { TEMPLATES } from '../../templates';
import type { Template } from '../../templates';
import { actionDef } from '../../shared/schema/actions';
import { saveWorkflow } from '../../storage/workflows';
import { navigate } from '../router';
import { useToast } from '../components/ui';

export async function createFromTemplate(template: Template) {
  const wf = await saveWorkflow(template.build());
  navigate(`/workflows/${wf.id}`);
}

export function TemplatesPage() {
  const toast = useToast();
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Templates</h1>
          <p>Starting points for common tasks. Using a template creates your own copy that you can edit freely.</p>
        </div>
      </div>
      <div className="wf-grid">
        {TEMPLATES.map((t) => {
          const preview = t.build();
          return (
            <article key={t.id} className="card wf-card">
              <div className="row">
                <h3 style={{ flex: 1 }}>{t.name}</h3>
                <span className="badge">{t.category}</span>
              </div>
              <p className="desc">{t.description}</p>
              <div className="row" style={{ gap: 4 }} aria-label="Steps">
                {preview.steps.map((s) => (
                  <span key={s.id} className="badge" title={actionDef(s.type).label}>
                    {actionDef(s.type).icon} {actionDef(s.type).label}
                  </span>
                ))}
              </div>
              <div className="actions">
                <button className="btn btn-sm btn-primary" onClick={() => void createFromTemplate(t).catch((e: Error) => toast(e.message, 'error'))}>
                  Use template
                </button>
                <span className="muted small">{preview.steps.length} steps</span>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
