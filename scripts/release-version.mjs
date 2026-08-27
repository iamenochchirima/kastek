#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = join(repositoryRoot, "VERSION");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readPlatformVersion() {
  const version = readFileSync(versionPath, "utf8").trim();
  if (!semverPattern.test(version)) {
    throw new Error(`VERSION must contain a valid SemVer value; received ${JSON.stringify(version)}`);
  }
  return version;
}

function releaseTag(version) {
  return `platform-v${version}`;
}

function validateTag(version) {
  const explicitTag = process.env.RELEASE_TAG || "";
  const isTagRef = Boolean(explicitTag) || process.env.GITHUB_REF_TYPE === "tag";
  const refName = explicitTag || (isTagRef ? process.env.GITHUB_REF_NAME || "" : "");
  if (isTagRef && refName !== releaseTag(version)) {
    throw new Error(`release tag ${refName} does not match VERSION ${version}`);
  }
}

function metadata(version) {
  return {
    schemaVersion: 1,
    platformVersion: version,
    releaseTag: releaseTag(version),
    commitSha: process.env.GIT_SHA || process.env.GITHUB_SHA || null,
    service: process.env.SERVICE_NAME || null,
    environment: process.env.ENVIRONMENT || process.env.NODE_ENV || null,
    generatedAt: new Date().toISOString(),
  };
}

try {
  const command = process.argv[2] || "check";
  const version = readPlatformVersion();
  validateTag(version);

  if (command === "check") {
    console.log(`platform_version=${version}`);
    console.log(`release_tag=${releaseTag(version)}`);
  } else if (command === "tag") {
    console.log(releaseTag(version));
  } else if (command === "metadata") {
    console.log(JSON.stringify(metadata(version), null, 2));
  } else {
    console.error("Usage: node scripts/release-version.mjs <check|tag|metadata>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
