import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import {
  buildInstagramAuthorizeUrl,
  instagramAppId,
  instagramAppSecret,
} from '../src/integrations/social-oauth.js';
import {
  exchangeInstagramCodeForToken,
  exchangeInstagramForLongLivedToken,
  fetchInstagramProfile,
} from '../src/integrations/provider-auth.js';
import type { HttpFetch } from '../src/integrations/email.js';

const config = readConfig({
  DATABASE_URL: 'postgres://unused',
  FRONTEND_URL: 'https://app.example.test',
  KASITEK_CORE_PUBLIC_URL: 'https://api.example.test',
  AUTH_META_APP_ID: 'facebook-app',
  AUTH_META_APP_SECRET: 'facebook-secret',
  AUTH_INSTAGRAM_APP_ID: 'instagram-app',
  AUTH_INSTAGRAM_APP_SECRET: 'instagram-secret',
});

test('direct Instagram authorization uses its own app and public callback without Page scopes', () => {
  const url = new URL(buildInstagramAuthorizeUrl(config, 'synthetic-state'));
  assert.equal(url.origin, 'https://www.instagram.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'instagram-app');
  assert.equal(url.searchParams.get('state'), 'synthetic-state');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://api.example.test/api/social/oauth/instagram/callback');
  const scopes = url.searchParams.get('scope')!.split(',');
  assert.ok(scopes.includes('instagram_business_basic'));
  assert.ok(scopes.includes('instagram_business_content_publish'));
  assert.ok(scopes.every(scope => scope.startsWith('instagram_business_')));
  assert.ok(!url.searchParams.has('page_id'));
});

test('direct Instagram exchanges its code, extends the token and reads a professional account without Page discovery', async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const responses = [
    {access_token: 'short-fixture', permissions: ['instagram_business_basic', 'instagram_business_content_publish']},
    {access_token: 'long-fixture', token_type: 'bearer', expires_in: 5184000},
    {id: 'app-scoped-id', user_id: 'professional-id', username: 'fixturecreator', account_type: 'MEDIA_CREATOR'},
  ];
  const http: HttpFetch = async (input, init = {}) => {
    calls.push({url: new URL(String(input)), init});
    const result = responses.shift();
    assert.ok(result, 'unexpected provider request');
    return new Response(JSON.stringify(result));
  };
  const short = await exchangeInstagramCodeForToken(config, 'fixture-code', http);
  const long = await exchangeInstagramForLongLivedToken(config, short.access_token!, http);
  const account = await fetchInstagramProfile(long.access_token!, http);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url.href, 'https://api.instagram.com/oauth/access_token');
  const form = calls[0]!.init.body as URLSearchParams;
  assert.equal(form.get('client_id'), 'instagram-app');
  assert.equal(form.get('client_secret'), 'instagram-secret');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), 'https://api.example.test/api/social/oauth/instagram/callback');
  assert.equal(calls[1]!.url.origin, 'https://graph.instagram.com');
  assert.equal(calls[1]!.url.searchParams.get('grant_type'), 'ig_exchange_token');
  assert.equal(calls[1]!.url.searchParams.get('client_secret'), 'instagram-secret');
  assert.equal(calls[2]!.url.origin, 'https://graph.instagram.com');
  assert.match(calls[2]!.url.pathname, /\/me$/);
  assert.equal(new Headers(calls[2]!.init.headers).get('authorization'), 'Bearer long-fixture');
  assert.equal(account.user_id, 'professional-id');
  assert.equal(account.account_type, 'MEDIA_CREATOR');
  assert.ok(calls.every(call => !call.url.href.includes('graph.facebook.com')));
});

test('direct Instagram refuses Meta-only credentials and missing tokens or account identities', async () => {
  const metaOnly = readConfig({DATABASE_URL: 'postgres://unused', AUTH_META_APP_ID: 'facebook-app', AUTH_META_APP_SECRET: 'facebook-secret'});
  assert.throws(() => instagramAppId(metaOnly), /AUTH_INSTAGRAM_APP_ID/);
  assert.throws(() => instagramAppSecret(metaOnly), /AUTH_INSTAGRAM_APP_SECRET/);
  const empty: HttpFetch = async () => new Response('{}');
  await assert.rejects(exchangeInstagramCodeForToken(config, 'fixture-code', empty), /did not return an access token/);
  await assert.rejects(exchangeInstagramForLongLivedToken(config, 'fixture-token', empty), /did not return an access token/);
  await assert.rejects(fetchInstagramProfile('fixture-token', empty), /did not return an account identifier/);
});
