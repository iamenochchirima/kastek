#!/usr/bin/env python3
"""Apply local runtime settings without printing admin or provider secrets."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


def environment():
    values = {}
    for line in (Path(__file__).parent / '.env').read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip()
    return {**values, **os.environ}


def configure():
    env = environment()
    base = 'http://localhost:8080'
    credentials = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli',
        'username': env['KEYCLOAK_ADMIN'], 'password': env['KEYCLOAK_ADMIN_PASSWORD']}).encode()
    request = urllib.request.Request(base + '/realms/master/protocol/openid-connect/token', data=credentials)
    with urllib.request.urlopen(request, timeout=15) as response:
        token = json.load(response)['access_token']

    def admin(path, method='GET', body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + '/admin/realms/kasitek/' + path, data=data,
            method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as response:
            content = response.read()
            return json.loads(content) if content else None

    template = json.loads((Path(__file__).parent / 'kasitek-realm.json').read_text())
    scopes = {item['name']: item for item in admin('client-scopes')}
    for desired in template['clientScopes']:
        if desired['name'] not in scopes:
            admin('client-scopes', 'POST', desired)
            scopes = {item['name']: item for item in admin('client-scopes')}
        scope = scopes[desired['name']]
        endpoint = 'client-scopes/' + scope['id'] + '/protocol-mappers/models'
        current = {item['name']: item for item in admin(endpoint)}
        for mapper in desired['protocolMappers']:
            if mapper['name'] in current:
                mapper = {**mapper, 'id': current[mapper['name']]['id']}
                admin(endpoint + '/' + mapper['id'], 'PUT', mapper)
            else:
                admin(endpoint, 'POST', mapper)
    executions = admin('authentication/flows/browser/executions')
    recovery = [item for item in executions if item.get('providerId') == 'auth-recovery-authn-code-form']
    if len(recovery) != 1:
        raise RuntimeError('Expected one recovery-code execution in the pinned Keycloak browser flow')
    execution = recovery[0]
    admin('authentication/flows/browser/executions', 'PUT', {'id': execution['id'], 'requirement': 'ALTERNATIVE'})
    provider = admin('identity-provider/instances/google')
    google_ready = bool(env.get('GOOGLE_CLIENT_ID') and env.get('GOOGLE_CLIENT_SECRET'))
    provider['enabled'] = google_ready
    provider['config']['clientId'] = env.get('GOOGLE_CLIENT_ID', '')
    provider['config']['clientSecret'] = env.get('GOOGLE_CLIENT_SECRET', '')
    admin('identity-provider/instances/google', 'PUT', provider)
    clients = admin('clients')
    by_name = {client['clientId']: client for client in clients}
    if 'growth-session-admin' not in by_name:
        admin('clients', 'POST', {'clientId': 'growth-session-admin', 'name': 'Growth session revocation',
            'protocol': 'openid-connect', 'enabled': True, 'publicClient': False,
            'secret': env['GROWTH_SESSION_ADMIN_SECRET'], 'standardFlowEnabled': False,
            'directAccessGrantsEnabled': False, 'serviceAccountsEnabled': True})
        by_name = {client['clientId']: client for client in admin('clients')}
    for client_id, secret_key in [('growth', 'GROWTH_OIDC_CLIENT_SECRET'), ('growth-session-admin', 'GROWTH_SESSION_ADMIN_SECRET')]:
        current = admin('clients/' + by_name[client_id]['id'])
        current['secret'] = env[secret_key]
        admin('clients/' + current['id'], 'PUT', current)
    for scope_name in template['clients'][0]['defaultClientScopes']:
        admin('clients/' + by_name['growth']['id'] + '/default-client-scopes/' + scopes[scope_name]['id'], 'PUT')
    service_client = by_name['growth-session-admin']
    service_user = admin('clients/' + service_client['id'] + '/service-account-user')
    management = by_name['realm-management']
    role = admin('clients/' + management['id'] + '/roles/manage-users')
    admin('users/' + service_user['id'] + '/role-mappings/clients/' + management['id'], 'POST', [role])
    realm = admin('')
    for key in ['eventsEnabled', 'eventsExpiration', 'enabledEventTypes']:
        realm[key] = template[key]
    admin('', 'PUT', realm)
    assert realm['registrationAllowed'] and realm['verifyEmail'] and realm['resetPasswordAllowed']
    assert realm['ssoSessionIdleTimeout'] == 604800 and realm['ssoSessionMaxLifespan'] == 2592000
    assert realm['webAuthnPolicyPasswordlessPasskeysEnabled']
    actions = {a['alias']: a for a in admin('authentication/required-actions')}
    if 'delete_credential' not in actions:
        admin('authentication/register-required-action', 'POST', {'providerId': 'delete_credential', 'name': 'Delete Credential'})
        actions = {a['alias']: a for a in admin('authentication/required-actions')}
    delete_action = actions['delete_credential']
    delete_action['enabled'] = True
    delete_action['defaultAction'] = False
    admin('authentication/required-actions/delete_credential', 'PUT', delete_action)
    assert actions['CONFIGURE_RECOVERY_AUTHN_CODES']['enabled']
    assert not actions['CONFIGURE_TOTP']['defaultAction']
    assert actions['CONFIGURE_TOTP']['config'].get('add-recovery-codes') == 'true'
    print('Realm checked; optional OTP and recovery-code flow configured.')
    print('Google enabled.' if google_ready else 'Google remains disabled until development OAuth credentials are supplied.')


if __name__ == '__main__':
    try:
        configure()
    except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError, AssertionError) as error:
        # Never output response bodies containing secrets or request payloads.
        raise SystemExit('Identity configuration failed: ' + type(error).__name__)
