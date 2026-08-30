// An interactive preview: the questionnaire rendered as a form you can fill in,
// with relevance, calculations and validation evaluated as you type.
//
// It is a simulation, not ODK Collect. Expressions are evaluated by the small
// engine in expr.js, and anything that engine cannot read is reported on the
// question rather than silently ignored.

import { evaluate, ExprError, helpers, parse } from './expr.js';
import { checkbox, clear, el, modal } from './ui.js';

const ATTACHMENT_TYPES = new Set(['image', 'audio', 'video', 'file']);
const GEO_TYPES = new Set(['geopoint', 'geotrace', 'geoshape']);

export function openPreview(doc, language) {
  const top = Object.create(null);
  const repeats = new Map();
  const state = { showAll: false, controllers: [], language };

  const text = (map) => {
    const value = (map || {})[state.language];
    if (value && value.trim()) return value;
    const fallback = Object.values(map || {}).find((v) => v && v.trim());
    return fallback || '';
  };

  const listFor = (name) => doc.choiceLists.find((l) => l.name === name);

  // ODK substitutes ${name} in labels and hints with the current answer; that
  // is what puts each person's name on their own roster page.
  const OUTPUT = /\$\{([^}]+)\}/g;
  function substitute(source, scope) {
    return String(source || '').replace(OUTPUT, (_, name) => {
      const value = contextFor(scope, null).get(name.trim());
      return helpers.isBlank(value) ? '' : helpers.toStringValue(value);
    });
  }

  function contextFor(scope, self) {
    return {
      self,
      position: scope.__position,
      rows: (name) => repeats.get(name) || null,
      get(name) {
        if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
        return Object.prototype.hasOwnProperty.call(top, name) ? top[name] : null;
      },
    };
  }

  function evaluateOr(expression, scope, self, fallback) {
    if (!expression || !expression.trim()) return fallback;
    try {
      return evaluate(parse(expression), contextFor(scope, self));
    } catch (error) {
      if (error instanceof ExprError) return { unevaluated: error.message };
      throw error;
    }
  }

  // -- validation ---------------------------------------------------------

  function check(item, scope) {
    const value = scope[item.name];
    const result = { errors: [], warnings: [], notes: [] };

    if (item.required && helpers.isBlank(value)) {
      result.errors.push('This question is required.');
      return result;
    }
    // ODK does not apply constraints to an unanswered question.
    if (helpers.isBlank(value)) return result;

    for (const rule of item.rules || []) {
      if (!rule.expression || !rule.expression.trim()) continue;
      let outcome;
      try {
        outcome = helpers.toBoolean(
          evaluate(parse(rule.expression), contextFor(scope, value)),
        );
      } catch (error) {
        result.notes.push(`Not checked here: ${rule.expression} (${error.message})`);
        continue;
      }
      if (!outcome) {
        const message = text(rule.message) || 'That answer is not allowed.';
        (rule.severity === 'warning' ? result.warnings : result.errors).push(message);
      }
    }
    return result;
  }

  // -- inputs -------------------------------------------------------------

  function renderInput(item, scope, onChange) {
    const type = item.type;
    const set = (value) => {
      scope[item.name] = value === '' ? null : value;
      onChange();
    };

    if (type === 'select_one' || type === 'select_multiple') {
      const list = listFor(item.choiceList);
      if (!list) return el('div', { class: 'preview-missing', text: 'No choice list selected.' });
      const multiple = type === 'select_multiple';
      const group = el('div', { class: 'preview-choices' });

      for (const option of list.options) {
        const box = el('input', {
          type: multiple ? 'checkbox' : 'radio',
          name: `${item.name}-${scope.__id || 'top'}`,
          value: option.value,
        });
        box.addEventListener('change', () => {
          if (!multiple) { set(option.value); return; }
          const chosen = String(scope[item.name] || '').split(/\s+/).filter(Boolean);
          const next = box.checked
            ? [...new Set([...chosen, option.value])]
            : chosen.filter((v) => v !== option.value);
          // Keep the order the choice list defines, as ODK does.
          const ordered = list.options.map((o) => o.value).filter((v) => next.includes(v));
          set(ordered.join(' '));
        });
        group.appendChild(el('label', { class: 'preview-choice' }, [
          box,
          el('span', { text: `${text(option.label) || option.value}` }),
          el('span', { class: 'preview-code', text: option.value }),
        ]));
      }
      return group;
    }

    if (type === 'note') return null;
    if (type === 'hidden') return null;

    if (type === 'calculate') {
      const output = el('div', { class: 'preview-calculated' });
      output.dataset.role = 'calculated';
      return output;
    }

    if (type === 'acknowledge') {
      return checkbox('OK', false, (v) => set(v ? 'OK' : ''));
    }

    if (ATTACHMENT_TYPES.has(type)) {
      return el('div', { class: 'preview-device', text:
        `${type} is captured on the device; type a filename here to simulate an answer.` });
    }

    if (GEO_TYPES.has(type)) {
      const node = el('input', { type: 'text', placeholder: 'captured on the device, e.g. -17.8 177.4 0 5' });
      node.addEventListener('input', () => set(node.value));
      return node;
    }

    if (type === 'range') {
      const params = Object.fromEntries(
        String(item.parameters || '').split(/\s+/).filter(Boolean)
          .map((pair) => pair.split('=')).filter((p) => p.length === 2),
      );
      const node = el('input', {
        type: 'range',
        min: params.start ?? '0',
        max: params.end ?? '10',
        step: params.step ?? '1',
      });
      const readout = el('span', { class: 'preview-code', text: node.value });
      node.addEventListener('input', () => { readout.textContent = node.value; set(node.value); });
      return el('div', { style: 'display:flex; gap:10px; align-items:center' }, [node, readout]);
    }

    const attributes = { type: 'text' };
    if (type === 'integer') { attributes.type = 'number'; attributes.step = '1'; }
    else if (type === 'decimal') { attributes.type = 'number'; attributes.step = 'any'; }
    else if (type === 'date') attributes.type = 'date';
    else if (type === 'time') attributes.type = 'time';
    else if (type === 'dateTime') attributes.type = 'datetime-local';

    const node = el('input', attributes);
    node.addEventListener('input', () => set(node.value));
    node.addEventListener('blur', () => { node.dataset.touched = '1'; onChange(); });
    return node;
  }

  // -- building the form --------------------------------------------------

  function buildList(item, scope, host) {
    const itemName = `${item.name}_item`;
    const rows = [];
    repeats.set(item.name, rows);

    const body = el('div', { class: 'body' });
    const block = el('div', { class: 'preview-group' }, [
      el('div', { class: 'head' }, [
        el('span', { text: text(item.label) || item.name }),
        el('span', { class: 'pill', text: 'list' }),
      ]),
      body,
    ]);
    host.appendChild(block);

    const rowHost = el('div');
    const feedback = el('div', { class: 'q-feedback' });
    body.appendChild(rowHost);

    function addRow(value) {
      const rowScope = Object.create(null);
      rowScope[itemName] = value ?? null;
      const box = el('input', { type: 'text', placeholder: text(item.hint) || 'Item' });
      box.value = value ?? '';
      box.addEventListener('input', () => {
        rowScope[itemName] = box.value === '' ? null : box.value;
        refreshAll();
      });
      const line = el('div', { class: 'preview-list-row' }, [
        el('span', { class: 'preview-code', text: String(rows.length + 1) }),
        box,
        el('button', { class: 'mini danger', text: 'Remove', onclick: () => {
          const at = rows.indexOf(rowScope);
          if (at !== -1) { rows.splice(at, 1); line.remove(); refreshAll(); }
        } }),
      ]);
      rows.push(rowScope);
      rowHost.appendChild(line);
      rowScope.__line = line;
    }

    body.appendChild(el('div', {}, [
      el('button', { class: 'mini', text: '+ Add item', onclick: () => { addRow(); refreshAll(); } }),
    ]));
    body.appendChild(feedback);
    addRow();

    return {
      refresh() {
        const relevant = evaluateOr(item.relevant, scope, null, true);
        const shown = relevant && relevant.unevaluated !== undefined ? true : helpers.toBoolean(relevant);
        block.hidden = !shown;
        if (!shown) return;
        rows.forEach((row, index) => {
          row.__position = index + 1;
          row.__line.firstChild.textContent = String(index + 1);
        });
        clear(feedback);
        if (state.showAll && item.required && !rows.some((r) => !helpers.isBlank(r[itemName]))) {
          feedback.appendChild(el('div', { class: 'q-error', text: 'List at least one item.' }));
        }
      },
      collect(out) {
        if (block.hidden) return;
        if (item.required && !rows.some((r) => !helpers.isBlank(r[itemName]))) {
          out.errors += 1;
          if (!out.first) out.first = block;
        }
      },
    };
  }

  function buildItems(items, scope, host) {
    const controllers = [];
    for (const item of items) {
      if (item.kind === 'question' && item.type === 'list') {
        controllers.push(buildList(item, scope, host));
      } else {
        controllers.push(
          item.kind === 'group' ? buildGroup(item, scope, host) : buildQuestion(item, scope, host),
        );
      }
    }
    return controllers;
  }

  function buildGroup(item, scope, host) {
    const body = el('div', { class: 'body' });
    const heading = el('span', { text: text(item.label) || item.name });
    const block = el('div', { class: 'preview-group' }, [
      el('div', { class: 'head' }, [
        heading,
        item.repeat ? el('span', { class: 'pill', text: 'repeats' }) : null,
      ]),
      body,
    ]);
    host.appendChild(block);

    if (!item.repeat) {
      const children = buildItems(item.children, scope, body);
      return {
        refresh() {
          const relevant = evaluateOr(item.relevant, scope, null, true);
          const shown = relevant && relevant.unevaluated === undefined
            ? helpers.toBoolean(relevant) : true;
          block.hidden = !shown;
          heading.textContent = substitute(text(item.label) || item.name, scope);
          if (shown) children.forEach((c) => c.refresh());
        },
        collect(out) { children.forEach((c) => c.collect(out)); },
      };
    }

    // A roster: rows the interviewer adds, a count, or one per listed item.
    const rows = [];
    const scopes = [];
    repeats.set(item.name, scopes);
    const rowHost = el('div');
    const controls = el('div', { class: 'preview-repeat-controls' });
    body.appendChild(rowHost);
    body.appendChild(controls);

    let counter = 0;
    function addRow() {
      counter += 1;
      const rowScope = Object.create(null);
      rowScope.__id = `${item.name}-${counter}`;
      const wrapper = el('div', { class: 'preview-repeat-row' });
      const header = el('div', { class: 'preview-repeat-head' }, [
        el('span', { class: 'small muted', text: `${text(item.label) || item.name} ${rows.length + 1}` }),
        el('div', { style: 'flex:1' }),
      ]);
      const remove = el('button', { class: 'mini danger', text: 'Remove', onclick: () => {
        const at = rows.findIndex((r) => r.wrapper === wrapper);
        if (at !== -1) { rows.splice(at, 1); scopes.splice(at, 1); wrapper.remove(); refreshAll(); }
      } });
      header.appendChild(remove);
      wrapper.appendChild(header);
      const inner = el('div');
      wrapper.appendChild(inner);
      rowHost.appendChild(wrapper);
      const children = buildItems(item.children, rowScope, inner);
      rows.push({ wrapper, scope: rowScope, children, remove, header });
      scopes.push(rowScope);
    }

    controls.appendChild(el('button', { class: 'mini', text: '+ Add row', onclick: () => {
      addRow(); refreshAll();
    } }));
    addRow();

    return {
      refresh() {
        const relevant = evaluateOr(item.relevant, scope, null, true);
        const shown = relevant && relevant.unevaluated === undefined
          ? helpers.toBoolean(relevant) : true;
        block.hidden = !shown;
        if (!shown) return;

        const source = item.source || (item.repeatCount ? 'count' : 'manual');
        const listRows = source === 'list' ? repeats.get(item.sourceList) : null;

        let wanted = null;
        if (source === 'list') {
          wanted = listRows ? listRows.length : 0;
        } else if (source === 'count') {
          const counted = evaluateOr(item.repeatCount, scope, null, null);
          if (counted !== null && counted !== undefined
              && counted.unevaluated === undefined && !Number.isNaN(helpers.toNumber(counted))) {
            wanted = Math.max(0, Math.trunc(helpers.toNumber(counted)));
          }
        }

        const fixed = wanted !== null;
        if (fixed) {
          while (rows.length < wanted) addRow();
          while (rows.length > wanted) { rows.pop().wrapper.remove(); scopes.pop(); }
        }
        controls.hidden = fixed;

        rows.forEach((row, index) => {
          row.scope.__position = index + 1;
          row.remove.hidden = fixed;

          // A roster driven by a list carries that item's text into the row.
          let caption = `${text(item.label) || item.name} ${index + 1}`;
          if (source === 'list' && listRows) {
            const listItem = listRows[index];
            const value = listItem ? listItem[`${item.sourceList}_item`] : null;
            row.scope[`${item.name}_item`] = value ?? null;
            if (!helpers.isBlank(value)) caption = String(value);
          }
          row.header.firstChild.textContent = caption;
          row.children.forEach((c) => c.refresh());
        });
      },
      collect(out) { rows.forEach((row) => row.children.forEach((c) => c.collect(out))); },
    };
  }

  function buildQuestion(item, scope, host) {
    const labelText = el('span');
    const label = el('div', { class: 'q-label' }, [
      labelText,
      item.required ? el('span', { class: 'req', text: ' *' }) : null,
    ]);
    const hint = el('div', { class: 'q-hint' });
    const feedback = el('div', { class: 'q-feedback' });
    const control = renderInput(item, scope, () => refreshAll());

    const block = el('div', { class: 'preview-q' }, [label, hint, control, feedback]);
    block.dataset.name = item.name;
    host.appendChild(block);

    const touched = () => state.showAll
      || (control && control.dataset && control.dataset.touched === '1')
      || !helpers.isBlank(scope[item.name]);

    return {
      refresh() {
        const relevant = evaluateOr(item.relevant, scope, scope[item.name], true);
        const unreadable = relevant && relevant.unevaluated !== undefined;
        const shown = unreadable ? true : helpers.toBoolean(relevant);
        block.hidden = !shown;
        if (!shown) {
          // ODK clears answers to questions that stop being relevant.
          if (!helpers.isBlank(scope[item.name])) delete scope[item.name];
          return;
        }

        labelText.textContent = substitute(text(item.label) || item.name, scope);
        const hintText = substitute(text(item.hint), scope);
        hint.textContent = hintText;
        hint.hidden = hintText === '';

        if (item.type === 'calculate') {
          const computed = evaluateOr(item.calculation, scope, null, '');
          const value = computed && computed.unevaluated !== undefined ? '' : computed;
          scope[item.name] = value;
          if (control) {
            control.textContent = computed && computed.unevaluated !== undefined
              ? `not evaluated here (${computed.unevaluated})`
              : `= ${helpers.toStringValue(value)}`;
          }
        }

        clear(feedback);
        if (unreadable) {
          feedback.appendChild(el('div', { class: 'q-note', text:
            `Relevance not checked here (${relevant.unevaluated}).` }));
        }
        const result = check(item, scope);
        for (const note of result.notes) {
          feedback.appendChild(el('div', { class: 'q-note', text: note }));
        }
        if (touched()) {
          for (const message of result.errors) {
            feedback.appendChild(el('div', { class: 'q-error', text: message }));
          }
          for (const message of result.warnings) {
            feedback.appendChild(el('div', { class: 'q-warning', text: message }));
          }
        }
        block.classList.toggle('has-error', touched() && result.errors.length > 0);
        block.classList.toggle('has-warning', touched() && result.warnings.length > 0);
      },
      collect(out) {
        if (block.hidden || item.kind !== 'question') return;
        const result = check(item, scope);
        out.errors += result.errors.length;
        out.warnings += result.warnings.length;
        if (result.errors.length && !out.first) out.first = block;
      },
    };
  }

  // -- assembly -----------------------------------------------------------

  const form = el('div', { class: 'preview-form' });

  // Built once: rebuilding these on every keystroke would detach the buttons
  // from under the pointer mid-click.
  const tallyPill = el('span', { class: 'pill ok', text: 'No problems' });
  const summary = el('div', { class: 'preview-summary' }, [
    tallyPill,
    el('div', { style: 'flex:1' }),
    el('button', { class: 'mini', text: 'Check answers', onclick: () => {
      state.showAll = true;
      const tally = refreshAll();
      if (tally.first) tally.first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } }),
    el('button', { class: 'mini', text: 'Start over', onclick: () => {
      close();
      openPreview(doc, state.language);
    } }),
  ]);

  function refreshAll() {
    state.controllers.forEach((c) => c.refresh());
    const tally = { errors: 0, warnings: 0, first: null };
    state.controllers.forEach((c) => c.collect(tally));

    tallyPill.textContent = tally.errors
      ? `${tally.errors} error${tally.errors > 1 ? 's' : ''} to fix`
      : (tally.warnings ? `${tally.warnings} warning${tally.warnings > 1 ? 's' : ''}` : 'No problems');
    tallyPill.className = `pill ${tally.errors ? 'err' : (tally.warnings ? 'warn' : 'ok')}`;
    return tally;
  }

  state.controllers = buildItems(doc.items, top, form);

  const body = el('div', {}, [
    summary,
    doc.items.length ? form : el('div', { class: 'empty', text: 'Nothing to preview yet.' }),
    el('p', { class: 'small muted', style: 'margin-top:16px', text:
      'This is a simulation for checking wording and logic. Expressions it cannot read are '
      + 'reported on the question and still sent to Central unchanged. Publish a draft and open '
      + 'it in Central to test on a real device.' }),
  ]);

  const close = modal({
    title: `Preview — ${doc.title}`,
    body,
    wide: true,
    actions: (dismiss) => [el('button', { text: 'Close', onclick: dismiss })],
  });

  refreshAll();
  return close;
}
