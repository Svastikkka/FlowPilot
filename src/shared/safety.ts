import type { Step, Workflow } from './schema/types';
import { stepLocator } from './schema/actions';
import { walk } from './schema/tree';

// Heuristics that flag steps which may submit, buy, delete or send something.
// They are advisory: the run dialog asks for acknowledgement and the editor
// suggests enabling "Ask before this step".

const SENSITIVE_RE =
  /\b(submit|buy|purchase|pay|payment|checkout|check out|place order|order now|delete|remove|destroy|erase|send|transfer|unsubscribe|cancel subscription|confirm|publish|post)\b|type=["']?submit/i;

const PASSWORD_RE = /password|passwd|pwd|\bpin\b|otp|one-time|secret|token|cvv|cvc|card.?number/i;

export interface SensitiveFinding {
  stepId: string;
  reason: string;
}

export function sensitiveReason(step: Step): string | null {
  const locator = stepLocator(step);
  if (step.type === 'click' && locator && SENSITIVE_RE.test(locator.value)) {
    return 'This click looks like it may submit, buy, delete or send something.';
  }
  if (step.type === 'type' && step.params.pressEnter) {
    return 'Pressing Enter may submit the form.';
  }
  return null;
}

export function findSensitiveSteps(workflow: Pick<Workflow, 'steps'>): SensitiveFinding[] {
  const findings: SensitiveFinding[] = [];
  walk(workflow.steps, (step) => {
    if (step.disabled) return false;
    const reason = sensitiveReason(step);
    if (reason) findings.push({ stepId: step.id, reason });
  });
  return findings;
}

/** Typing literal text into something that looks like a credential field. */
export function looksLikeCredentialField(step: Step): boolean {
  if (step.type !== 'type') return false;
  return PASSWORD_RE.test(step.params.locator.value) && !/\{\{/.test(step.params.text) && step.params.text.length > 0;
}
