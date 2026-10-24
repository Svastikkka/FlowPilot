import { useEffect, useRef, useState } from 'react';
import type { Locator } from '../../shared/schema/types';
import { PICK_RESULT_KEY } from '../../shared/pickerProtocol';
import type { PickMode, PickResult } from '../../shared/pickerProtocol';
import { newId } from '../../shared/ids';
import { originPattern, requestAccess, sendCommand } from '../api';
import { PromptDialog } from '../components/ui';

interface Props {
  mode: PickMode;
  /** Page to open for picking (the workflow's nearest earlier Open URL), if known. */
  pageUrl?: string;
  onPicked: (locator: Locator, description: string) => void;
}

/**
 * "Pick on page": lets non-technical users choose an element by clicking it,
 * instead of writing a CSS selector or XPath.
 */
export function PickButton({ mode, pageUrl, onPicked }: Props) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [askUrl, setAskUrl] = useState(false);
  const onPickedRef = useRef(onPicked);
  onPickedRef.current = onPicked;

  useEffect(() => {
    if (!waiting) return;
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const result = area === 'session' ? (changes[PICK_RESULT_KEY]?.newValue as PickResult | undefined) : undefined;
      if (!result || result.requestId !== waiting) return;
      setWaiting(null);
      if (result.locator && result.description) {
        onPickedRef.current(result.locator, result.description);
        setStatus({ kind: 'ok', text: `Picked: ${result.description}` });
      } else if (result.error) setStatus({ kind: 'error', text: result.error });
      else setStatus({ kind: 'info', text: 'Picking was cancelled' });
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [waiting]);

  const start = (url?: string) => {
    const requestId = newId('pick');
    setStatus(null);
    setWaiting(requestId);
    // Site access must be requested inside the click.
    const origin = url ? originPattern(url) : null;
    (origin ? requestAccess([origin]) : Promise.resolve(true))
      .then((ok) => {
        if (!ok) throw new Error('FlowPilot needs access to that site to pick on it.');
        return sendCommand({ type: 'picker.start', url, mode, requestId });
      })
      .catch((e: Error) => {
        setWaiting(null);
        if (/Enter the page/.test(e.message)) setAskUrl(true);
        else setStatus({ kind: 'error', text: e.message });
      });
  };

  return (
    <div className="pick-row">
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => (pageUrl ? start(pageUrl) : setAskUrl(true))}
        disabled={!!waiting}
        title={mode === 'multiple' ? 'Click one item on the page; FlowPilot selects all the similar ones' : 'Click the element on the page'}
      >
        {waiting ? <span className="spinner" aria-hidden /> : '🎯'} {waiting ? 'Waiting for your click…' : 'Pick on page'}
      </button>
      {waiting && (
        <span className="small muted">Click {mode === 'multiple' ? 'one of the items' : 'the element'} in the page that opened, or press Esc there to cancel.</span>
      )}
      {status && (
        <span className={`small pick-status ${status.kind}`} role="status">
          {status.text}
        </span>
      )}
      {askUrl && (
        <PromptDialog
          title="Which page should FlowPilot open?"
          label="Page address"
          initial="https://"
          confirmLabel="Open and pick"
          onCancel={() => setAskUrl(false)}
          onSubmit={(url) => {
            setAskUrl(false);
            start(url);
          }}
        />
      )}
    </div>
  );
}
