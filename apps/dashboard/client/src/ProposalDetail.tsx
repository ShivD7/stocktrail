import { useEffect, useRef, useState } from 'react';
import type {
  DashboardApplyResult,
  DashboardProposalActionResult,
  DashboardProposalDetail,
  DashboardRevertResult,
} from '../../../../packages/shared/src/dashboard.js';
import { ActionButton, ErrorState, LoadingState } from './ActionButton.js';
import { apiGet, apiPost, safeErrorMessage } from './api.js';

const fieldLabels: Record<string, string> = {
  title: 'Product title', descriptionHtml: 'Description', 'seo.title': 'SEO title', 'seo.description': 'SEO description',
};

const warningLabels: Record<string, string> = {
  PW_TRANSIENT_CLAIM_REINTRODUCED: 'This proposal may reintroduce a time-sensitive inventory claim.',
  PW_READINESS_REGRESSION: 'The verified readiness score may be lower than the current score.',
};

function Score(props: { label: string; value: number | null; tone: 'current' | 'predicted' | 'verified' }) {
  return <div className={`proposal-score proposal-score--${props.tone}`}><span>{props.value ?? '—'}</span><strong>{props.label}</strong><small>{props.value === null ? 'Inconclusive' : 'out of 100'}</small></div>;
}

function Confirmation(props: {
  verb: 'APPLY' | 'REVERT'; proposal: DashboardProposalDetail; onClose: () => void; onComplete: () => void;
}) {
  const expected = `${props.verb} ${props.proposal.id}`;
  const [confirmation, setConfirmation] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [completed, setCompleted] = useState(false);
  const [revertProposalId, setRevertProposalId] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const completionTarget = useRef<HTMLButtonElement>(null);
  const busyState = useRef(false);
  const hasWarnings = props.proposal.validation.warningCodes.length > 0;

  busyState.current = busy;

  useEffect(() => {
    const dialogElement = dialog.current;
    const backdrop = dialogElement?.closest<HTMLElement>('.confirmation-backdrop');
    if (!dialogElement || !backdrop) return;

    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const background = [
      document.querySelector<HTMLElement>('.sidebar'),
      ...Array.from(backdrop.parentElement?.children ?? []).filter(element => element !== backdrop),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
    const priorInert = background.map(element => ({ element, value: element.hasAttribute('inert') }));
    for (const element of background) element.setAttribute('inert', '');

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyState.current) props.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogElement!.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialogElement!.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    dialogElement.addEventListener('keydown', handleKeyDown);
    window.requestAnimationFrame(() => input.current?.focus());
    return () => {
      dialogElement.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = bodyOverflow;
      for (const { element, value } of priorInert) {
        if (!value) element.removeAttribute('inert');
      }
    };
  }, []);

  useEffect(() => {
    if (completed) window.requestAnimationFrame(() => completionTarget.current?.focus());
  }, [completed]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || confirmation !== expected || (props.verb === 'APPLY' && hasWarnings && !acknowledge)) return;
    setBusy(true);
    setMessage('');
    try {
      if (props.verb === 'APPLY') {
        const result = await apiPost<DashboardApplyResult>(`/api/proposals/${props.proposal.id}/apply`, { confirmation, acknowledgeWarnings: acknowledge });
        setMessage(`Apply result: ${result.status.replace('_', ' ')}; verification ${result.verification.replace('_', ' ')}.`);
        setCompleted(true);
        props.onComplete();
      } else {
        const result = await apiPost<DashboardRevertResult>(`/api/proposals/${props.proposal.id}/revert`, {});
        setRevertProposalId(result.proposalId);
        setMessage('Revert proposal created. Shopify was not changed.');
        setCompleted(true);
        props.onComplete();
      }
    } catch (error) {
      setMessage(safeErrorMessage(error));
    } finally { setBusy(false); }
  }

  return (
    <div className="confirmation-backdrop">
      <section ref={dialog} className="confirmation" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description" tabIndex={-1} aria-busy={busy}>
        <div className="confirmation-heading"><div><p className="eyebrow">Explicit confirmation</p><h2 id="confirmation-title">{props.verb === 'APPLY' ? 'Apply to Shopify' : 'Create a revert proposal'}</h2></div><button className="icon-button" type="button" onClick={props.onClose} aria-label="Close confirmation" disabled={busy}>×</button></div>
        <p id="confirmation-description">{props.verb === 'APPLY' ? 'This is the only action on this page that writes product content. StockTrail will recheck the proposal and verify the result.' : 'This creates a new reviewable proposal. It does not change Shopify.'}</p>
        {!completed && hasWarnings ? <div className="warning-list" role="note"><strong>Risks to review</strong><ul>{props.proposal.validation.warningCodes.map(code => <li key={code}>{warningLabels[code] ?? code.replaceAll('_', ' ').toLocaleLowerCase()}</li>)}</ul></div> : null}
        {!completed ? <form onSubmit={event => void submit(event)}>
          <label><span>Type <code>{expected}</code></span><input ref={input} type="text" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>
          {props.verb === 'APPLY' && hasWarnings ? <label className="check-label"><input type="checkbox" checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)} /><span>I understand and acknowledge these risks.</span></label> : null}
          <div className="confirmation-actions"><button className="secondary-action" type="button" onClick={props.onClose} disabled={busy}>Cancel</button><button className={props.verb === 'APPLY' ? 'danger-action' : 'primary-action'} type="submit" disabled={busy || confirmation !== expected || (props.verb === 'APPLY' && hasWarnings && !acknowledge)}>{busy ? 'Working…' : props.verb === 'APPLY' ? 'Apply proposal' : 'Create revert proposal'}</button></div>
        </form> : <div className="confirmation-actions confirmation-actions--complete">
          {revertProposalId ? <a className="primary-action" href={`#/proposals/${revertProposalId}`}>Review revert proposal</a> : null}
          <button ref={completionTarget} className="secondary-action" type="button" onClick={props.onClose}>Close</button>
        </div>}
        {message ? <p className={`action-message${completed ? '' : ' action-message--error'}`} role={completed ? 'status' : 'alert'} aria-live={completed ? 'polite' : 'assertive'}>{message}</p> : null}
      </section>
    </div>
  );
}

