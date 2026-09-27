# Glass Bank - thin wrappers over npm scripts and infra/ (see docs/REPO_LAYOUT.md).
# Real gcloud flags live only in infra/deploy.sh (CLAUDE.md invariant 12).

.PHONY: dev check test build deploy smoke e2e smoke-worker-sqlite pause resume xray-export

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

# D-25: stop the bill between demos, bring the same image back (infra/pause.sh).
pause:
	./infra/pause.sh pause

resume:
	./infra/pause.sh resume

# D-27: download the live X-ray event log as JSONL into exports/ before a pause wipes it.
xray-export:
	./infra/export.sh
