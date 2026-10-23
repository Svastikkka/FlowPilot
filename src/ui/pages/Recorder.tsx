export function RecorderPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>
            Recorder <span className="badge draft">Not yet available</span>
          </h1>
          <p>Planned for a future version of FlowPilot. Nothing is recorded today.</p>
        </div>
      </div>
      <article className="card card-pad prose">
        <h2>What the recorder will do</h2>
        <ul>
          <li>Record clicks, typing, dropdown choices and checkbox changes on one tab you choose, only while recording is switched on.</li>
          <li>Show a clear recording indicator on the page and in the toolbar.</li>
          <li>Skip password, payment and one-time-code fields, and never record typed values in fields marked sensitive.</li>
          <li>Let you inspect, remove, reorder and edit every recorded step before saving it as a workflow.</li>
        </ul>
        <h2>Until then</h2>
        <p>
          Build workflows in the editor: add a step, choose the element with a CSS selector, its visible text or its label, and use <strong>Test step</strong>{' '}
          to check each step against the real page.
        </p>
        <div className="row">
          <a className="btn btn-primary" href="#/new">
            Create a workflow
          </a>
          <a className="btn" href="#/templates">
            Browse templates
          </a>
        </div>
      </article>
    </div>
  );
}
