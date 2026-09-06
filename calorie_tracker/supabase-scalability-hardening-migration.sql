-- MacroSync scalability hardening migration (v43)
-- Goal: keep the existing relational design, but make hot paths bounded,
-- paginated, indexed, aggregate-friendly, and horizontally scalable.
-- Safe to run after the current schema/migrations.

-- ---------------------------------------------------------------------------
-- 1) Hot-path indexes
-- ---------------------------------------------------------------------------
create index if not exists food_entries_user_date_created_id_idx
  on public.food_entries(user_id, logged_date, created_at, id);

create index if not exists messages_sender_recipient_created_id_idx
  on public.messages(sender_id, recipient_id, created_at desc, id desc);
create index if not exists messages_recipient_sender_created_id_idx
  on public.messages(recipient_id, sender_id, created_at desc, id desc);

create index if not exists friend_connections_requester_status_idx
  on public.friend_connections(requester_id, status, created_at desc);
create index if not exists friend_connections_addressee_status_idx
  on public.friend_connections(addressee_id, status, created_at desc);

create index if not exists meals_user_date_number_idx
  on public.meals(user_id, meal_date, meal_number);
create index if not exists recipe_items_user_recipe_idx
  on public.recipe_items(user_id, recipe_id);
create index if not exists saved_meal_items_user_meal_idx
  on public.saved_meal_items(user_id, saved_meal_id);

create index if not exists moderation_flags_user_status_created_idx
  on public.moderation_flags(user_id, status, created_at desc);

create index if not exists feedback_user_created_idx
  on public.feedback(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2) Trigram search indexes for the existing ILIKE directory/database search.
--    This keeps the current API while making '%query%' searches indexable.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;

create index if not exists profiles_display_name_trgm_idx
  on public.profiles using gin (display_name extensions.gin_trgm_ops);
create index if not exists profiles_business_name_trgm_idx
  on public.profiles using gin (business_name extensions.gin_trgm_ops);
create index if not exists community_foods_public_name_trgm_idx
  on public.community_foods using gin (name extensions.gin_trgm_ops)
  where is_public = true;
create index if not exists trainer_profiles_location_trgm_idx
  on public.trainer_profiles using gin (location extensions.gin_trgm_ops)
  where is_public = true;
create index if not exists trainer_profiles_bio_trgm_idx
  on public.trainer_profiles using gin (bio extensions.gin_trgm_ops)
  where is_public = true;

-- ---------------------------------------------------------------------------
-- 3) Bounded daily nutrition aggregates.
--    Progress/streak screens should not rescan raw food_entries as history grows.
-- ---------------------------------------------------------------------------
create table if not exists public.daily_nutrition_summaries (
  user_id uuid not null references auth.users(id) on delete cascade,
  logged_date date not null,
  entry_count integer not null default 0 check (entry_count >= 0),
  calories numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, logged_date)
);

create index if not exists daily_nutrition_summaries_user_date_idx
  on public.daily_nutrition_summaries(user_id, logged_date desc);

alter table public.daily_nutrition_summaries enable row level security;
drop policy if exists "daily summaries own read" on public.daily_nutrition_summaries;
create policy "daily summaries own read"
  on public.daily_nutrition_summaries
  for select to authenticated
  using (auth.uid() = user_id);

create or replace function public.apply_food_entry_summary_delta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_user uuid;
  old_date date;
  old_cal numeric;
  old_pro numeric;
  old_car numeric;
  old_fat numeric;
  new_user uuid;
  new_date date;
  new_cal numeric;
  new_pro numeric;
  new_car numeric;
  new_fat numeric;
begin
  if tg_op in ('UPDATE','DELETE') then
    old_user := old.user_id;
    old_date := old.logged_date;
    old_cal := coalesce(old.calories,0);
    old_pro := coalesce(old.protein,0);
    old_car := coalesce(old.carbs,0);
    old_fat := coalesce(old.fat,0);

    update public.daily_nutrition_summaries
       set entry_count = greatest(entry_count - 1, 0),
           calories = calories - old_cal,
           protein = protein - old_pro,
           carbs = carbs - old_car,
           fat = fat - old_fat,
           updated_at = now()
     where user_id = old_user and logged_date = old_date;

    delete from public.daily_nutrition_summaries
     where user_id = old_user and logged_date = old_date and entry_count <= 0;
  end if;

  if tg_op in ('INSERT','UPDATE') then
    new_user := new.user_id;
    new_date := new.logged_date;
    new_cal := coalesce(new.calories,0);
    new_pro := coalesce(new.protein,0);
    new_car := coalesce(new.carbs,0);
    new_fat := coalesce(new.fat,0);

    insert into public.daily_nutrition_summaries(
      user_id, logged_date, entry_count, calories, protein, carbs, fat, updated_at
    ) values (
      new_user, new_date, 1, new_cal, new_pro, new_car, new_fat, now()
    )
    on conflict (user_id, logged_date) do update set
      entry_count = public.daily_nutrition_summaries.entry_count + 1,
      calories = public.daily_nutrition_summaries.calories + excluded.calories,
      protein = public.daily_nutrition_summaries.protein + excluded.protein,
      carbs = public.daily_nutrition_summaries.carbs + excluded.carbs,
      fat = public.daily_nutrition_summaries.fat + excluded.fat,
      updated_at = now();
  end if;

  return coalesce(new, old);
