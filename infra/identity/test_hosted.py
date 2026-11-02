"""Hosted realm policy and request-boundary checks; no real credentials required."""
import json
from pathlib import Path
import unittest
import urllib.request
from unittest.mock import patch

from configure_hosted import CLIENT_SECRETS, NoRedirect, apply_realm, hosted_realm


def environment():
    env = {
        'IDENTITY_PUBLIC_URL': 'https://identity.example.com',
        'GROWTH_FRONTEND_URL': 'https://growth.example.com',
        'AGENCY_FRONTEND_URL': 'https://agency.example.com',
        'AGENTS_FRONTEND_URL': 'https://agents.example.com',
        'ADMIN_FRONTEND_URL': 'https://admin.example.com',
        'GROWTH_BACKEND_URL': 'https://growth-api.example.com',
        'AGENCY_BACKEND_URL': 'https://agency-api.example.com',
        'AGENTS_BACKEND_URL': 'https://agents-api.example.com',
        'IDENTITY_SMTP_HOST': 'smtp.example.com', 'IDENTITY_SMTP_PORT': '465',
        'IDENTITY_SMTP_FROM': 'accounts@example.com', 'IDENTITY_SMTP_SSL': 'true',
        'IDENTITY_SMTP_USERNAME': 'sender', 'IDENTITY_SMTP_PASSWORD': 'smtp-password',
    }
    for index, key in enumerate(CLIENT_SECRETS.values()):
        env[key] = str(index) + '-independent-test-secret-' + ('x' * 32)
    return env


class HostedIdentityTests(unittest.TestCase):
    def test_managed_callbacks_have_no_local_development_destinations(self):
        env = environment()
        origin, realm = hosted_realm(env)
        self.assertEqual(origin, env['IDENTITY_PUBLIC_URL'])
        self.assertNotIn('localhost', json.dumps(realm))
        self.assertNotIn('${', json.dumps(realm))
        self.assertEqual(realm['webAuthnPolicyPasswordlessRpId'], 'identity.example.com')
        clients = {c['clientId']: c for c in realm['clients']}
        self.assertEqual(clients['agency-partner']['redirectUris'],
                         ['https://agency.example.com/api/tenant/api/partner/auth/callback'])
        self.assertEqual(clients['growth']['attributes']['backchannel.logout.url'],
                         'https://growth-api.example.com/api/auth/backchannel-logout')
        self.assertTrue(realm['verifyEmail'])
        self.assertFalse(next(a for a in realm['requiredActions'] if a['alias'] == 'CONFIGURE_TOTP')['defaultAction'])
        self.assertFalse(clients['agents']['directAccessGrantsEnabled'])
        self.assertFalse(clients['labs-admin']['serviceAccountsEnabled'])
        self.assertFalse(realm['identityProviders'][0]['enabled'])

    def test_reject_untrusted_origins_before_admin_credentials_are_sent(self):
        for invalid in ['http://identity.example.com', 'https://user:pass@identity.example.com',
                        'https://localhost', 'https://identity.railway.internal',
                        'https://identity.example.com/admin', 'https://identity.example.com?x=1']:
            with self.subTest(invalid=invalid):
                env = environment(); env['IDENTITY_PUBLIC_URL'] = invalid
                with self.assertRaisesRegex(RuntimeError, 'IDENTITY_PUBLIC_URL'):
                    hosted_realm(env)

    def test_external_encrypted_smtp_and_independent_secrets_required(self):
        env = environment(); env['IDENTITY_SMTP_SSL'] = 'false'
        with self.assertRaisesRegex(RuntimeError, 'SMTP'):
            hosted_realm(env)
        env = environment(); env['AGENTS_OIDC_CLIENT_SECRET'] = env['GROWTH_OIDC_CLIENT_SECRET']
        with self.assertRaisesRegex(RuntimeError, 'independent'):
            hosted_realm(env)
        env = environment(); env['IDENTITY_GOOGLE_ENABLED'] = 'true'
        with self.assertRaisesRegex(RuntimeError, 'Google'):
            hosted_realm(env)

    def test_admin_redirects_cannot_forward_credentials(self):
        request = urllib.request.Request('https://identity.example.com/admin', data=b'credential')
        with self.assertRaisesRegex(RuntimeError, 'redirects'):
            NoRedirect().redirect_request(request, None, 307, '', {}, 'https://elsewhere.example.com')

    def test_revocation_roles_only_assigned_to_managed_service_accounts(self):
        env = environment(); _, realm = hosted_realm(env)
        clients = {c['clientId']: {**c, 'id': c['clientId'] + '-id'} for c in realm['clients']}
        clients['realm-management'] = {'id': 'management-id', 'clientId': 'realm-management'}
        calls = []
        def admin(path, method='GET', body=None):
            calls.append((path, method, body))
            if method != 'GET': return None
            if not path: return {'realm': 'kasitek'}
            if path == 'clients': return list(clients.values())
            if path == 'client-scopes': return [{'id': s['name'], 'name': s['name']} for s in realm['clientScopes']]
            if path.endswith('/service-account-user'): return {'id': path.split('/')[1] + '-user'}
            if path == 'clients/management-id/roles/manage-users': return {'id': 'manage-users-id', 'name': 'manage-users'}
            if path.startswith('clients/') and len(path.split('/')) == 2:
                return next(c for c in clients.values() if c['id'] == path.split('/')[1])
            if path == 'authentication/flows/browser/executions':
                return [{'id': 'recovery', 'providerId': 'auth-recovery-authn-code-form'}]
            return []
        with patch('configure_hosted.configure_agents_clients'), patch('configure_hosted.configure_labs_admin_client'):
            apply_realm(admin, realm, env)
        grants = [c for c in calls if '/role-mappings/clients/' in c[0]]
        self.assertEqual({g[0] for g in grants}, {
            'users/growth-session-admin-id-user/role-mappings/clients/management-id',
            'users/agency-partner-session-admin-id-user/role-mappings/clients/management-id'})
        self.assertTrue(all(g[2] == [{'id': 'manage-users-id', 'name': 'manage-users'}] for g in grants))
        self.assertFalse(any(c[0].startswith('users/') and c[1] == 'DELETE' for c in calls))


if __name__ == '__main__':
    unittest.main()
