#!/usr/bin/env python3
"""Register only the local Agents clients; never alter realm or Growth settings."""
import argparse
import json
import os
from pathlib import Path
import secrets
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def read_environment(file):
    values = {}
    if file.exists():
        for line in file.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip().strip('\"\'')
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identity-env', type=Path,
                        default=ROOT.parent / 'kasitek-labs/infra/identity/.env')
    args = parser.parse_args()
    identity = read_environment(args.identity_env)
    local_file = ROOT / '.env'
    local = read_environment(local_file)
    base = 'http://localhost:8080'
    settings = {
        'AGENTS_OIDC_ISSUER_URL': base + '/realms/kasitek',
        'AGENTS_PUBLIC_URL': 'http://localhost:3100',
        'AGENTS_OIDC_CLIENT_ID': 'agents',
        'AGENTS_OIDC_ADMIN_CLIENT_ID': 'agents-session-admin',
    }
    for key, value in settings.items():
        if key in local and local[key] != value:
            raise RuntimeError('Existing Agents identity settings are not this local setup')
    body = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli',
        'username': identity['KEYCLOAK_ADMIN'], 'password': identity['KEYCLOAK_ADMIN_PASSWORD']}).encode()
    with urllib.request.urlopen(urllib.request.Request(base + '/realms/master/protocol/openid-connect/token', data=body), timeout=15) as response:
        token = json.load(response)['access_token']

    def admin(path, method='GET', data=None):
        payload = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(base + '/admin/realms/kasitek/' + path,
            data=payload, method=method,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            content = response.read()
            return json.loads(content) if content else None

    clients = {client['clientId']: client for client in admin('clients')}
    specs = [
        ('agents', 'AGENTS_OIDC_CLIENT_SECRET', {
            'clientId': 'agents', 'name': 'KasiTek Agents', 'protocol': 'openid-connect',
            'enabled': True, 'publicClient': False, 'standardFlowEnabled': True,
            'directAccessGrantsEnabled': False, 'serviceAccountsEnabled': False,
            'redirectUris': ['http://localhost:3100/api/auth/callback'],
            'webOrigins': ['http://localhost:3100'],
            'attributes': {'pkce.code.challenge.method': 'S256',
                           'post.logout.redirect.uris': 'http://localhost:3100/login'},
            'defaultClientScopes': ['web-origins', 'acr', 'profile', 'email', 'basic'],
            'optionalClientScopes': [],
        }),
        ('agents-session-admin', 'AGENTS_OIDC_ADMIN_CLIENT_SECRET', {
            'clientId': 'agents-session-admin', 'name': 'Agents session checks', 'protocol': 'openid-connect',
            'enabled': True, 'publicClient': False, 'standardFlowEnabled': False,
            'directAccessGrantsEnabled': False, 'serviceAccountsEnabled': True,
        }),
    ]
    for client_id, key, spec in specs:
        if client_id in clients:
            current = admin('clients/' + clients[client_id]['id'])
            actual_secret = admin('clients/' + current['id'] + '/client-secret')['value']
            if local.get(key) and local[key] != actual_secret:
                raise RuntimeError('Existing Agents client secret differs; refusing an implicit rotation')
            settings[key] = actual_secret
            # Preserve unrelated client settings while enforcing our exact callbacks.
            updated = {**current, **spec}
            if 'attributes' in spec:
                updated['attributes'] = {**current.get('attributes', {}), **spec['attributes']}
            admin('clients/' + current['id'], 'PUT', updated)
        else:
            settings[key] = local.get(key) or secrets.token_urlsafe(32)
            admin('clients', 'POST', {**spec, 'secret': settings[key]})
    clients = {client['clientId']: client for client in admin('clients')}
    user = admin('clients/' + clients['agents-session-admin']['id'] + '/service-account-user')
    management_id = clients['realm-management']['id']
    role = admin('clients/' + management_id + '/roles/manage-users')
    admin('users/' + user['id'] + '/role-mappings/clients/' + management_id, 'POST', [role])
    existing = local_file.read_text().splitlines() if local_file.exists() else []
    remaining = {**settings}
    lines = []
    for line in existing:
        key = line.split('=', 1)[0].strip()
        if key in settings:
            if key in remaining:
                lines.append(key + '=' + remaining.pop(key))
        else:
            lines.append(line)
    lines.extend(key + '=' + value for key, value in remaining.items())
    # Restrict permissions before writing credential material.
    fd = os.open(local_file, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write('\n'.join(lines) + '\n')
    print('Local Agents clients configured. Secrets saved privately in Agents .env.')
    print('Shared realm settings and other product clients were not changed.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('Local login configuration failed: ' + str(error))
