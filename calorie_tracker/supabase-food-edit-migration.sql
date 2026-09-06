-- MacroSync food/recipe editing support.
-- Run this against an existing database upgraded from an earlier MacroSync version.
-- The current schema already contains these policies; this file makes them explicit/idempotent.

alter table public.community_foods enable row level security;
drop policy if exists "community foods update own" on public.community_foods;
create policy "community foods update own" on public.community_foods
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.user_foods enable row level security;
drop policy if exists "user foods update own rows" on public.user_foods;
create policy "user foods update own rows" on public.user_foods
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.recipes enable row level security;
drop policy if exists "recipes update own rows" on public.recipes;
create policy "recipes update own rows" on public.recipes
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table public.recipe_items enable row level security;
drop policy if exists "recipe items update own rows" on public.recipe_items;
create policy "recipe items update own rows" on public.recipe_items
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
