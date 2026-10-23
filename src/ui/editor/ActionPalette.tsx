import type { ActionCategory } from '../../shared/schema/actions';
import { ACTIONS, ACTION_TYPES } from '../../shared/schema/actions';
import type { ActionType } from '../../shared/schema/types';
import { Modal } from '../components/ui';

const CATEGORIES: ActionCategory[] = ['Navigation', 'Interaction', 'Waiting', 'Logic', 'Data', 'Control'];

export function ActionPalette({ onPick, onClose }: { onPick: (type: ActionType) => void; onClose: () => void }) {
  return (
    <Modal title="Add a step" onClose={onClose} wide>
      <div className="palette">
        {CATEGORIES.map((category) => (
          <section key={category}>
            <h4>{category}</h4>
            <div className="palette-grid">
              {ACTION_TYPES.filter((t) => ACTIONS[t].category === category).map((t) => (
                <button key={t} className="palette-item" onClick={() => onPick(t)}>
                  <span aria-hidden>{ACTIONS[t].icon}</span>
                  <span>
                    {ACTIONS[t].label}
                    <small>{ACTIONS[t].description}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
        <p className="muted small">Logic blocks (If / Else and loops) hold other steps — add steps inside them in the step list.</p>
      </div>
    </Modal>
  );
}
