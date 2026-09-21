#!/bin/sh
# The repository half of the chain, in order.
#
#   classify-repositories  -> repository-classification.json   which repositories are servers,
#                                                              and which file declares their package
#   fetch-manifests        -> package-coordinates.json         registry, name, version, plus the
#                                                              URL and sha256 they were read from
#   audit-packages         -> package-audit.json               the same audit the registry path runs
#   build-index --audit    -> index.json                       records that carry measured evidence
#
# Every step is incremental and writes a .partial.json checkpoint, so re-running this after an
# interruption resumes instead of starting over. Only the first step spends GitHub API quota; the
# other two read raw.githubusercontent.com and the package registries.
#
#   GH_TOKEN=... sh scripts/repository-chain.sh [--limit N]
#
# --limit runs each step over the first N items, for a smoke test that does not touch the real
# artifacts. Without it the steps write to data/ and replace what is there.
set -e
cd "$(dirname "$0")/.."

LIMIT=""
if [ "$1" = "--limit" ] && [ -n "$2" ]; then LIMIT="$2"; fi

CLASSIFICATION="data/repository-classification.json"
COORDINATES="data/package-coordinates.json"
AUDIT="data/package-audit.json"
CENSUS="data/github-census.json"

if [ -n "$LIMIT" ]; then
  echo "smoke run: $LIMIT item(s) per step, artifacts stay where they are"
  CLASSIFICATION="${CLASSIFICATION%.json}.smoke.json"
  COORDINATES="${COORDINATES%.json}.smoke.json"
  AUDIT="${AUDIT%.json}.smoke.json"
fi

step() { echo ""; echo "== $1"; }

if [ -z "$LIMIT" ]; then
  step "classify-repositories"
  node packages/collect/scripts/classify-repositories.mjs \
    --census "$CENSUS" --out "$CLASSIFICATION"${LIMIT:+ --limit "$LIMIT"}
else
  echo "classify-repositories skipped in a smoke run: re-fetching trees proves nothing new here"
fi

# A classification with entries but not one manifest path is not a result - it is what a run looks
# like when it started before the code that records the field was deployed. On 2026-09-21 that
# happened: a 3.8 hour full run produced 17,089 entries with no manifest path anywhere, and the two
# steps below wrote empty artifacts that read as "the ecosystem declares no packages". Stop here
# instead. Zero out of seventeen thousand is a bug until proven otherwise.
if [ -z "$LIMIT" ]; then
  WITHOUT=$(node --input-type=module -e "
    import { readFileSync } from 'node:fs'
    const c = JSON.parse(readFileSync('$CLASSIFICATION', 'utf8')).results || {}
    const all = Object.values(c)
    const withM = all.filter(function (v) { return typeof v.manifest === 'string' && v.manifest.length > 0 })
    console.log(withM.length + ' ' + all.length)
  ")
  set -- $WITHOUT
  if [ "$2" -gt 0 ] && [ "$1" -eq 0 ]; then
    echo "STOP: $2 classification entries and not one manifest path. The classifier that produced"
    echo "      this file predates the manifest field (see the 2026-09-21 incident in the CHANGELOG)."
    echo "      Re-run classify-repositories with the current code before continuing."
    exit 3
  fi
  echo "classification: $1 of $2 entries carry a manifest path"
fi

step "fetch-manifests"
node packages/collect/scripts/fetch-manifests.mjs \
  --classification "$CLASSIFICATION" --census "$CENSUS" --out "$COORDINATES"${LIMIT:+ --limit "$LIMIT"}

step "audit-packages"
node packages/collect/scripts/audit-packages.mjs \
  --coordinates "$COORDINATES" --out "$AUDIT"${LIMIT:+ --limit "$LIMIT"}

if [ -z "$LIMIT" ]; then
  step "build-index --audit"
  node packages/collect/scripts/build-index.mjs \
    --census data/census.json --github "$CENSUS" --classification "$CLASSIFICATION" \
    --audit "$AUDIT" --out data/index.json
fi

echo ""
echo "done"
