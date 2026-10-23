export function PrivacyPage() {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Privacy</h1>
          <p>How FlowPilot handles your data.</p>
        </div>
      </div>
      <article className="card card-pad prose">
        <h2>The short version</h2>
        <ul>
          <li>FlowPilot has no servers, accounts, analytics, advertising or remote logging.</li>
          <li>Workflows, run history, extracted results, screenshots and settings are stored only in this browser profile.</li>
          <li>Nothing FlowPilot stores is sent anywhere by FlowPilot.</li>
        </ul>

        <h2>What is stored, and where</h2>
        <ul>
          <li>
            <strong>Workflows</strong> (steps, variables and their default values, data tables you import) — IndexedDB, until you delete them.
          </li>
          <li>
            <strong>Run history</strong> (status, timings, step messages, errors, extracted values, results tables, screenshots) — IndexedDB, limited to your most recent
            runs (configurable in Settings).
          </li>
          <li>
            <strong>Settings</strong> — chrome.storage.local.
          </li>
        </ul>
        <p>
          This data is <strong>not encrypted</strong> by FlowPilot. Anyone with access to your browser profile could read it. Avoid putting passwords in
          workflow defaults; use a <em>secret</em> variable that is asked at run start instead.
        </p>

        <h2>What is never stored</h2>
        <ul>
          <li>The text a workflow types into pages is not written to run history.</li>
          <li>Values of secret variables are kept in memory only for the duration of a run.</li>
          <li>FlowPilot refuses to read password and payment fields.</li>
        </ul>

        <h2>Websites you automate</h2>
        <p>
          When a workflow fills in or submits a form, that website receives the data — exactly as if you had typed it. The website’s own privacy policy
          applies to that data. FlowPilot asks for confirmation before steps that look like submissions, purchases or deletions, and you can require a
          confirmation before any step.
        </p>

        <h2>Permissions</h2>
        <p>
          FlowPilot only accesses the sites you allow, and only the tab a run is controlling. Site access is requested when needed and can be revoked
          under Settings → Site access. FlowPilot never bypasses CAPTCHAs, logins or other access controls.
        </p>

        <h2>Imported workflows</h2>
        <p>
          Imported files are validated before saving. Workflows can only use FlowPilot’s built-in actions; there is no way for a workflow to run its own
          code.
        </p>

        <h2>Deleting your data</h2>
        <p>
          Go to Settings → Your data to delete run history or everything FlowPilot has stored. Uninstalling the extension also removes all of its data
          from this browser.
        </p>
      </article>
    </div>
  );
}
