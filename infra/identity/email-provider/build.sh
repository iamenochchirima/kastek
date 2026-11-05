#!/usr/bin/env bash
set -euo pipefail

provider_root="$(cd "$(dirname "$0")" && pwd)"
keycloak_home="${KEYCLOAK_HOME:?Set KEYCLOAK_HOME to the pinned Keycloak distribution}"
build_dir="${IDENTITY_PROVIDER_BUILD_DIR:-$provider_root/target}"
java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}"
mkdir -p "$build_dir/classes" "$build_dir/test-classes"
classpath="$keycloak_home/lib/lib/main/*"
"${java_bin}javac" --release 21 -cp "$classpath" -d "$build_dir/classes" "$provider_root"/src/main/java/za/co/kasitek/identity/*.java
cp -R "$provider_root/src/main/resources/." "$build_dir/classes/"
"${java_bin}javac" --release 21 -cp "$classpath:$build_dir/classes" -d "$build_dir/test-classes" "$provider_root"/src/test/java/za/co/kasitek/identity/*.java
"${java_bin}java" -cp "$classpath:$build_dir/classes:$build_dir/test-classes" za.co.kasitek.identity.ResendEmailSenderProviderTest
"${java_bin}jar" --create --file "$build_dir/kasitek-resend-email.jar" -C "$build_dir/classes" .
