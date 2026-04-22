# Project Overview
Designed to process long-form content into short, engaging clips.

# Tech Stack & Architecture
* **Deployment:** Vercel (Frontend & Serverless logic).
* **Database & Auth:** Firebase (Firestore NoSQL, Authentication).
* **Compute Engine:** Modal (Serverless GPU for heavy video rendering).
* **AI Services:** Anthropic Claude Sonnet 4.5, Deepgram Nova-2.
* **Payments:** Stripe (Subscriptions and micro-transactions).

# Core Business Logic
* **Subscription Model:** Three tiers (Free, Starter $7.99/mo, Pro $14.99/mo).
* **Credit System:** Users consume credits (minutes) per video processed.