export function ProposalDetail({ proposalId, onChanged }: { proposalId: string; onChanged?: () => void }) {
  const [proposal, setProposal] = useState<DashboardProposalDetail | null>(null);
  const [error, setError] = useState<'not-found' | 'unavailable' | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirming, setConfirming] = useState<'apply' | 'revert' | null>(null);
  const confirmationTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void apiGet<DashboardProposalDetail>(`/api/proposals/${proposalId}`, controller.signal)
      .then(setProposal)
      .catch(value => { if (value?.name !== 'AbortError') setError(value?.code === 'not_found' ? 'not-found' : 'unavailable'); });
    return () => controller.abort();
  }, [proposalId, revision]);

  useEffect(() => {
    if (proposal) document.title = `${proposal.kind === 'revert' ? 'Revert' : 'Improvement'} proposal · StockTrail`;
  }, [proposal]);

  function refresh() { setRevision(value => value + 1); onChanged?.(); }
  function closeConfirmation() {
    setConfirming(null);
    const trigger = confirmationTrigger.current;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector<HTMLElement>('#main-content h1')?.focus();
    });
  }
  function openConfirmation(kind: 'apply' | 'revert', trigger: HTMLButtonElement) {
    confirmationTrigger.current = trigger;
    setConfirming(kind);
  }
  if (error) return <ErrorState headingLevel={1} title={error === 'not-found' ? 'Proposal not found' : 'Proposal unavailable'} message={error === 'not-found' ? 'This proposal is not available for the configured shop.' : 'StockTrail could not safely read the proposal artifact.'} retry={error === 'unavailable' ? refresh : undefined} />;
  if (!proposal) return <LoadingState label="Checking proposal integrity…" />;

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb"><a href={`#/products/${encodeURIComponent(proposal.productGid)}`}>Product</a><span aria-hidden="true">/</span><span>Proposal</span></nav>
      <section className="detail-hero proposal-hero">
        <div><div className="detail-kicker"><span className={`state-pill state-pill--${proposal.validation.valid ? 'good' : 'bad'}`}>{proposal.validation.valid ? 'validated' : 'invalid'}</span><span className="state-pill">{proposal.kind}</span></div><h1>{proposal.kind === 'revert' ? 'Revert proposal' : 'Improvement proposal'}</h1><p>Status: <strong>{proposal.status.replace('_', ' ')}</strong> · Verification: <strong>{proposal.verificationStatus.replace('_', ' ')}</strong></p></div>
        <div className="detail-actions">
          {proposal.allowedActions.includes('reject') ? <ActionButton<DashboardProposalActionResult> label="Reject" busyLabel="Rejecting…" action={() => apiPost(`/api/proposals/${proposal.id}/reject`, {})} successMessage="Proposal rejected." onSuccess={refresh} /> : null}
          {proposal.allowedActions.includes('reconcile') ? <ActionButton<DashboardProposalActionResult> label="Reconcile" busyLabel="Checking…" action={() => apiPost(`/api/proposals/${proposal.id}/reconcile`, {})} successMessage={result => `Reconciled: ${result.verificationStatus.replace('_', ' ')}.`} onSuccess={refresh} /> : null}
          {proposal.allowedActions.includes('create_revert') ? <button className="secondary-action" type="button" onClick={event => openConfirmation('revert', event.currentTarget)}>Create revert</button> : null}
          {proposal.allowedActions.includes('apply') ? <button className="primary-action" type="button" onClick={event => openConfirmation('apply', event.currentTarget)}>Review and apply</button> : null}
        </div>
      </section>

      <section className="proposal-score-grid" aria-label="Proposal score comparison">
        <Score label="Current" value={proposal.scores.current} tone="current" />
        <Score label="Predicted" value={proposal.scores.predicted} tone="predicted" />
        <Score label="Verified" value={proposal.scores.verified} tone="verified" />
      </section>

      {proposal.validation.reasonCodes.length ? <div className="validation-message" role="alert"><strong>This proposal is not safe to apply.</strong><ul>{proposal.validation.reasonCodes.map(code => <li key={code}>{code.replaceAll('_', ' ').toLocaleLowerCase()}</li>)}</ul></div> : null}
      {proposal.validation.warningCodes.length ? <div className="validation-message validation-message--warning" role="note"><strong>Review required</strong><ul>{proposal.validation.warningCodes.map(code => <li key={code}>{warningLabels[code] ?? code.replaceAll('_', ' ').toLocaleLowerCase()}</li>)}</ul></div> : null}

      <section aria-labelledby="changes-title">
        <div className="section-heading"><p className="eyebrow">Inert text preview</p><h2 id="changes-title">Proposed changes</h2><p className="muted">Removed text is struck through; added text is underlined. HTML is displayed as text and never executed.</p></div>
        <div className="diff-list">{proposal.diffs.map(diff => (
          <article className="panel diff-card" key={diff.field}>
            <div className="panel-heading"><h3>{fieldLabels[diff.field]}</h3>{diff.truncated ? <span className="state-pill state-pill--muted">preview truncated</span> : null}</div>
            <pre className="semantic-diff" aria-label={`${fieldLabels[diff.field]} text diff`}>{diff.parts.map((part, index) => part.kind === 'remove' ? <del key={index}>{part.value}</del> : part.kind === 'add' ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</pre>
          </article>
        ))}</div>
      </section>

      {confirming ? <Confirmation verb={confirming === 'apply' ? 'APPLY' : 'REVERT'} proposal={proposal} onClose={closeConfirmation} onComplete={refresh} /> : null}
    </>
  );
}
