# Glass Bank - thin wrappers over npm scripts and infra/ (see docs/REPO_LAYOUT.md).
# Real gcloud flags live only in infra/deploy.sh (CLAUDE.md invariant 12).

.PHONY: dev check test build deploy smoke e2e smoke-worker-sqlite

dev:
	npm run dev

check:
	npm run check

test:
	npm test

build:
	npm run build

e2e:
	npm run e2e

smoke-worker-sqlite:
	node scripts/smoke-worker-sqlite.mjs

deploy:
	./infra/deploy.sh

smoke:
	./infra/smoke.sh
