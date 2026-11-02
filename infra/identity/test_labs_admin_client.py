"""Offline admin-client boundaries; never accesses running identity or secrets."""
import copy
import json
from pathlib import Path
import unittest
from configure import configure_labs_admin_client
from test_agents_clients import Realm

class LabsAdminTests(unittest.TestCase):
    def setUp(self):
        self.template=json.loads((Path(__file__).parent/'kasitek-realm.json').read_text())
        self.realm=Realm(self.template)
        self.env={'LABS_ADMIN_OIDC_CLIENT_SECRET':'independent-test-secret'}
    def reconcile(self):
        configure_labs_admin_client(self.realm.admin,self.template,self.env,self.realm.scopes)
    def test_separate_client_and_no_customer_or_management_authority(self):
        previous=copy.deepcopy(self.realm.clients)
        self.reconcile()
        client=self.realm.clients['labs-admin']
        self.assertEqual(client['redirectUris'],['http://localhost:3001/api/operations-auth/callback'])
        self.assertEqual(client['attributes']['pkce.code.challenge.method'],'S256')
        self.assertIn('basic',self.realm.attached[('labs-admin-id','default-client-scopes')])
        for field in ('publicClient','directAccessGrantsEnabled','serviceAccountsEnabled','implicitFlowEnabled','fullScopeAllowed'):
            self.assertFalse(client.get(field,False))
        self.assertEqual(self.realm.attached[('labs-admin-id','optional-client-scopes')],{})
        for name,value in previous.items(): self.assertEqual(self.realm.clients[name],value)
        self.assertNotIn('role-mappings',json.dumps(self.realm.calls))
        self.assertNotIn('manage-users',json.dumps(self.realm.calls))
    def test_reconcile_removes_optional_scopes_mappers_and_rotates_secret(self):
        self.reconcile()
        self.realm.attached[('labs-admin-id','optional-client-scopes')]={'profile':self.realm.scopes['profile']}
        self.realm.mappers['labs-admin-id']={'unexpected':{'id':'unexpected','name':'unexpected'}}
        self.env['LABS_ADMIN_OIDC_CLIENT_SECRET']='rotated-independent-secret'
        self.reconcile()
        self.assertEqual(self.realm.clients['labs-admin']['secret'],'rotated-independent-secret')
        self.assertEqual(self.realm.attached[('labs-admin-id','optional-client-scopes')],{})
        self.assertEqual(self.realm.mappers['labs-admin-id'],{})
    def test_missing_or_shared_secret_fails_before_network(self):
        self.env={}
        with self.assertRaises(RuntimeError): self.reconcile()
        self.env={'LABS_ADMIN_OIDC_CLIENT_SECRET':'same','AGENTS_OIDC_CLIENT_SECRET':'same'}
        with self.assertRaises(RuntimeError): self.reconcile()
        self.assertEqual(self.realm.calls,[])
