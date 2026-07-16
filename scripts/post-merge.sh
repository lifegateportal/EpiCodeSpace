#!/bin/bash
set -e

# Auto-install dependencies after merge
pnpm install --frozen-lockfile

# Database migrations removed from auto-run
# To apply database changes manually, run: pnpm --filter db push
