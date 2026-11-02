import test from "node:test";
import assert from "node:assert/strict";
import {
  envCsv,
  envOptional,
  envRequired,
  envStringOr,
  envTruthy,
  envU16Or,
  envU32Or,
  environmentAllowsLoopbackOrigins,
  isLoopbackOrigin,
  normalizeHttpOrigin,
} from "../dist/config.js";

test("shared config helpers preserve Rust parsing, origin and loopback rules", () => {
  const prefix = `KASITEK_SHARED_CONFIG_${process.pid}`;
  const names = [
    "OPTIONAL",
    "EMPTY",
    "U16",
    "U32",
    "CSV",
    "TRUTHY",
  ].map((suffix) => `${prefix}_${suffix}`);
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  try {
    process.env[names[0]] = "  configured value  ";
    process.env[names[1]] = "   ";
    process.env[names[2]] = "65535";
    process.env[names[3]] = "4294967296";
    process.env[names[4]] = " one, ,two ,, three ";
    process.env[names[5]] = "YES";

    assert.equal(envOptional(names[0]), "configured value");
    assert.equal(envRequired(names[0]), "configured value");
    assert.equal(envStringOr(names[1], "fallback"), "fallback");
    assert.throws(() => envRequired(names[1]), new RegExp(names[1]));
    assert.equal(envU16Or(names[2], 7), 65535);
    assert.equal(envU32Or(names[3], 7), 7);
    assert.deepEqual(envCsv(names[4]), ["one", "two", "three"]);
    assert.equal(envTruthy(names[5]), true);

    for (const environment of ["development", "DEV", "local", "test"])
      assert.equal(environmentAllowsLoopbackOrigins(environment), true);
    for (const environment of ["production", "staging", "preview", ""])
      assert.equal(environmentAllowsLoopbackOrigins(environment), false);

    for (const origin of [
      "http://localhost:3000/",
      "https://127.10.20.30:8443",
      "http://[::1]:5173",
    ])
      assert.equal(isLoopbackOrigin(origin), true, origin);
    for (const origin of [
      "ftp://localhost:3000",
      "http://localhost:3000/path",
      "http://user@localhost:3000",
      "http://localhost:3000?next=/",
    ]) {
      assert.equal(normalizeHttpOrigin(origin), undefined, origin);
      assert.equal(isLoopbackOrigin(origin), false, origin);
    }
    assert.equal(
      normalizeHttpOrigin("https://localhost.example.com:3000"),
      "https://localhost.example.com:3000",
    );
    assert.equal(isLoopbackOrigin("https://localhost.example.com:3000"), false);
    assert.equal(normalizeHttpOrigin("https://EXAMPLE.com:443/"), "https://example.com");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('an explicit service environment file cannot inherit product or working-directory files', async()=>{
 const {loadServiceEnvironment}=await import('../dist/config.js');
 const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {parseEnv}=await import('node:util');
 const dir=mkdtempSync(join(tmpdir(),'kasitek-env-isolation-'));
 try{
  const product=join(dir,'product.env'),cwd=join(dir,'cwd.env'),profile=join(dir,'profile.env');
  writeFileSync(product,'UNRELATED_PROVIDER_KEY=product-only\n');writeFileSync(cwd,'UNRELATED_PROVIDER_KEY=cwd-only\n');writeFileSync(profile,'DATABASE_NAME=isolated-development\n');
  function loader(target,calls){return path=>{calls.push(path);try{Object.assign(target,parseEnv(readFileSync(path??cwd,'utf8')));return {};}catch(error){return {error};}};}
  const target={},calls=[];loadServiceEnvironment(product,loader(target,calls),{KASITEK_ENV_FILE:profile});assert.deepEqual(calls,[profile]);assert.deepEqual(target,{DATABASE_NAME:'isolated-development'});
  const absent={},missingCalls=[];assert.throws(()=>loadServiceEnvironment(product,loader(absent,missingCalls),{KASITEK_ENV_FILE:join(dir,'missing.env')}),/explicit service environment/);assert.deepEqual(absent,{});assert.equal(missingCalls.length,1);
  assert.throws(()=>loadServiceEnvironment(product,loader({},[]),{KASITEK_ENV_FILE:' '}),/must name/);
  const defaults={},defaultCalls=[];loadServiceEnvironment(product,loader(defaults,defaultCalls),{});assert.deepEqual(defaultCalls,[product]);assert.equal(defaults.UNRELATED_PROVIDER_KEY,'product-only');
  const fallback={},fallbackCalls=[];loadServiceEnvironment(join(dir,'missing.env'),loader(fallback,fallbackCalls),{});assert.deepEqual(fallbackCalls,[join(dir,'missing.env'),undefined]);assert.equal(fallback.UNRELATED_PROVIDER_KEY,'cwd-only');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
