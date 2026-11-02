#!/usr/bin/env python3
"""Configure the owned hosted realm without loading local development settings."""
import copy
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

from configure import smtp_settings, configure_agents_clients, configure_labs_admin_client

CLIENT_SECRETS = {
    'growth': 'GROWTH_OIDC_CLIENT_SECRET',
    'growth-session-admin': 'GROWTH_SESSION_ADMIN_SECRET',
    'agency-partner': 'AGENCY_PARTNER_OIDC_CLIENT_SECRET',
    'agency-partner-session-admin': 'AGENCY_PARTNER_SESSION_ADMIN_SECRET',
    'agents': 'AGENTS_OIDC_CLIENT_SECRET',
    'agents-execution': 'AGENTS_EXECUTION_CLIENT_SECRET',
    'labs-admin': 'LABS_ADMIN_OIDC_CLIENT_SECRET',
}


def https_origin(env, key):
    value = env.get(key, '').strip()
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
    except ValueError:
        raise RuntimeError(key + ' must be a public HTTPS origin') from None
    if (url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.path not in ('', '/') or url.query or url.fragment
            or url.hostname in ('localhost', '127.0.0.1', '::1')
            or url.hostname.endswith(('.localhost', '.local', '.internal'))
            or (port is not None and not 1 <= port <= 65535)):
        raise RuntimeError(key + ' must be a public HTTPS origin')
    return value.rstrip('/')


def hosted_realm(env):
    """Preserve realm policies while replacing every development destination."""
    identity = https_origin(env, 'IDENTITY_PUBLIC_URL')
    origins = {name: https_origin(env, key) for name, key in (
        ('growth', 'GROWTH_FRONTEND_URL'), ('agency-partner', 'AGENCY_FRONTEND_URL'),
        ('agents', 'AGENTS_FRONTEND_URL'), ('labs-admin', 'ADMIN_FRONTEND_URL'))}
    backends = {name: https_origin(env, key) for name, key in (
        ('growth', 'GROWTH_BACKEND_URL'), ('agency-partner', 'AGENCY_BACKEND_URL'),
        ('agents', 'AGENTS_BACKEND_URL'))}
    secrets = []
    for key in CLIENT_SECRETS.values():
        value = env.get(key, '')
        if len(value) < 32 or value.startswith('replace-'):
            raise RuntimeError(key + ' must contain an independent secret of at least 32 characters')
        secrets.append(value)
    if len(set(secrets)) != len(secrets):
        raise RuntimeError('OIDC clients must use independent secrets')
    if env.get('KC_BOOTSTRAP_ADMIN_PASSWORD') in secrets:
        raise RuntimeError('Client secrets must differ from the bootstrap administrator password')
    realm = json.loads((Path(__file__).parent / 'kasitek-realm.json').read_text())
    realm['webAuthnPolicyPasswordlessRpId'] = urllib.parse.urlsplit(identity).hostname
    realm['smtpServer'] = smtp_settings(env, {})
    smtp = realm['smtpServer']
    if (not all(smtp.get(k) for k in ('host', 'port', 'from'))
            or smtp['host'] in ('localhost', '127.0.0.1', '::1')
            or not (smtp['ssl'] == 'true' or smtp['starttls'] == 'true')):
        raise RuntimeError('Hosted Identity requires external SMTP with SSL or STARTTLS')
    callbacks = {'growth': '/api/auth/callback', 'agents': '/api/auth/callback',
                 'agency-partner': '/api/tenant/api/partner/auth/callback',
                 'labs-admin': '/api/operations-auth/callback'}
    for client in realm['clients']:
        name = client['clientId']
        client['secret'] = env[CLIENT_SECRETS[name]]
        if name not in origins:
            continue
        origin = origins[name]
        client['redirectUris'] = [origin + callbacks[name]]
        client['webOrigins'] = [origin]
        attributes = client['attributes']
        attributes['post.logout.redirect.uris'] = origin + (
            '/login?audience=partner' if name == 'agency-partner' else '/login')
        logout_path = '/api/operations-auth/backchannel-logout' if name == 'labs-admin' else (
            '/api/partner/auth/backchannel-logout' if name == 'agency-partner' else '/api/auth/backchannel-logout')
        attributes['backchannel.logout.url'] = backends.get(name, origin) + logout_path
    google = realm['identityProviders'][0]
    google_enabled = env.get('IDENTITY_GOOGLE_ENABLED') == 'true'
    if google_enabled and not all(env.get(k) for k in ('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')):
        raise RuntimeError('Enabled Google identity requires both Google credentials')
    google['enabled'] = google_enabled
    google['config']['clientId'] = env.get('GOOGLE_CLIENT_ID', '')
    google['config']['clientSecret'] = env.get('GOOGLE_CLIENT_SECRET', '')
    return identity, realm


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError('Identity administration redirects are not permitted')


