// The administrator's screen: create Central accounts and say what each person
// may do in a project.
//
// Accounts and roles live in Central. Studio only offers them in one place, and
// Central refuses anything the signed-in administrator may not do.

import { api } from './api.js';
import { clear, el, field, input, modal, select, spinner, toast } from './ui.js';

// The two roles that matter for the administrator/supervisor split, described
// in terms of what they let a person do rather than by their Central name.
const ROLE_NOTES = {
  manager: 'Can review, approve and reject submissions, and manage this project’s forms.',
  viewer: 'Can see submissions and download data, but cannot review them.',
  formfill: 'Can fill in forms on a device. Not a web account.',
};

export function createPeople(ctx) {
  const state = { users: [], roles: [], assignments: [] };
  const root = el('div');
  const usersHost = el('div', { class: 'panel' });
  const projectHost = el('div', { class: 'panel' });

  async function load() {
    clear(usersHost);
    usersHost.appendChild(el('div', { class: 'empty' }, [spinner(), ' Loading accounts…']));
    try {
      const [people, assignments] = await Promise.all([
        api.people(),
        api.projectPeople(ctx.project.id),
      ]);
      state.users = people.users;
      state.roles = people.roles;
      state.assignments = assignments;
    } catch (error) {
      clear(usersHost);
      usersHost.appendChild(el('div', { class: 'empty', text: error.message }));
      return;
    }
    render();
  }

  const roleName = (roleId) => {
    const role = state.roles.find((r) => r.id === roleId);
    return role ? role.name : `role ${roleId}`;
  };

  function render() {
    clear(usersHost);
    usersHost.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { text: 'Accounts' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'primary', text: 'New account', onclick: newAccount }),
    ]));

    const tbody = el('tbody');
    for (const user of state.users) {
      const assignment = state.assignments.find((a) => a.actorId === user.id);
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [
          el('div', { text: user.displayName || user.email }),
          el('div', { class: 'small muted', text: user.email }),
        ]),
        el('td', {}, [
          assignment
            ? el('span', { class: 'pill ok', text: roleName(assignment.roleId) })
            : el('span', { class: 'pill', text: 'no role here' }),
        ]),
        el('td', { style: 'width:230px' }, [
          el('button', { class: 'mini', text: assignment ? 'Change role' : 'Give a role',
            onclick: () => changeRole(user, assignment) }),
          assignment ? el('button', {
            class: 'mini danger', style: 'margin-left:6px', text: 'Remove',
            onclick: () => revoke(user, assignment),
          }) : null,
        ]),
      ]));
    }

    usersHost.appendChild(el('table', { class: 'grid' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Person' }),
        el('th', { text: `Role in ${ctx.project.name}` }),
        el('th', { text: '' }),
      ])]),
      tbody,
    ]));

    clear(projectHost);
    projectHost.appendChild(el('div', { class: 'panel-head' }, [el('h2', { text: 'What the roles mean' })]));
    const notes = el('div', { class: 'panel-body' });
    for (const role of state.roles) {
      notes.appendChild(el('div', { style: 'margin-bottom:12px' }, [
        el('div', { style: 'font-weight:500', text: role.name }),
        el('div', { class: 'small muted', text: ROLE_NOTES[role.system] || '' }),
      ]));
    }
    notes.appendChild(el('p', { class: 'small muted', text:
      'Central has no review-only role: the ability to approve and reject comes with '
      + 'Project Manager, which also allows editing this project’s forms. Roles and '
      + 'accounts are Central’s, so anything changed here shows up in Central too.' }));
    projectHost.appendChild(notes);
  }

  function newAccount() {
    const email = input('', () => {}, { type: 'email', placeholder: 'name@example.org' });
    const password = input('', () => {}, { type: 'password', placeholder: 'at least 10 characters' });
    let role = 'manager';

    modal({
      title: 'New account',
      body: el('div', {}, [
        field('Email', email, 'this is the sign-in name'),
        field('Password', password, 'leave blank to have Central email them a set-up link'),
        field(`Role in ${ctx.project.name}`, select(
          [{ value: '', label: 'No role for now' },
            ...state.roles.map((r) => ({ value: r.system, label: r.name }))],
          role, (v) => { role = v; },
        )),
        el('p', { class: 'small muted', text: 'The account is created in Central and can sign in to both Central and Studio.' }),
      ]),
      actions: (close) => [
        el('button', { text: 'Cancel', onclick: close }),
        el('button', { class: 'primary', text: 'Create', onclick: async (event) => {
          const address = email.value.trim();
          if (!address) { toast('An email address is required.', 'error'); return; }
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = 'Creating…';
          try {
            const result = await api.createPerson({
              email: address,
              password: password.value || null,
              projectId: role ? ctx.project.id : null,
              role: role || null,
            });
            close();
            toast(result.warning || `Account created for ${address}`, result.warning ? 'error' : 'ok');
            load();
          } catch (error) {
            button.disabled = false;
            button.textContent = 'Create';
            toast(error.message, 'error');
          }
        } }),
      ],
    });
  }

  function changeRole(user, assignment) {
    let role = state.roles[0]?.system || 'manager';
    modal({
      title: `Role for ${user.displayName || user.email}`,
      body: el('div', {}, [
        field(`Role in ${ctx.project.name}`, select(
          state.roles.map((r) => ({ value: r.system, label: r.name })), role, (v) => { role = v; },
        )),
        el('p', { class: 'small muted', text: ROLE_NOTES[role] || '' }),
      ]),
      actions: (close) => [
        el('button', { text: 'Cancel', onclick: close }),
        el('button', { class: 'primary', text: 'Save', onclick: async () => {
          try {
            // Replacing a role means clearing the old one first.
            if (assignment) {
              const previous = state.roles.find((r) => r.id === assignment.roleId);
              if (previous) await api.revokeRole(ctx.project.id, user.id, previous.system);
            }
            await api.grantRole(ctx.project.id, user.id, role);
            close();
            toast('Role updated', 'ok');
            load();
          } catch (error) { toast(error.message, 'error'); }
        } }),
      ],
    });
  }

  async function revoke(user, assignment) {
    const role = state.roles.find((r) => r.id === assignment.roleId);
    if (!role) return;
    try {
      await api.revokeRole(ctx.project.id, user.id, role.system);
      toast('Role removed', 'ok');
      load();
    } catch (error) { toast(error.message, 'error'); }
  }

  root.appendChild(usersHost);
  root.appendChild(el('div', { style: 'height:18px' }));
  root.appendChild(projectHost);
  load();
  return root;
}
