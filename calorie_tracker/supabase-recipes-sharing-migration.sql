-- MacroSync recipe sharing and public recipe search. Run after the main schema.
alter table public.recipes add column if not exists is_public boolean not null default false;
create index if not exists recipes_public_name_idx on public.recipes(is_public, name);
alter table public.recipes enable row level security;
drop policy if exists "recipes public read" on public.recipes;
create policy "recipes public read" on public.recipes for select to authenticated using (is_public = true or auth.uid() = user_id);
alter table public.recipe_items enable row level security;
drop policy if exists "recipe items public read" on public.recipe_items;
create policy "recipe items public read" on public.recipe_items for select to authenticated using (exists (select 1 from public.recipes r where r.id = recipe_items.recipe_id and (r.is_public = true or r.user_id = auth.uid())));
