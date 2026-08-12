#!/usr/bin/env bash
# Deploy Docloop to Google Cloud. Replaces the Vercel target that was designed but never used.
#
#   ./scripts/deploy-gcp.sh
#
# Every step is idempotent: re-running it does not create a second database or a second instance.
# Nothing here is destructive. It never drops a database and never deletes a service.
#
# TIER CHOICES ARE DELIBERATELY THE SMALLEST THAT WORK. This is a proof of concept and the
# instruction was explicit that cost must not creep:
#
#   Cloud Run    min-instances=0  — scales to zero, so an idle day costs nothing at all
#                max-instances=2  — a webhook storm cannot fan out into a bill
#                512Mi / 1 CPU    — Next.js serves this queue in well under that
#   Cloud SQL    db-f1-micro      — the smallest Postgres tier Cloud SQL offers
#                10GB HDD         — HDD, not SSD; 795 articles is about 4 MB
#                zonal, no HA     — high availability doubles the price
#                no backups       — SEE THE WARNING BELOW
#
# Cloud SQL does NOT scale to zero. It bills for every hour it exists, roughly $8-10 a month at
# this tier. That is the entire running cost of this deployment; Cloud Run at idle is free.
# `gcloud sql instances patch "$SQL_INSTANCE" --activation-policy=NEVER` stops the billing for
# compute while keeping the data, and ALWAYS starts it again.
#
# WARNING — BACKUPS ARE OFF. It is the right call only because every row here is reproducible:
# articles come from scripts/import-docs.mjs, areas from scripts/map-doc-areas.mjs, and
# suggestions from re-running the workers. If that stops being true, turn backups on:
#   gcloud sql instances patch "$SQL_INSTANCE" --backup-start-time=03:00

set -euo pipefail

PROJECT="${PROJECT:-kf-dev-research-ai}"
# us-central1 is among the cheapest regions and this is a POC. If Kissflow needs the data held in
# India, set REGION=asia-south1 — it is one variable and costs roughly 15-20% more.
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-docloop}"
SQL_INSTANCE="${SQL_INSTANCE:-docloop-pg}"
DB_NAME="${DB_NAME:-docloop}"
DB_USER="${DB_USER:-docloop}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
exists() { "$@" >/dev/null 2>&1; }

say "Project $PROJECT, region $REGION"
gcloud config set project "$PROJECT" >/dev/null

say "Enabling the four APIs this needs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com

say "Cloud SQL instance ($SQL_INSTANCE)"
if exists gcloud sql instances describe "$SQL_INSTANCE"; then
  echo "already exists, leaving it alone"
else
  echo "creating — this takes several minutes, which is normal"
  # --edition=ENTERPRISE is REQUIRED and is the CHEAP one, despite how the names read. The project
  # defaults to ENTERPRISE_PLUS, which does not offer db-f1-micro at all and fails the create with
  # "Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition". Without this flag you either get an
  # error or, worse, talk yourself into a far more expensive machine type.
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_17 \
    --edition=ENTERPRISE \
    --tier=db-f1-micro \
    --region="$REGION" \
    --storage-type=HDD \
    --storage-size=10GB \
    --no-backup \
    --availability-type=zonal
fi

say "Database and user"
exists gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" \
  || gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"

# The password is generated here and never printed. It goes straight into Secret Manager, and
# Cloud Run reads it from there — it is never an --set-env-vars argument, because those are
# visible in `gcloud run services describe` and in the console to anyone with viewer access.
if exists gcloud secrets describe docloop-db-password; then
  echo "password secret already exists, reusing it"
else
  DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"
  printf '%s' "$DB_PASSWORD" | gcloud secrets create docloop-db-password --data-file=-
  gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD"
  unset DB_PASSWORD
fi

CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
say "Cloud SQL connection name: $CONNECTION_NAME"

say "Application secrets"
# These four already exist locally in web/.env.local. They are read from there ONCE and pushed to
# Secret Manager; the file itself is never uploaded (see web/.gcloudignore).
for name in DASHBOARD_PASSWORD GITHUB_WEBHOOK_SECRET GENERIC_HOOK_TOKEN WORKER_API_KEY; do
  secret="docloop-$(echo "$name" | tr '[:upper:]_' '[:lower:]-')"
  if exists gcloud secrets describe "$secret"; then
    echo "$secret already exists"
  else
    value="$(grep "^${name}=" web/.env.local | cut -d= -f2- | tr -d '"')"
    if [ -z "$value" ]; then
      echo "MISSING $name in web/.env.local — cannot continue" >&2
      exit 1
    fi
    printf '%s' "$value" | gcloud secrets create "$secret" --data-file=-
    echo "$secret created"
  fi
done

say "Letting the Cloud Run service account read the secrets"
# The build can succeed and the revision still fail. Cloud Run runs as the compute service
# account, and creating a secret does not grant that account permission to read it — the deploy
# fails with "Permission denied on secret ... for Revision service account", which reads like a
# problem with the secret rather than with IAM.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for secret in docloop-db-password docloop-dashboard-password docloop-github-webhook-secret \
              docloop-generic-hook-token docloop-worker-api-key; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done
echo "granted secretAccessor to $RUNTIME_SA on 5 secrets"

say "Deploying to Cloud Run from source"
# --source builds with Cloud Build's Node buildpack. No Dockerfile and no local Docker daemon,
# which matters because there is no Docker on this machine.
#
# --allow-unauthenticated is REQUIRED and is not a lapse: GitHub cannot present a Google identity
# when it posts a webhook. The routes defend themselves — HMAC on the GitHub hook, bearer tokens
# on the worker routes, and a shared-password gate on everything else (web/app/_lib/gate.ts).
gcloud run deploy "$SERVICE" \
  --source=web \
  --region="$REGION" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --cpu=1 \
  --add-cloudsql-instances="$CONNECTION_NAME" \
  `# The URL carries the user and the socket path but NOT the password. node-postgres falls back` \
  `# to PGPASSWORD, which arrives from Secret Manager below — so the password never appears in an` \
  `# env var that "gcloud run services describe" or a console viewer can read.` \
  --set-env-vars="DATABASE_URL=postgresql://${DB_USER}@/${DB_NAME}?host=/cloudsql/${CONNECTION_NAME}" \
  --set-secrets="\
PGPASSWORD=docloop-db-password:latest,\
DASHBOARD_PASSWORD=docloop-dashboard-password:latest,\
GITHUB_WEBHOOK_SECRET=docloop-github-webhook-secret:latest,\
GENERIC_HOOK_TOKEN=docloop-generic-hook-token:latest,\
WORKER_API_KEY=docloop-worker-api-key:latest"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"

say "Deployed: $URL"
cat <<EOF

Two things still to do by hand, because both are one-way:

1. Apply the schema. Cloud SQL has no shell, so connect through the proxy:
     gcloud sql connect $SQL_INSTANCE --user=$DB_USER --database=$DB_NAME < web/schema.sql

2. Point the worker at the deployment, in worker/.env.local:
     DOCLOOP_API_URL=$URL

To stop paying for the database while keeping its data:
     gcloud sql instances patch $SQL_INSTANCE --activation-policy=NEVER
To start it again:
     gcloud sql instances patch $SQL_INSTANCE --activation-policy=ALWAYS
EOF
