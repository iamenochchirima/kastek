#!/usr/bin/env python3
"""Apply local runtime settings without printing admin or provider secrets."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


def smtp_settings(env, defaults):
    """Build Keycloak SMTP settings, retaining Mailpit defaults when unset."""
    def boolean(key, default):
        value = env.get(key, default).strip().lower()
        if value in ('1', 'true', 'yes', 'on'):
            return True
        if value in ('0', 'false', 'no', 'off', ''):
            return False
        raise RuntimeError(key + ' must be true or false')

    result = dict(defaults)
    host = env.get('IDENTITY_SMTP_HOST', '').strip()
    port = env.get('IDENTITY_SMTP_PORT', '').strip()
    sender = env.get('IDENTITY_SMTP_FROM', '').strip()
    display_name = env.get('IDENTITY_SMTP_FROM_DISPLAY_NAME', '').strip()
    reply_to = env.get('IDENTITY_SMTP_REPLY_TO', '').strip()
    username = env.get('IDENTITY_SMTP_USERNAME', '').strip()
    password = env.get('IDENTITY_SMTP_PASSWORD', '')
    ssl = boolean('IDENTITY_SMTP_SSL', result.get('ssl', 'false'))
    starttls = boolean('IDENTITY_SMTP_STARTTLS', result.get('starttls', 'false'))

    if any((host, port, sender)) and not all((host, port, sender)):
        raise RuntimeError('Set IDENTITY_SMTP_HOST, IDENTITY_SMTP_PORT, and IDENTITY_SMTP_FROM together')
    if bool(username) != bool(password):
        raise RuntimeError('IDENTITY_SMTP_USERNAME and IDENTITY_SMTP_PASSWORD must be set together')
    if ssl and starttls:
        raise RuntimeError('Use either IDENTITY_SMTP_SSL or IDENTITY_SMTP_STARTTLS, not both')
    if (username or ssl or starttls) and not host:
        raise RuntimeError('Set IDENTITY_SMTP_HOST when enabling SMTP authentication or TLS')
    if username and not (ssl or starttls):
        raise RuntimeError('Authenticated SMTP requires SSL or STARTTLS')
    if host:
        result['host'] = host
    if port:
        if not port.isdecimal() or not 1 <= int(port) <= 65535:
            raise RuntimeError('IDENTITY_SMTP_PORT must be between 1 and 65535')
        result['port'] = str(int(port))
    if sender:
        result['from'] = sender
    if display_name:
        result['fromDisplayName'] = display_name
    if reply_to:
        result['replyTo'] = reply_to
    else:
        result.pop('replyTo', None)
    result['ssl'] = str(ssl).lower()
    result['starttls'] = str(starttls).lower()
    result['auth'] = str(bool(username and password)).lower()
    result.pop('user', None)
    result.pop('password', None)
    if username and password:
        result['user'] = username
        result['password'] = password
    return result


def environment():
    values = {}
    for line in (Path(__file__).parent / '.env').read_text().splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip()
    return {**values, **os.environ}


def validate_local_configuration(env):
    required = (
        'IDENTITY_DB_PASSWORD',
        'KEYCLOAK_ADMIN',
        'KEYCLOAK_ADMIN_PASSWORD',
        'GROWTH_OIDC_CLIENT_SECRET',
        'GROWTH_SESSION_ADMIN_SECRET',
        'AGENCY_PARTNER_OIDC_CLIENT_SECRET',
        'AGENCY_PARTNER_SESSION_ADMIN_SECRET',
        'AGENTS_OIDC_CLIENT_SECRET',
        'AGENTS_EXECUTION_CLIENT_SECRET',
    )
    missing = [key for key in required if not env.get(key) or env[key].startswith('replace-')]
    if missing:
        raise RuntimeError('Set required local identity settings in .env: ' + ', '.join(missing))
    for key in ('AGENTS_OIDC_CLIENT_SECRET', 'AGENTS_EXECUTION_CLIENT_SECRET'):
        if any(env[key] == env[other] for other in required
               if other != key and other.endswith(('PASSWORD', 'SECRET'))):
            raise RuntimeError(key + ' must use an independent secret')
    template = json.loads((Path(__file__).parent / 'kasitek-realm.json').read_text())
    smtp = smtp_settings(env, template['smtpServer'])
    return template, smtp


def configure_agents_clients(admin, template, env, scopes):
    """Reconcile only the Agents clients and their narrowly scoped execution role."""
    by_name = {client['clientId']: client for client in admin('clients')}
    for client_id, secret_key in (
        ('agents', 'AGENTS_OIDC_CLIENT_SECRET'),
        ('agents-execution', 'AGENTS_EXECUTION_CLIENT_SECRET'),
    ):
        desired = next(client for client in template['clients'] if client['clientId'] == client_id)
        settings = {key: value for key, value in desired.items()
                    if key not in ('defaultClientScopes', 'optionalClientScopes', 'protocolMappers')}
        settings['secret'] = env[secret_key]
        if client_id not in by_name:
            admin('clients', 'POST', settings)
            by_name = {client['clientId']: client for client in admin('clients')}
        current = admin('clients/' + by_name[client_id]['id'])
        current.update(settings)
        endpoint = 'clients/' + current['id']
        admin(endpoint, 'PUT', current)
        for kind, field in (('default', 'defaultClientScopes'), ('optional', 'optionalClientScopes')):
            scope_endpoint = endpoint + '/' + kind + '-client-scopes'
            for scope in admin(scope_endpoint):
                if scope['name'] not in desired[field]:
                    admin(scope_endpoint + '/' + scope['id'], 'DELETE')
            for name in desired[field]:
                admin(scope_endpoint + '/' + scopes[name]['id'], 'PUT')
        mapper_endpoint = endpoint + '/protocol-mappers/models'
        mappers = {mapper['name']: mapper for mapper in admin(mapper_endpoint)}
        desired_mappers = desired.get('protocolMappers', [])
        for name, mapper in mappers.items():
            if name not in {item['name'] for item in desired_mappers}:
                admin(mapper_endpoint + '/' + mapper['id'], 'DELETE')
        for mapper in desired_mappers:
            if mapper['name'] in mappers:
                mapper = {**mapper, 'id': mappers[mapper['name']]['id']}
                admin(mapper_endpoint + '/' + mapper['id'], 'PUT', mapper)
            else:
                admin(mapper_endpoint, 'POST', mapper)

    execution = by_name['agents-execution']
    endpoint = 'clients/' + execution['id']
    desired_role = template['roles']['client']['agents-execution'][0]
    roles = {role['name']: role for role in admin(endpoint + '/roles')}
    if desired_role['name'] not in roles:
        admin(endpoint + '/roles', 'POST', desired_role)
    role = admin(endpoint + '/roles/' + desired_role['name'])
    admin(endpoint + '/scope-mappings/clients/' + execution['id'], 'POST', [role])
    service_user = admin(endpoint + '/service-account-user')
    admin('users/' + service_user['id'] + '/role-mappings/clients/' + execution['id'], 'POST', [role])


def configure():
    env = environment()
    template, smtp = validate_local_configuration(env)
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
    configure_agents_clients(admin, template, env, scopes)
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
    partner_template = next(client for client in template['clients'] if client['clientId'] == 'agency-partner')
    clients = admin('clients')
    by_name = {client['clientId']: client for client in clients}
    if 'agency-partner' not in by_name:
        new_client = {key: value for key, value in partner_template.items()
                      if key not in ('defaultClientScopes', 'optionalClientScopes')}
        new_client['secret'] = env['AGENCY_PARTNER_OIDC_CLIENT_SECRET']
        admin('clients', 'POST', new_client)
        by_name = {client['clientId']: client for client in admin('clients')}
    partner = admin('clients/' + by_name['agency-partner']['id'])
    for key in ('name', 'enabled', 'protocol', 'publicClient', 'secret', 'standardFlowEnabled',
                'directAccessGrantsEnabled', 'serviceAccountsEnabled', 'redirectUris', 'webOrigins', 'attributes'):
        partner[key] = env['AGENCY_PARTNER_OIDC_CLIENT_SECRET'] if key == 'secret' else partner_template[key]
    admin('clients/' + partner['id'], 'PUT', partner)
    for scope_name in partner_template['defaultClientScopes']:
        admin('clients/' + partner['id'] + '/default-client-scopes/' + scopes[scope_name]['id'], 'PUT')
    session_admin_template = next(client for client in template['clients']
                                  if client['clientId'] == 'agency-partner-session-admin')
    clients = admin('clients')
    by_name = {client['clientId']: client for client in clients}
    if 'agency-partner-session-admin' not in by_name:
        session_admin = {key: value for key, value in session_admin_template.items()
                         if key not in ('defaultClientScopes', 'optionalClientScopes')}
        session_admin['secret'] = env['AGENCY_PARTNER_SESSION_ADMIN_SECRET']
        admin('clients', 'POST', session_admin)
        by_name = {client['clientId']: client for client in admin('clients')}
    session_admin = admin('clients/' + by_name['agency-partner-session-admin']['id'])
    session_admin['secret'] = env['AGENCY_PARTNER_SESSION_ADMIN_SECRET']
    session_admin['serviceAccountsEnabled'] = True
    session_admin['standardFlowEnabled'] = False
    session_admin['directAccessGrantsEnabled'] = False
    admin('clients/' + session_admin['id'], 'PUT', session_admin)
    session_admin_user = admin('clients/' + session_admin['id'] + '/service-account-user')
    service_client = by_name['growth-session-admin']
    service_user = admin('clients/' + service_client['id'] + '/service-account-user')
    management = by_name['realm-management']
    role = admin('clients/' + management['id'] + '/roles/manage-users')
    admin('users/' + session_admin_user['id'] + '/role-mappings/clients/' + management['id'], 'POST', [role])
    admin('users/' + service_user['id'] + '/role-mappings/clients/' + management['id'], 'POST', [role])
    realm = admin('')
    for key in ['eventsEnabled', 'eventsExpiration', 'enabledEventTypes']:
        realm[key] = template[key]
    realm['smtpServer'] = smtp
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
    smtp_mode = 'external SMTP' if env.get('IDENTITY_SMTP_HOST', '').strip() else 'Mailpit'
    print('Realm checked; Agents and Agency partner clients, optional OTP, and ' + smtp_mode + ' email configured.')
    print('Google enabled.' if google_ready else 'Google remains disabled until development OAuth credentials are supplied.')


if __name__ == '__main__':
    try:
        configure()
    except (urllib.error.HTTPError, urllib.error.URLError, AssertionError) as error:
        # Never output response bodies containing secrets or request payloads.
        raise SystemExit('Identity configuration failed: ' + type(error).__name__)
    except RuntimeError as error:
        # Local validation errors contain setting names only, never submitted values.
        raise SystemExit('Identity configuration failed: ' + str(error))
