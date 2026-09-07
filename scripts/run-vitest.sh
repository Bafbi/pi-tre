#!/usr/bin/env bash
set -euo pipefail

vitest_args=()
no_service=false
no_llm=false

for arg in "$@"; do
	case "$arg" in
		--no-service)
			no_service=true
			;;
		--no-llm)
			no_llm=true
			;;
		--no-*)
			echo "Unknown test category flag: $arg" >&2
			echo "Use --no-service or --no-llm." >&2
			exit 2
			;;
		*)
			vitest_args+=("$arg")
			;;
	esac
done

if [[ "$no_service" == true ]]; then
	vitest_args+=(--exclude '**/*.service.test.ts')
fi

if [[ "$no_llm" == true ]]; then
	vitest_args+=(--exclude '**/*.llm.test.ts')
fi

exec pnpm exec vitest run "${vitest_args[@]}"