end;
$$;

 drop trigger if exists food_entries_daily_summary_trigger on public.food_entries;
create trigger food_entries_daily_summary_trigger
after insert or update or delete on public.food_entries
for each row execute function public.apply_food_entry_summary_delta();

-- Backfill existing data once. ON CONFLICT is intentionally additive-safe for reruns.
insert into public.daily_nutrition_summaries(user_id, logged_date, entry_count, calories, protein, carbs, fat, updated_at)
select user_id, logged_date, count(*)::integer,
       coalesce(sum(calories),0), coalesce(sum(protein),0), coalesce(sum(carbs),0), coalesce(sum(fat),0), now()
from public.food_entries
group by user_id, logged_date
on conflict (user_id, logged_date) do update set
  entry_count = excluded.entry_count,
  calories = excluded.calories,
  protein = excluded.protein,
  carbs = excluded.carbs,
  fat = excluded.fat,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 4) Goal audit/history. This is the durable foundation for future Premium
--    trend detection and one-click/approved target adjustments.
-- ---------------------------------------------------------------------------
create table if not exists public.nutrition_goal_history (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  calorie_goal numeric not null,
  protein_goal numeric not null,
  carbs_goal numeric not null,
  fat_goal numeric not null,
  current_weight numeric,
  goal_weight numeric,
  low_carb boolean not null default false,
  source text not null default 'manual' check (source in ('manual','auto','premium_auto','migration')),
  created_at timestamptz not null default now()
);
create index if not exists nutrition_goal_history_user_created_idx
  on public.nutrition_goal_history(user_id, created_at desc, id desc);

alter table public.nutrition_goal_history enable row level security;
drop policy if exists "goal history own read" on public.nutrition_goal_history;
create policy "goal history own read"
  on public.nutrition_goal_history
  for select to authenticated
  using (auth.uid() = user_id);

