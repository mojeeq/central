"""Permissions, submission review, and account management.

Studio grants nothing of its own: every check here is really a check that it
asks Central and honours the answer.
"""

import pytest
from fastapi.testclient import TestClient

from studio import central, db
from studio.central import CentralError
from studio.main import app

# Three accounts with different rights, as Central would report them.
ADMIN = {"id": 1, "displayName": "Ada", "email": "ada@example.org"}
SUPERVISOR = {"id": 2, "displayName": "Sam", "email": "sam@example.org"}
VIEWER = {"id": 3, "displayName": "Vic", "email": "vic@example.org"}

SITEWIDE = {
    "admin-token": ["user.create", "assignment.create", "project.create", "form.create"],
    "supervisor-token": [],
    "viewer-token": [],
}
PROJECT_VERBS = {
    "admin-token": ["project.read", "form.create", "submission.read", "submission.update"],
    "supervisor-token": ["project.read", "form.list", "submission.read", "submission.update"],
    "viewer-token": ["project.read", "form.list", "submission.read"],
}
USERS = {"admin-token": ADMIN, "supervisor-token": SUPERVISOR, "viewer-token": VIEWER}


@pytest.fixture(autouse=True)
def stub_central(monkeypatch):
    state = {
        "reviews": {},
        "created": [],
        "assignments": [],
    }

    def current_user(self, extended=False):
        user = USERS.get(self.token)
        if user is None:
            raise CentralError(401, "expired")
        return {**user, "verbs": SITEWIDE[self.token]} if extended else dict(user)

    def projects(self):
        current_user(self)
        return [{"id": 1, "name": "Census"}]

    def project_verbs(self, project_id):
        return PROJECT_VERBS[self.token]

    def submissions(self, project_id, xml_form_id):
        return [
            {"instanceId": "uuid:a", "createdAt": "2026-08-01T00:00:00Z",
             "updatedAt": None, "reviewState": state["reviews"].get("uuid:a"),
             "deviceId": "d1", "submitter": {"displayName": "Field 1"}},
            {"instanceId": "uuid:b", "createdAt": "2026-08-02T00:00:00Z",
             "updatedAt": None, "reviewState": state["reviews"].get("uuid:b"),
             "deviceId": "d2", "submitter": {"displayName": "Field 2"}},
            {"instanceId": "uuid:gone", "createdAt": "2026-08-03T00:00:00Z",
             "deletedAt": "2026-08-04T00:00:00Z", "reviewState": None,
             "submitter": {"displayName": "Field 3"}},
        ]

    def review_submission(self, project_id, xml_form_id, instance_id, review_state):
        state["reviews"][instance_id] = review_state
        return {"instanceId": instance_id, "reviewState": review_state}

    def users(self):
        return [ADMIN, SUPERVISOR, VIEWER]

    def create_user(self, email, password=None):
        created = {"id": 99, "email": email, "displayName": email}
        state["created"].append(created)
        return created

    def roles(self):
        return [
            {"id": 4, "system": "manager", "name": "Project Manager"},
            {"id": 5, "system": "viewer", "name": "Project Viewer"},
            {"id": 6, "system": "formfill", "name": "Data Collector"},
            {"id": 1, "system": "admin", "name": "Administrator"},
        ]

    def assign_role(self, project_id, role, actor_id):
        state["assignments"].append((project_id, role, actor_id))

    def revoke_role(self, project_id, role, actor_id):
        state["assignments"] = [
            a for a in state["assignments"] if a != (project_id, role, actor_id)
        ]

    def project_assignments(self, project_id):
        return [{"actorId": 2, "roleId": 4, "actor": {"id": 2, "displayName": "Sam"}}]

    for name, fn in [
        ("current_user", current_user), ("projects", projects),
        ("project_verbs", project_verbs), ("submissions", submissions),
        ("review_submission", review_submission), ("users", users),
        ("create_user", create_user), ("roles", roles),
        ("assign_role", assign_role), ("revoke_role", revoke_role),
        ("project_assignments", project_assignments),
    ]:
        monkeypatch.setattr(central.Client, name, fn)

    db.init()
    yield state


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def auth(token):
    return {"Authorization": f"Bearer {token}"}


# -- who am I --------------------------------------------------------------


def test_only_a_central_administrator_is_reported_as_one(client):
    assert client.get("/studio/api/me", headers=auth("admin-token")).json()["isAdministrator"]
    assert not client.get("/studio/api/me", headers=auth("supervisor-token")).json()["isAdministrator"]


