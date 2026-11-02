"""Offline checks for Agents identity configuration. No realm or secret access."""
import copy
import json
from pathlib import Path
import unittest

from configure import configure_agents_clients, validate_local_configuration


class Realm:
    def __init__(self, template):
        self.clients = {name: {'id': name + '-id', 'clientId': name, 'secret': 'untouched'}
                        for name in ('growth', 'agency-partner')}
        self.scopes = {item['name']: {'id': item['name'], 'name': item['name']}
                       for item in template['clientScopes']}
        self.roles = {}
        self.mappers = {}
        self.attached = {}
        self.calls = []

    def admin(self, path, method='GET', body=None):
        self.calls.append((path, method, copy.deepcopy(body)))
        if path == 'clients':
            if method == 'POST':
                self.clients[body['clientId']] = {**body, 'id': body['clientId'] + '-id'}
                return
            return list(self.clients.values())
        bits = path.split('/')
        if bits[0] == 'users':
            return
        client = next(item for item in self.clients.values() if item['id'] == bits[1])
        if len(bits) == 2:
            if method == 'PUT':
                self.clients[client['clientId']] = copy.deepcopy(body)
                return
            return copy.deepcopy(client)
        section = bits[2]
        if section in ('default-client-scopes', 'optional-client-scopes'):
            attached = self.attached.setdefault((client['id'], section), {})
            if len(bits) == 3:
                return list(attached.values())
            if method == 'DELETE':
                attached.pop(bits[3])
            else:
                attached[bits[3]] = self.scopes[bits[3]]
            return
        if section == 'protocol-mappers':
            mappers = self.mappers.setdefault(client['id'], {})
            if method == 'GET':
                return list(mappers.values())
            if method == 'DELETE':
                mappers.pop(bits[4])
            else:
                mapper_id = body.get('id', body['name'])
                mappers[mapper_id] = {**body, 'id': mapper_id}
            return
        if section == 'roles':
            if method == 'POST':
                self.roles[body['name']] = {**body, 'id': body['name']}
                return
            return list(self.roles.values()) if len(bits) == 3 else self.roles[bits[3]]
        if section == 'service-account-user':
            return {'id': 'agents-execution-service-user'}
        if section == 'scope-mappings':
            return
        raise AssertionError('Unexpected endpoint: ' + path)


class AgentsIdentityTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((Path(__file__).parent / 'kasitek-realm.json').read_text())
        self.realm = Realm(self.template)
        self.env = {'AGENTS_OIDC_CLIENT_SECRET': 'browser-test-secret',
                    'AGENTS_EXECUTION_CLIENT_SECRET': 'execution-test-secret'}

    def reconcile(self):
        configure_agents_clients(self.realm.admin, self.template, self.env, self.realm.scopes)

    def test_registration_restricts_browser_and_service_authority(self):
        original = copy.deepcopy(self.realm.clients)
        self.reconcile()
        browser = self.realm.clients['agents']
        self.assertEqual(browser['redirectUris'], ['http://localhost:3100/api/auth/callback'])
        self.assertEqual(browser['attributes']['pkce.code.challenge.method'], 'S256')
        self.assertFalse(browser['serviceAccountsEnabled'])
        execution = self.realm.clients['agents-execution']
        self.assertFalse(execution['fullScopeAllowed'])
        self.assertFalse(execution['standardFlowEnabled'])
        self.assertFalse(execution['directAccessGrantsEnabled'])
        self.assertEqual(execution['redirectUris'], [])
        for name in original:
            self.assertEqual(self.realm.clients[name], original[name])
        mappings = [(path, body) for path, method, body in self.realm.calls
                    if method == 'POST' and '/role-mappings/' in path]
        self.assertEqual(len(mappings), 1)
        self.assertTrue(mappings[0][0].endswith('/clients/agents-execution-id'))
        self.assertEqual(mappings[0][1][0]['name'], 'execute')
        self.assertNotIn('manage-users', json.dumps(self.realm.calls))

    def test_reconciliation_rotates_secrets_and_removes_extra_audiences(self):
        self.reconcile()
        self.env['AGENTS_EXECUTION_CLIENT_SECRET'] = 'rotated-test-secret'
        self.realm.attached[('agents-execution-id', 'optional-client-scopes')] = {
            'profile': self.realm.scopes['profile']}
        self.realm.mappers['agents-execution-id']['broad-audience'] = {
            'id': 'broad-audience', 'name': 'unwanted-audience'}
        self.reconcile()
        self.assertEqual(len(self.realm.clients), 4)
        self.assertEqual(self.realm.clients['agents-execution']['secret'], 'rotated-test-secret')
        self.assertEqual(self.realm.attached[('agents-execution-id', 'optional-client-scopes')], {})
        self.assertNotIn('broad-audience', self.realm.mappers['agents-execution-id'])
        mapper = self.realm.mappers['agents-execution-id']['agents-execution-audience']
        self.assertEqual(mapper['config']['included.client.audience'], 'agents-execution')

    def test_shared_client_secret_is_rejected_before_network_access(self):
        env = {name: name + '-test-value' for name in (
            'IDENTITY_DB_PASSWORD', 'KEYCLOAK_ADMIN', 'KEYCLOAK_ADMIN_PASSWORD',
            'GROWTH_OIDC_CLIENT_SECRET', 'GROWTH_SESSION_ADMIN_SECRET',
            'AGENCY_PARTNER_OIDC_CLIENT_SECRET', 'AGENCY_PARTNER_SESSION_ADMIN_SECRET',
            'AGENTS_OIDC_CLIENT_SECRET', 'AGENTS_EXECUTION_CLIENT_SECRET',
            'LABS_ADMIN_OIDC_CLIENT_SECRET')}
        env['AGENTS_EXECUTION_CLIENT_SECRET'] = env['AGENTS_OIDC_CLIENT_SECRET']
        with self.assertRaisesRegex(RuntimeError, 'must use an independent secret'):
            validate_local_configuration(env)

    def test_missing_secret_error_contains_names_only(self):
        with self.assertRaises(RuntimeError) as error:
            validate_local_configuration(self.env)
        self.assertIn('IDENTITY_DB_PASSWORD', str(error.exception))
        self.assertNotIn('browser-test-secret', str(error.exception))


if __name__ == '__main__':
    unittest.main()
