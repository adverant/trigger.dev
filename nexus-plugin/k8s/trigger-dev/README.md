# Trigger.dev Self-Hosted Deployment for Nexus

This directory contains the Helm values override for deploying a self-hosted Trigger.dev instance integrated with the Nexus platform.

## Prerequisites

- Kubernetes cluster with Nexus stack deployed
- Helm 3.x installed
- `nexus-postgres` and `nexus-redis` services running in the `nexus` namespace
- Istio service mesh configured

## Create Secrets

Before deploying, create the required secrets:

```bash
# Generate secrets
SESSION_SECRET=$(openssl rand -hex 32)
MAGIC_LINK_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 16)
MANAGED_WORKER_SECRET=$(openssl rand -hex 32)
MINIO_ROOT_USER="triggerdev"
MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)

# Create Kubernetes secret
kubectl create secret generic nexus-trigger-dev-secrets \
  --namespace nexus \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --from-literal=MAGIC_LINK_SECRET="$MAGIC_LINK_SECRET" \
  --from-literal=ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  --from-literal=MANAGED_WORKER_SECRET="$MANAGED_WORKER_SECRET" \
  --from-literal=MINIO_ROOT_USER="$MINIO_ROOT_USER" \
  --from-literal=MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD"
```

## Create the Trigger.dev Database

Ensure the `trigger_dev` database exists in the shared PostgreSQL instance:

```bash
kubectl exec -it nexus-postgres-0 -n nexus -- \
  psql -U nexus -c "CREATE DATABASE trigger_dev;"
```

## Install with Helm

```bash
# Add the Trigger.dev Helm chart (OCI registry)
helm install trigger-dev oci://ghcr.io/triggerdotdev/trigger.dev/helm \
  --version 1.0.0 \
  -f values-nexus.yaml \
  -n nexus \
  --wait
```

## Upgrade

```bash
helm upgrade trigger-dev oci://ghcr.io/triggerdotdev/trigger.dev/helm \
  --version <new-version> \
  -f values-nexus.yaml \
  -n nexus \
  --wait
```

## Verify Deployment

```bash
# Check pods
kubectl get pods -n nexus -l app=trigger-dev-webapp

# Check webapp health
kubectl exec -it deploy/trigger-dev-webapp -n nexus -- \
  wget -qO- http://localhost:3030/healthcheck

# Check logs
kubectl logs -f deploy/trigger-dev-webapp -n nexus
kubectl logs -f deploy/trigger-dev-supervisor -n nexus
```

## Access Dashboard

The Trigger.dev dashboard is accessible at the webapp service. With Istio configured, it is proxied through the Nexus API gateway.

## Architecture

```
nexus-trigger-plugin (port 8080)
    |
    +---> trigger-dev-webapp (port 3030)  [Trigger.dev API + Dashboard]
    |         |
    |         +---> nexus-postgres (port 5432)  [Shared - database: trigger_dev]
    |         +---> nexus-redis (port 6379)     [Shared - db 4]
    |         +---> clickhouse (port 8123)      [Dedicated - run analytics]
    |         +---> minio (port 9000)           [Dedicated - artifact storage]
    |
    +---> trigger-dev-supervisor              [Worker manager - Kubernetes mode]
    |
    +---> Nexus services (graphrag, mageagent, fileprocess, etc.)
```

## Uninstall

```bash
helm uninstall trigger-dev -n nexus
kubectl delete secret nexus-trigger-dev-secrets -n nexus
kubectl delete pvc -l app=trigger-dev -n nexus
```