def test_permissions_follow_the_project_role(client):
    supervisor = client.get("/studio/api/projects/1/permissions", headers=auth("supervisor-token")).json()
    assert supervisor["canReview"] is True
    assert supervisor["canSeeSubmissions"] is True
    assert supervisor["canDesign"] is False, "a supervisor does not build forms"

    viewer = client.get("/studio/api/projects/1/permissions", headers=auth("viewer-token")).json()
    assert viewer["canSeeSubmissions"] is True
    assert viewer["canReview"] is False

    admin = client.get("/studio/api/projects/1/permissions", headers=auth("admin-token")).json()
    assert admin["canDesign"] and admin["canReview"] and admin["isAdministrator"]


# -- reviewing -------------------------------------------------------------


def test_a_supervisor_sees_the_submissions_and_may_review(client):
    response = client.get("/studio/api/projects/1/forms/f/submissions", headers=auth("supervisor-token"))
    body = response.json()
    assert body["canReview"] is True
    assert [s["instanceId"] for s in body["submissions"]] == ["uuid:a", "uuid:b"], \
        "deleted submissions are left out"
    assert body["submissions"][0]["submitter"] == "Field 1"


def test_a_viewer_sees_them_but_cannot_review(client):
    body = client.get("/studio/api/projects/1/forms/f/submissions", headers=auth("viewer-token")).json()
    assert body["canReview"] is False

    refused = client.post(
        "/studio/api/projects/1/forms/f/submissions/uuid:a/review",
        headers=auth("viewer-token"), json={"reviewState": "approved"},
    )
    assert refused.status_code == 403


@pytest.mark.parametrize("state", ["approved", "hasIssues", "rejected"])
def test_review_states_are_passed_through(client, state):
    response = client.post(
        "/studio/api/projects/1/forms/f/submissions/uuid:a/review",
        headers=auth("supervisor-token"), json={"reviewState": state},
    )
    assert response.status_code == 200
    assert response.json()["reviewState"] == state

    listed = client.get("/studio/api/projects/1/forms/f/submissions", headers=auth("supervisor-token")).json()
    assert listed["submissions"][0]["reviewState"] == state


def test_a_review_can_be_cleared(client):
    client.post("/studio/api/projects/1/forms/f/submissions/uuid:a/review",
                headers=auth("supervisor-token"), json={"reviewState": "approved"})
    client.post("/studio/api/projects/1/forms/f/submissions/uuid:a/review",
                headers=auth("supervisor-token"), json={"reviewState": "null"})
    listed = client.get("/studio/api/projects/1/forms/f/submissions", headers=auth("supervisor-token")).json()
    assert listed["submissions"][0]["reviewState"] is None


def test_an_unknown_review_state_is_refused(client):
    response = client.post(
        "/studio/api/projects/1/forms/f/submissions/uuid:a/review",
        headers=auth("supervisor-token"), json={"reviewState": "sideways"},
    )
    assert response.status_code == 400


# -- accounts --------------------------------------------------------------


def test_only_an_administrator_manages_accounts(client):
    assert client.get("/studio/api/people", headers=auth("admin-token")).status_code == 200
    for token in ("supervisor-token", "viewer-token"):
        assert client.get("/studio/api/people", headers=auth(token)).status_code == 403
        assert client.post("/studio/api/people", headers=auth(token),
                           json={"email": "x@y.z"}).status_code == 403


def test_the_role_list_offers_only_assignable_project_roles(client):
    roles = client.get("/studio/api/people", headers=auth("admin-token")).json()["roles"]
    assert {r["system"] for r in roles} == {"manager", "viewer", "formfill"}, \
        "the sitewide Administrator role is not a project assignment"


def test_creating_an_account_can_assign_a_role_at_once(client, stub_central):
    response = client.post(
        "/studio/api/people", headers=auth("admin-token"),
        json={"email": "new@example.org", "password": "a-long-password", "projectId": 1, "role": "manager"},
    )
    assert response.status_code == 201
    assert response.json()["assignedRole"] == "manager"
    assert stub_central["created"][0]["email"] == "new@example.org"
    assert stub_central["assignments"] == [(1, "manager", 99)]


def test_a_failed_assignment_still_reports_the_created_account(client, monkeypatch):
    def refuse(self, project_id, role, actor_id):
        raise CentralError(403, "not allowed")
    monkeypatch.setattr(central.Client, "assign_role", refuse)

    response = client.post(
        "/studio/api/people", headers=auth("admin-token"),
        json={"email": "new@example.org", "projectId": 1, "role": "manager"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["assignedRole"] is None
    assert "was created" in body["warning"]


def test_roles_can_be_granted_and_revoked(client, stub_central):
    assert client.post("/studio/api/projects/1/people", headers=auth("admin-token"),
                       json={"actorId": 7, "role": "viewer"}).status_code == 204
    assert (1, "viewer", 7) in stub_central["assignments"]

    assert client.request("DELETE", "/studio/api/projects/1/people", headers=auth("admin-token"),
                          json={"actorId": 7, "role": "viewer"}).status_code == 204
    assert (1, "viewer", 7) not in stub_central["assignments"]
