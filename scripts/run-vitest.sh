#!/usr/bin/env bash
#
# Run the workspace tests.
#
# The default run is hermetic: it excludes tests that call a real LLM
# (`*.llm.test.ts`) and tests that call a real external service
# (`*.service.test.ts`). Use the flags below to change the set.
#
#   (default)   hermetic tests only
#   --all       hermetic + external tests
#   --external  external tests only
#
# `--no-llm` and `--no-service` are accepted for compatibility and ignored,
# because the default already excludes those categories.
#
set -euo pipefail

mode="hermetic"
vitest_args=()

for arg in "$@"; do
	case "$arg" in
		--all)
			mode="all"
			;;
		--external)
			mode="external"
			;;
		--no-llm | --no-service)
			# Compatibility no-ops: the default already excludes these.
			;;
		--no-*)
			echo "Unknown test category flag: $arg" >&2
			echo "Use --all or --external." >&2
			exit 2
			;;
		*)
			vitest_args+=("$arg")
			;;
	esac
done

case "$mode" in
	hermetic)
		vitest_args+=(--exclude '**/*.service.test.ts')
		vitest_args+=(--exclude '**/*.llm.test.ts')
		;;
	external)
		# Vitest positional arguments are filename filters (OR'ed).
		vitest_args+=(service.test llm.test)
		vitest_args+=(--passWithNoTests)
		;;
	all) ;;
esac

exec pnpm exec vitest run "${vitest_args[@]}"
