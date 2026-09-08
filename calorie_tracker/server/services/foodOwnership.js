
/*
 * Food ownership rules:
 *  - Community publication creates/retains a personal link for the author.
 *  - Personal foods remain private unless the user explicitly publishes them.
 *  - Publishing never requires deleting/replacing the personal record.
 *
 * The production implementation should call the Supabase RPC/functions
 * in supabase/food-and-meals.sql using the authenticated user's session.
 */
export const foodOwnershipRules = {
  communityAddsToPersonal: true,
  personalRequiresExplicitCommunityOptIn: true,
  importedFoodsDefaultToPersonal: true
};
