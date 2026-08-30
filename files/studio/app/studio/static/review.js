// The supervisor's screen: submissions arriving for a form, and the decision
// to approve them, flag issues, or reject them.
//
// Reviewing is Central's own submission review; Studio only presents it in one
// place per form. Whether the buttons appear at all is Central's answer, not
// Studio's.

import { api } from './api.js';
import { clear, confirmDialog, el, select, spinner, toast } from './ui.js';

const STATES = [
  { value: 'null', label: 'Received', pill: '' },
  { value: 'approved', label: 'Approved', pill: 'ok' },
  { value: 'hasIssues', label: 'Has issues', pill: 'warn' },
  { value: 'rejected', label: 'Rejected', pill: 'err' },
];
const STATE_BY_VALUE = new Map(STATES.map((s) => [s.value, s]));

const describe = (value) => STATE_BY_VALUE.get(value || 'null') || STATE_BY_VALUE.get('null');

export function createReview(ctx) {
  const state = { formId: null, formName: null, filter: 'all', rows: [], canReview: false };

  const root = el('div');
  const formsHost = el('div', { class: 'panel' });
  const listHost = el('div');

  async function loadForms() {
    clear(formsHost);
    formsHost.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: 'Forms' }),
      el('div', { class: 'spacer' }),
      el('span', { class: 'muted small', text: ctx.project.name }),
    ]));
    const loading = el('div', { class: 'empty' }, [spinner(), ' Loading forms…']);
    formsHost.appendChild(loading);

    let forms;
    try {
      forms = await api.forms(ctx.project.id);
    } catch (error) {
      loading.replaceWith(el('div', { class: 'empty', text: error.message }));
      return;
    }
    loading.remove();

    if (!forms.length) {
      formsHost.appendChild(el('div', { class: 'empty', text: 'This project has no forms yet.' }));
      return;
    }

    const tbody = el('tbody');
    for (const form of forms) {
      const row = el('tr', { style: 'cursor:pointer', onclick: () => openForm(form) }, [
        el('td', {}, [
          el('div', { text: form.name }),
          el('div', { class: 'small mono muted', text: form.xmlFormId }),
        ]),
        el('td', { class: 'small', text: form.submissions == null ? '—' : String(form.submissions) }),
        el('td', { class: 'small', text: form.lastSubmission ? new Date(form.lastSubmission).toLocaleString() : 'none yet' }),
        el('td', {}, [el('button', { class: 'mini', text: 'Review' })]),
      ]);
      if (state.formId === form.xmlFormId) row.style.background = 'var(--accent-soft)';
      tbody.appendChild(row);
    }
    formsHost.appendChild(el('table', { class: 'grid' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Form' }), el('th', { text: 'Submissions' }),
        el('th', { text: 'Last received' }), el('th', { text: '' }),
      ])]),
      tbody,
    ]));
  }

  async function openForm(form) {
    state.formId = form.xmlFormId;
    state.formName = form.name;
    await loadForms();
    await loadSubmissions();
  }

  async function loadSubmissions() {
    clear(listHost);
    const panel = el('div', { class: 'panel' });
    listHost.appendChild(panel);
    panel.appendChild(el('div', { class: 'empty' }, [spinner(), ' Loading submissions…']));

    let body;
    try {
      body = await api.submissions(ctx.project.id, state.formId);
    } catch (error) {
      clear(panel);
      panel.appendChild(el('div', { class: 'empty', text: error.message }));
      return;
    }
    state.rows = body.submissions;
    state.canReview = body.canReview;
    render();
  }

  function counts() {
    const tally = { all: state.rows.length };
    for (const item of STATES) {
      tally[item.value] = state.rows.filter((r) => (r.reviewState || 'null') === item.value).length;
    }
    return tally;
  }

  function visible() {
    if (state.filter === 'all') return state.rows;
    return state.rows.filter((r) => (r.reviewState || 'null') === state.filter);
  }

  async function setState(row, value) {
    if (value === 'rejected') {
      const ok = await confirmDialog(
        'Reject this submission',
        'Rejecting tells the field team the data cannot be used as it stands. Continue?',
        'Reject',
      );
      if (!ok) return;
    }
    try {
      const result = await api.reviewSubmission(ctx.project.id, state.formId, row.instanceId, value);
      row.reviewState = result.reviewState;
      render();
      toast(`Marked as ${describe(result.reviewState).label.toLowerCase()}`, 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function render() {
    clear(listHost);
    const tally = counts();

    const filters = el('div', { class: 'tabs' }, [
      el('button', {
        class: state.filter === 'all' ? 'active' : '',
        text: `All (${tally.all})`,
        onclick: () => { state.filter = 'all'; render(); },
      }),
      ...STATES.map((item) => el('button', {
        class: state.filter === item.value ? 'active' : '',
        text: `${item.label} (${tally[item.value]})`,
        onclick: () => { state.filter = item.value; render(); },
      })),
    ]);

    const panel = el('div', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { text: state.formName || state.formId }),
        el('span', { class: 'pill mono', text: state.formId }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'mini', text: 'Refresh', onclick: loadSubmissions }),
      ]),
      el('div', { style: 'padding:12px 18px; border-bottom:1px solid var(--line)' }, [filters]),
    ]);

    const rows = visible();
    if (!rows.length) {
      panel.appendChild(el('div', { class: 'empty', text:
        state.rows.length ? 'Nothing in this category.' : 'No submissions for this form yet.' }));
      listHost.appendChild(panel);
      return;
    }

    const tbody = el('tbody');
    for (const row of rows) {
      const current = describe(row.reviewState);
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'small mono', text: row.instanceId }),
          el('div', { class: 'small muted', text: row.deviceId ? `device ${row.deviceId}` : '' }),
        ]),
        el('td', { class: 'small', text: row.submitter || '—' }),
        el('td', { class: 'small', text: row.createdAt ? new Date(row.createdAt).toLocaleString() : '—' }),
        el('td', {}, [el('span', { class: `pill ${current.pill}`.trim(), text: current.label })]),
        el('td', { style: 'width:270px' }, state.canReview ? [
          el('button', {
            class: 'mini', text: 'Approve',
            disabled: row.reviewState === 'approved',
            onclick: () => setState(row, 'approved'),
          }),
          el('button', {
            class: 'mini', style: 'margin-left:6px', text: 'Has issues',
            disabled: row.reviewState === 'hasIssues',
            onclick: () => setState(row, 'hasIssues'),
          }),
          el('button', {
            class: 'mini danger', style: 'margin-left:6px', text: 'Reject',
            disabled: row.reviewState === 'rejected',
            onclick: () => setState(row, 'rejected'),
          }),
        ] : [el('span', { class: 'small muted', text: 'view only' })]),
      ]));
    }

    panel.appendChild(el('table', { class: 'grid submissions' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Submission' }), el('th', { text: 'Submitted by' }),
        el('th', { text: 'Received' }), el('th', { text: 'State' }), el('th', { text: '' }),
      ])]),
      tbody,
    ]));

    if (!state.canReview) {
      panel.appendChild(el('div', { class: 'panel-body small muted', text:
        'Your Central account can see these submissions but not review them. A project manager can review.' }));
    }
    listHost.appendChild(panel);
  }

  root.appendChild(formsHost);
  root.appendChild(el('div', { style: 'height:18px' }));
  root.appendChild(listHost);
  loadForms();
  return root;
}
