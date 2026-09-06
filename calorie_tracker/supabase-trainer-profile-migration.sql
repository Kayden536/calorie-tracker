-- MacroSync trainer directory/profile foundation.
-- Compact, structured fields keep storage and search costs low.
create table if not exists public.trainer_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bio text,
  location text,
  phone text,
  instagram text,
  facebook text,
  tiktok text,
  youtube text,
  website text,
  training_types smallint[] not null default '{}',
  price_range smallint,
  years_experience smallint,
  is_public boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint trainer_bio_length check (bio is null or char_length(bio) <= 5000),
  constraint trainer_bio_word_limit check (bio is null or char_length(trim(bio)) = 0 or cardinality(regexp_split_to_array(trim(bio), '\s+')) <= 250),
  constraint trainer_location_length check (location is null or char_length(location) <= 160),
  constraint trainer_phone_length check (phone is null or char_length(phone) <= 32),
  constraint trainer_years_experience check (years_experience is null or years_experience between 0 and 100),
  constraint trainer_price_range check (price_range is null or price_range between 1 and 6),
  constraint trainer_training_types_count check (cardinality(training_types) <= 12)
);

alter table public.trainer_profiles enable row level security;
drop policy if exists "trainer profiles own read" on public.trainer_profiles;
drop policy if exists "trainer profiles own insert" on public.trainer_profiles;
drop policy if exists "trainer profiles own update" on public.trainer_profiles;
drop policy if exists "trainer profiles own delete" on public.trainer_profiles;
drop policy if exists "trainer profiles public read" on public.trainer_profiles;
create policy "trainer profiles own read" on public.trainer_profiles for select to authenticated using (auth.uid() = user_id);
create policy "trainer profiles own insert" on public.trainer_profiles for insert to authenticated with check (auth.uid() = user_id and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer'));
create policy "trainer profiles own update" on public.trainer_profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'trainer'));
create policy "trainer profiles own delete" on public.trainer_profiles for delete to authenticated using (auth.uid() = user_id);
create policy "trainer profiles public read" on public.trainer_profiles for select to authenticated using (is_public = true and not public.is_limited_minor());

create index if not exists trainer_profiles_public_location_idx on public.trainer_profiles(is_public, location) where is_public = true;

create or replace function public.search_trainers(p_query text default '', p_training_type smallint default null, p_price_range smallint default null)
returns table(user_id uuid, display_name text, business_name text, bio text, location text, phone text, instagram text, facebook text, tiktok text, youtube text, website text, training_types smallint[], price_range smallint, years_experience smallint)
language sql stable security definer set search_path=public as $$
  select tp.user_id, p.display_name, p.business_name, tp.bio, tp.location, tp.phone, tp.instagram, tp.facebook, tp.tiktok, tp.youtube, tp.website, tp.training_types, tp.price_range, tp.years_experience
  from public.trainer_profiles tp
  join public.profiles p on p.id = tp.user_id
  where tp.is_public = true
    and p.role = 'trainer'
    and not public.is_limited_minor()
    and (trim(coalesce(p_query,'')) = '' or p.display_name ilike '%' || trim(p_query) || '%' or coalesce(p.business_name,'') ilike '%' || trim(p_query) || '%' or coalesce(tp.location,'') ilike '%' || trim(p_query) || '%' or coalesce(tp.bio,'') ilike '%' || trim(p_query) || '%')
    and (p_training_type is null or p_training_type = any(tp.training_types))
    and (p_price_range is null or tp.price_range = p_price_range)
  order by p.display_name
  limit 100;
$$;
grant execute on function public.search_trainers(text,smallint,smallint) to authenticated;

create or replace function public.get_trainer_profile(p_trainer_id uuid)
returns table(user_id uuid, display_name text, business_name text, bio text, location text, phone text, instagram text, facebook text, tiktok text, youtube text, website text, training_types smallint[], price_range smallint, years_experience smallint)
language sql stable security definer set search_path=public as $$
  select tp.user_id, p.display_name, p.business_name, tp.bio, tp.location, tp.phone, tp.instagram, tp.facebook, tp.tiktok, tp.youtube, tp.website, tp.training_types, tp.price_range, tp.years_experience
  from public.trainer_profiles tp
  join public.profiles p on p.id = tp.user_id
  where tp.user_id = p_trainer_id and p.role = 'trainer' and (tp.is_public = true or tp.user_id = auth.uid());
$$;
grant execute on function public.get_trainer_profile(uuid) to authenticated;

-- Directory connections are client -> trainer only; ordinary friend discovery remains separate.
create or replace function public.request_trainer_connection(p_trainer_id uuid)
returns public.friend_connections
language plpgsql security definer set search_path=public as $$
declare r public.friend_connections;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if exists (select 1 from public.profiles where id=auth.uid() and role='trainer') then raise exception 'Trainer accounts cannot send trainer-directory requests.'; end if;
  if not exists (select 1 from public.trainer_profiles tp join public.profiles p on p.id=tp.user_id where tp.user_id=p_trainer_id and tp.is_public=true and p.role='trainer') then raise exception 'That trainer is not currently listed.'; end if;
  insert into public.friend_connections(requester_id,addressee_id,status) values(auth.uid(),p_trainer_id,'pending') returning * into r;
  return r;
exception when unique_violation then
  raise exception 'A connection request already exists.';
end;
$$;
revoke all on function public.request_trainer_connection(uuid) from public;
grant execute on function public.request_trainer_connection(uuid) to authenticated;