def apply_realm(admin, realm, env):
    """Reconcile managed clients and session roles; retain users and sessions."""
    current = admin('')
    desired = {key: copy.deepcopy(value) for key, value in realm.items()
               if key not in ('clients', 'roles', 'clientScopes', 'identityProviders', 'requiredActions')}
    current.update(desired)
    admin('', 'PUT', current)
    scopes = {item['name']: item for item in admin('client-scopes')}
    for scope in realm['clientScopes']:
        if scope['name'] not in scopes:
            admin('client-scopes', 'POST', scope)
            scopes = {item['name']: item for item in admin('client-scopes')}
        endpoint = 'client-scopes/' + scopes[scope['name']]['id'] + '/protocol-mappers/models'
        existing = {item['name']: item for item in admin(endpoint)}
        for mapper in scope.get('protocolMappers', []):
            if mapper['name'] in existing:
                admin(endpoint + '/' + existing[mapper['name']]['id'], 'PUT',
                      {**mapper, 'id': existing[mapper['name']]['id']})
            else:
                admin(endpoint, 'POST', mapper)
    clients = {item['clientId']: item for item in admin('clients')}
    for desired_client in realm['clients']:
        name = desired_client['clientId']
        if name in ('agents', 'agents-execution', 'labs-admin'):
            continue
        settings = {key: value for key, value in desired_client.items()
                    if key not in ('defaultClientScopes', 'optionalClientScopes')}
        if name not in clients:
            admin('clients', 'POST', settings)
            clients = {item['clientId']: item for item in admin('clients')}
        endpoint = 'clients/' + clients[name]['id']
        settings = {**admin(endpoint), **settings}
        admin(endpoint, 'PUT', settings)
        for kind, field in (('default', 'defaultClientScopes'), ('optional', 'optionalClientScopes')):
            if field not in desired_client:
                continue
            scope_path = endpoint + '/' + kind + '-client-scopes'
            for scope in admin(scope_path):
                if scope['name'] not in desired_client[field]:
                    admin(scope_path + '/' + scope['id'], 'DELETE')
            for scope_name in desired_client[field]:
                admin(scope_path + '/' + scopes[scope_name]['id'], 'PUT')
    configure_agents_clients(admin, realm, env, scopes)
    configure_labs_admin_client(admin, realm, env, scopes)
    clients = {item['clientId']: item for item in admin('clients')}
    management = clients['realm-management']['id']
    role = admin('clients/' + management + '/roles/manage-users')
    for name in ('growth-session-admin', 'agency-partner-session-admin'):
        service_user = admin('clients/' + clients[name]['id'] + '/service-account-user')
        admin('users/' + service_user['id'] + '/role-mappings/clients/' + management, 'POST', [role])
    provider = realm['identityProviders'][0]
    admin('identity-provider/instances/google', 'PUT', provider)
    executions = admin('authentication/flows/browser/executions')
    recovery = [item for item in executions if item.get('providerId') == 'auth-recovery-authn-code-form']
    if len(recovery) != 1:
        raise RuntimeError('Expected one recovery-code execution in the pinned browser flow')
    admin('authentication/flows/browser/executions', 'PUT',
          {'id': recovery[0]['id'], 'requirement': 'ALTERNATIVE'})


def configure(env):
    base, realm = hosted_realm(env)
    username = env.get('KC_BOOTSTRAP_ADMIN_USERNAME', '')
    password = env.get('KC_BOOTSTRAP_ADMIN_PASSWORD', '')
    if not username or len(password) < 32:
        raise RuntimeError('Set hosted bootstrap administrator credentials')
    opener = urllib.request.build_opener(NoRedirect())
    credentials = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli',
                                         'username': username, 'password': password}).encode()
    req = urllib.request.Request(base + '/realms/master/protocol/openid-connect/token', data=credentials)
    with opener.open(req, timeout=30) as response:
        token = json.load(response)['access_token']

    def request(path, method='GET', body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + '/admin/realms' + path, data=data, method=method,
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(req, timeout=30) as response:
            content = response.read()
            return json.loads(content) if content else None

    try:
        request('/kasitek')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        request('', 'POST', realm)

    def admin(path, method='GET', body=None):
        return request('/kasitek/' + path, method, body)

    apply_realm(admin, realm, env)
    verified = admin('')
    if not (verified['verifyEmail'] and verified['registrationAllowed']
            and verified['webAuthnPolicyPasswordlessRpId'] == realm['webAuthnPolicyPasswordlessRpId']):
        raise RuntimeError('Hosted realm policy verification failed')
    print('Hosted realm and managed clients configured; provider login and email delivery require live acceptance.')


if __name__ == '__main__':
    try:
        configure(dict(os.environ))
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, KeyError) as error:
        raise SystemExit('Hosted Identity configuration failed: ' + type(error).__name__)
    except RuntimeError as error:
        raise SystemExit('Hosted Identity configuration failed: ' + str(error))
