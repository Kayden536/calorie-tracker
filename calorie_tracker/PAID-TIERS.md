# MacroSync Paid Tier Plan

This document records the planned subscription structure for MacroSync. **Payments, subscriptions, and billing are not implemented yet.** These notes are product-planning requirements for a future release.

## Core principle

All eight nutrition goals should remain available to every MacroSync user. Goal selection and the starting macro calculation are **not** intended to be a paid-only feature.

The paid tiers should provide additional convenience, capacity, analysis, and automation rather than locking users out of the core goal system.

## Planned tiers

### Free

The free tier should provide a complete, useful food-tracking experience, including:

- Food logging
- Daily calorie and macro targets
- All eight goal choices
- Starting macro calculations for all eight goals
- Food database search
- Basic progress tracking
- Basic recipes and meals
- Account/settings
- Basic social/friend functionality
- A limited monthly allowance of normal user-to-user messages
- Core trainer/client functionality where applicable

### Basic+

Basic+ is planned as the first paid tier and should focus on expanded limits and additional personalization.

Potential features:

- Larger personal food database limits
- More saved recipes
- Community food creation/publishing
- Expanded food and serving tools
- More detailed nutrition history
- Additional personalization options
- Higher usage limits for applicable features
- A substantially larger monthly user-to-user messaging allowance

### Premium

Premium is planned as the advanced/power-user tier.

Potential features:

- Advanced progress and trend analysis
- Advanced nutrition history and reporting
- Advanced food search/filtering tools
- Advanced trainer tools
- Higher or unlimited applicable limits
- Goal trend monitoring and macro-adjustment automation
- Highest user-to-user messaging allowance, potentially unlimited depending on final storage costs

## Premium goal automation

The eight goals themselves remain free. Premium can add automation around those goals.

Planned Premium functionality:

1. **Trend detection:** analyze logged weight and other relevant logged progress data to identify a sustained trend that may match one of the adjustment recommendations for the selected goal.
2. **Recommended adjustment:** show the user what adjustment is being recommended and why.
3. **One-click adjustment:** provide an option for the Premium user to apply the recommended macro change automatically.
4. **Manual approval:** automatic changes should not silently alter a user's targets. The user should be able to review the recommendation before applying it.
5. **Adjustment history:** keep a record of previous target changes so the user can see when and why targets changed.
6. **Goal reassessment:** support the existing goal guidance around reassessing after meaningful weight changes and transitioning between goal phases.

The recommendation engine should use the adjustment rules already defined for each goal rather than creating a separate set of Premium-only goals.

## Planned user-to-user messaging limits

Normal user-to-user messaging can remain available on the Free tier, but a monthly message allowance can help control database growth and abuse without removing messaging entirely.

A possible starting structure is:

- **Free:** limited monthly message allowance.
- **Basic+:** substantially higher monthly allowance.
- **Premium:** highest allowance, potentially unlimited if storage and abuse controls make that practical.

These limits should apply to normal user-to-user conversations. Trainer/client messaging can be evaluated separately because it is part of the trainer feature set.

The message limit should be enforced server-side/Supabase-side, not only by disabling the send button in the frontend. The system should also consider rate limiting and message retention/cleanup later if storage becomes a concern. Message text is relatively small compared with media files, so message count is primarily an abuse and database-growth control rather than a major storage concern by itself.

## Planned entitlement architecture

When subscriptions are eventually added, feature access should be controlled through a centralized entitlement system rather than scattered payment checks throughout the frontend.

Example concepts:

```js
canUseFeature('advanced_progress')
canUseFeature('community_food_creation')
canUseFeature('goal_auto_adjustments')
getLimit('personal_foods')
getLimit('saved_recipes')
```

Entitlements and limits should ultimately be enforced server-side/Supabase-side as well as reflected in the UI. Hiding a button in client-side JavaScript alone is not sufficient access control.

## Payments status

**Not implemented.**

There should be no payment provider, checkout flow, subscription requirement, or billing dependency added until the product's pricing and tier limits are finalized.


## v43 infrastructure notes

The core application now records nutrition-goal history and maintains daily nutrition aggregates. Premium automation can later consume those bounded datasets rather than repeatedly scanning the raw food-entry table. Conversation history is cursor-paginated, and normal message updates use Realtime events instead of client polling.

## Verified trainer program and future trainer monetization

Trainer accounts are separate from verified status. A user may create a trainer account, but an unverified trainer is treated as a normal account for privileges: trainer-only tools, client connections, and trainer-specific capabilities remain unavailable until verification is approved by an administrator.

Verified trainers receive a visible **Verified Trainer** badge. Verification is an administrative trust decision, not a paid feature. Normal users cannot publish directly to the Community Foods database; Community Food publishing is intended for verified trainers and remains subject to validation and moderation.

### Planned verified-trainer pricing incentive

When payments are eventually implemented, verified trainers are planned to receive a heavily discounted subscription, potentially at the Basic price or below. The intended incentive is for trainers to use MacroSync themselves and encourage their clients to join.

The planned value proposition is:

- Verified trainers receive full access to the MacroSync app and trainer-only features for a very low subscription price.
- Clients continue to choose Free, Basic, or Premium independently and pay the normal user price.
- Trainer use of MacroSync can therefore act as an ongoing, product-driven acquisition channel for clients.
- A trainer/client connection does not automatically give the client a free subscription.
- Any future trainer-sponsored client seats or discounts should be implemented as a separate feature rather than silently changing the normal subscription price.

### Future trainer services and payments

Payments are **not implemented yet**. The architecture should eventually support trainers offering paid services or plans through MacroSync without coupling payment state to the trainer/client connection itself.

Future concepts may include:

- Trainer services or coaching plans
- Client subscriptions to a trainer service
- Payment records and payout records
- Trainer/client billing status
- Workout programming and assignments
- Workout tracking and workout history
- Trainer review of shared nutrition, progress, and workout data
- Trainer feedback and communication

Payment processing should eventually use a dedicated payment provider rather than storing raw card/payment credentials in MacroSync. Trainer verification and payment/subscription status should remain separate concepts.