create or replace function public.record_nutrition_goal_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or
     old.calorie_goal is distinct from new.calorie_goal or
     old.protein_goal is distinct from new.protein_goal or
     old.carbs_goal is distinct from new.carbs_goal or
     old.fat_goal is distinct from new.fat_goal or
     old.current_weight is distinct from new.current_weight or
     old.goal_weight is distinct from new.goal_weight or
     old.low_carb is distinct from new.low_carb then
    insert into public.nutrition_goal_history(
      user_id, calorie_goal, protein_goal, carbs_goal, fat_goal,
      current_weight, goal_weight, low_carb, source
    ) values (
      new.user_id, new.calorie_goal, new.protein_goal, new.carbs_goal, new.fat_goal,
      new.current_weight, new.goal_weight, new.low_carb, 'manual'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists nutrition_goals_history_trigger on public.nutrition_goals;
create trigger nutrition_goals_history_trigger
after insert or update on public.nutrition_goals
for each row execute function public.record_nutrition_goal_history();

-- Seed history for existing current targets if a user has no history yet.
insert into public.nutrition_goal_history(
  user_id, calorie_goal, protein_goal, carbs_goal, fat_goal,
  current_weight, goal_weight, low_carb, source
)
select ng.user_id, ng.calorie_goal, ng.protein_goal, ng.carbs_goal, ng.fat_goal,
       ng.current_weight, ng.goal_weight, ng.low_carb, 'migration'
from public.nutrition_goals ng
where not exists (
  select 1 from public.nutrition_goal_history h where h.user_id = ng.user_id
);

-- ---------------------------------------------------------------------------
-- 5) Bounded conversation RPC. Newest 50 messages are returned by default.
--    Older messages use a cursor instead of OFFSET.
-- ---------------------------------------------------------------------------
drop function if exists public.get_conversation_messages(uuid);
drop function if exists public.get_conversation_messages(uuid,timestamptz,bigint,integer);
create or replace function public.get_conversation_messages(
  p_friend_id uuid,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 50
)
returns table(id bigint, sender_id uuid, recipient_id uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path=public
as $$
declare
  viewer_dob date;
  viewer_minor boolean;
  m record;
  blocked text;
  safe_limit integer := greatest(1, least(coalesce(p_limit,50),100));
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if public.is_limited_minor() then raise exception 'Messaging is not available to limited accounts for users ages 13–15.'; end if;

  select date_of_birth into viewer_dob from public.profiles where profiles.id=auth.uid();
  viewer_minor := viewer_dob is null or age(current_date,viewer_dob) < interval '18 years';

  for m in
    select q.id,q.sender_id,q.recipient_id,q.body,q.created_at
    from (
      select messages.id,messages.sender_id,messages.recipient_id,messages.body,messages.created_at
      from public.messages
      where ((messages.sender_id=auth.uid() and messages.recipient_id=p_friend_id)
          or (messages.sender_id=p_friend_id and messages.recipient_id=auth.uid()))
        and (
          p_before is null
          or messages.created_at < p_before
          or (messages.created_at = p_before and p_before_id is not null and messages.id < p_before_id)
        )
      order by messages.created_at desc, messages.id desc
      limit safe_limit
    ) q
    order by q.created_at asc, q.id asc
  loop
    if viewer_minor then
      blocked := public.validate_macro_text(m.body,'message',true);
      if blocked is not null then
        id:=m.id; sender_id:=m.sender_id; recipient_id:=m.recipient_id;
        body:='[Message unavailable: this message contains content that is not available to accounts under 18.]';
        created_at:=m.created_at; return next;
      end if;
    end if;
    id:=m.id; sender_id:=m.sender_id; recipient_id:=m.recipient_id; body:=m.body; created_at:=m.created_at; return next;
  end loop;
end;
$$;
grant execute on function public.get_conversation_messages(uuid,timestamptz,bigint,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Operational retention helpers. Schedule these with pg_cron/your platform
--    scheduler in production; they are deliberately explicit rather than
--    silently deleting user data during migration.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_operational_data(
  p_notification_days integer default 90,
  p_resolved_moderation_days integer default 180
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  deleted_notifications bigint := 0;
  deleted_flags bigint := 0;
begin
  if not public.is_admin() then raise exception 'Administrator access required.'; end if;

  delete from public.notifications
   where created_at < now() - make_interval(days => greatest(30, least(p_notification_days,3650)));

  get diagnostics deleted_notifications = row_count;

  delete from public.moderation_flags
   where status='resolved'
     and resolved_at is not null
     and resolved_at < now() - make_interval(days => greatest(90, least(p_resolved_moderation_days,3650)));
  get diagnostics deleted_flags = row_count;

  return jsonb_build_object(
    'notifications_deleted', deleted_notifications,
    'resolved_moderation_flags_deleted', deleted_flags,
    'ran_at', now()
  );
end;
$$;
revoke all on function public.cleanup_operational_data(integer,integer) from public;
grant execute on function public.cleanup_operational_data(integer,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Realtime without exposing message bodies to restricted/under-18 users.
--    Clients receive a tiny event and then call the age-aware conversation RPC.
-- ---------------------------------------------------------------------------
create table if not exists public.message_events (
  id bigint generated by default as identity primary key,
  message_id bigint not null references public.messages(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists message_events_recipient_created_idx
  on public.message_events(recipient_id, created_at desc, id desc);
create index if not exists message_events_sender_created_idx
  on public.message_events(sender_id, created_at desc, id desc);

alter table public.message_events enable row level security;
drop policy if exists "message events participants read" on public.message_events;
create policy "message events participants read"
  on public.message_events
  for select to authenticated
  using (
    not public.is_limited_minor()
    and (auth.uid() = sender_id or auth.uid() = recipient_id)
  );

create or replace function public.emit_message_event()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.message_events(message_id,sender_id,recipient_id,created_at)
  values(new.id,new.sender_id,new.recipient_id,new.created_at);
  return new;
end;
$$;

drop trigger if exists messages_realtime_event_trigger on public.messages;
create trigger messages_realtime_event_trigger
after insert on public.messages
for each row execute function public.emit_message_event();

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='message_events') then
      alter publication supabase_realtime add table public.message_events;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='meals') then
      alter publication supabase_realtime add table public.meals;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8) Document the remaining deliberate scaling boundary.
--    food_entries is kept as a normal table for compatibility now. At very high
--    row counts, it can be partitioned by logged_date in a planned migration.
--    The composite indexes above and aggregate table make that future change
--    non-urgent and avoid forcing a risky partition rewrite into this release.
-- ---------------------------------------------------------------------------
