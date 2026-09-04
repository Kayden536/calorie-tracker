-- MacroSync Terms, privacy, and parental-consent columns
alter table public.profiles add column if not exists terms_version text;
alter table public.profiles add column if not exists privacy_version text;
alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists privacy_accepted_at timestamptz;
alter table public.profiles add column if not exists parental_consent_required boolean not null default false;
alter table public.profiles add column if not exists parental_consent_status text not null default 'not_required' check (parental_consent_status in ('not_required','pending','approved','denied'));
alter table public.profiles add column if not exists parent_guardian_email text;
alter table public.profiles add column if not exists parental_consent_approved_at timestamptz;

-- ================================================================
-- Terms, privacy acceptance, and limited accounts for ages 13-15
-- ================================================================
create or replace function public.user_age_years(p_user_id uuid default auth.uid())
returns integer
language sql stable security definer set search_path=public
as $$
  select case when p.date_of_birth is null then null else
    extract(year from age(current_date, p.date_of_birth))::integer end
  from public.profiles p
  where p.id = p_user_id;
$$;
grant execute on function public.user_age_years(uuid) to authenticated;

create or replace function public.is_limited_minor(p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer set search_path=public
as $$
  select coalesce(public.user_age_years(p_user_id) between 13 and 15, false)
    and exists (
      select 1 from public.profiles p
      where p.id=p_user_id and p.parental_consent_status <> 'approved'
    );
$$;
grant execute on function public.is_limited_minor(uuid) to authenticated;

-- Parent/guardian approval is completed by confirming the parent/guardian email
-- address used for a 13-15 account. The RPC, rather than a client-side update,
-- is the only route that can move consent from pending to approved.
create or replace function public.approve_parental_consent()
returns boolean
language plpgsql security definer set search_path=public,auth
as $$
declare
  profile_row public.profiles;
  confirmed_at timestamptz;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into profile_row from public.profiles where id=auth.uid();
  if profile_row.id is null then raise exception 'Profile not found.'; end if;
  if public.user_age_years(auth.uid()) not between 13 and 15 then return true; end if;
  select email_confirmed_at into confirmed_at from auth.users where id=auth.uid();
  if confirmed_at is null then raise exception 'The parent or legal guardian must complete the email confirmation before this account can be approved.'; end if;
  if nullif(lower(trim(profile_row.parent_guardian_email)), '') is null then raise exception 'Parent or legal guardian email is missing.'; end if;
  if lower(trim(profile_row.parent_guardian_email)) <> lower(trim(coalesce((select email from auth.users where id=auth.uid()),''))) then raise exception 'The approved email does not match the parent or legal guardian email on the account.'; end if;
  perform set_config('macrosync.parent_consent_approval','true',true);
  update public.profiles
    set parental_consent_status='approved', parental_consent_approved_at=now()
  where id=auth.uid() and parental_consent_status <> 'approved';
  return true;
end;
$$;
grant execute on function public.approve_parental_consent() to authenticated;

-- Protect the consent status from ordinary client updates. The approval RPC sets
-- a transaction-local flag that this trigger recognizes.
create or replace function public.protect_parental_consent()
returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and new.parental_consent_status is distinct from old.parental_consent_status
     and coalesce(current_setting('macrosync.parent_consent_approval', true),'') <> 'true' then
    raise exception 'Parental consent status can only be changed through the consent process.';
  end if;
  if tg_op='UPDATE' and old.parent_guardian_email is not null and new.parent_guardian_email is distinct from old.parent_guardian_email then
    raise exception 'Parent or legal guardian email cannot be changed after signup.';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_parental_consent on public.profiles;
create trigger protect_parental_consent before update of parental_consent_status,parent_guardian_email on public.profiles
for each row execute function public.protect_parental_consent();

-- A limited account can only use food logging and the food database. The database
-- remains the enforcement boundary; hiding navigation in the browser is not enough.
drop policy if exists "goals own row" on public.nutrition_goals;
drop policy if exists "goals insert own row" on public.nutrition_goals;
drop policy if exists "goals update own row" on public.nutrition_goals;
create policy "goals own row" on public.nutrition_goals for select using (auth.uid() = user_id and not public.is_limited_minor());
create policy "goals insert own row" on public.nutrition_goals for insert with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "goals update own row" on public.nutrition_goals for update using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());

-- Meals are required for food logging, so limited accounts may use their own meals.
drop policy if exists "meals own rows" on public.meals;
drop policy if exists "meals insert own rows" on public.meals;
drop policy if exists "meals update own rows" on public.meals;
create policy "meals own rows" on public.meals for select to authenticated using (
  auth.uid() = user_id
  or (not public.is_limited_minor() and exists (
    select 1 from public.friend_connections c
    join public.profiles viewer on viewer.id=auth.uid()
    join public.profiles owner on owner.id=public.meals.user_id
    where c.status='accepted'
      and ((c.requester_id=auth.uid() and c.addressee_id=public.meals.user_id) or (c.requester_id=public.meals.user_id and c.addressee_id=auth.uid()))
      and ((viewer.role='trainer' and owner.role='user') or case when c.requester_id=public.meals.user_id then c.requester_share_meals else c.addressee_share_meals end=true)
  ))
);
create policy "meals insert own rows" on public.meals for insert to authenticated with check (auth.uid() = user_id);
create policy "meals update own rows" on public.meals for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Disable social connections for limited accounts at the RLS boundary.
drop policy if exists "friends participants read" on public.friend_connections;
drop policy if exists "friends requester insert" on public.friend_connections;
drop policy if exists "friends participants update" on public.friend_connections;
create policy "friends participants read" on public.friend_connections for select to authenticated using ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor());
create policy "friends requester insert" on public.friend_connections for insert to authenticated with check (auth.uid() = requester_id and not public.is_limited_minor() and not public.is_limited_minor(addressee_id));
create policy "friends participants update" on public.friend_connections for update to authenticated using ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor()) with check ((auth.uid() = requester_id or auth.uid() = addressee_id) and not public.is_limited_minor() and not public.is_limited_minor(requester_id) and not public.is_limited_minor(addressee_id));

-- Messaging is disabled for limited accounts and their direct reads.
drop policy if exists "messages participants read" on public.messages;
drop policy if exists "messages sender insert" on public.messages;
drop policy if exists "messages participants update" on public.messages;
drop policy if exists "messages sender delete" on public.messages;
create policy "messages participants read" on public.messages for select to authenticated using (not public.is_limited_minor() and (auth.uid() = sender_id or auth.uid() = recipient_id));
create policy "messages sender insert" on public.messages for insert to authenticated with check (not public.is_limited_minor() and auth.uid() = sender_id and not public.is_limited_minor(recipient_id) and exists (select 1 from public.friend_connections c where c.status = 'accepted' and ((c.requester_id = sender_id and c.addressee_id = recipient_id) or (c.requester_id = recipient_id and c.addressee_id = sender_id))));
create policy "messages participants update" on public.messages for update to authenticated using (not public.is_limited_minor() and (auth.uid() = sender_id or auth.uid() = recipient_id)) with check (not public.is_limited_minor() and (auth.uid() = sender_id or auth.uid() = recipient_id));
create policy "messages sender delete" on public.messages for delete to authenticated using (not public.is_limited_minor() and auth.uid() = sender_id);

-- Progress tracking is unavailable to limited accounts.
drop policy if exists "weight logs own rows" on public.weight_logs;
drop policy if exists "weight logs insert own rows" on public.weight_logs;
drop policy if exists "weight logs update own rows" on public.weight_logs;
drop policy if exists "weight logs delete own rows" on public.weight_logs;
create policy "weight logs own rows" on public.weight_logs for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "weight logs insert own rows" on public.weight_logs for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "weight logs update own rows" on public.weight_logs for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "weight logs delete own rows" on public.weight_logs for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "body measurements own rows" on public.body_measurements;
drop policy if exists "body measurements insert own rows" on public.body_measurements;
drop policy if exists "body measurements update own rows" on public.body_measurements;
drop policy if exists "body measurements delete own rows" on public.body_measurements;
create policy "body measurements own rows" on public.body_measurements for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "body measurements insert own rows" on public.body_measurements for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "body measurements update own rows" on public.body_measurements for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "body measurements delete own rows" on public.body_measurements for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

-- Recipes and saved meals are unavailable to limited accounts.
drop policy if exists "recipes own rows" on public.recipes;
drop policy if exists "recipes insert own rows" on public.recipes;
drop policy if exists "recipes update own rows" on public.recipes;
drop policy if exists "recipes delete own rows" on public.recipes;
create policy "recipes own rows" on public.recipes for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipes insert own rows" on public.recipes for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipes update own rows" on public.recipes for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipes delete own rows" on public.recipes for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "recipe items own rows" on public.recipe_items;
drop policy if exists "recipe items insert own rows" on public.recipe_items;
drop policy if exists "recipe items update own rows" on public.recipe_items;
drop policy if exists "recipe items delete own rows" on public.recipe_items;
create policy "recipe items own rows" on public.recipe_items for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipe items insert own rows" on public.recipe_items for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor() and exists (select 1 from public.recipes r where r.id=recipe_items.recipe_id and r.user_id=auth.uid()));
create policy "recipe items update own rows" on public.recipe_items for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "recipe items delete own rows" on public.recipe_items for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "saved meals own rows" on public.saved_meals;
drop policy if exists "saved meals insert own rows" on public.saved_meals;
drop policy if exists "saved meals update own rows" on public.saved_meals;
drop policy if exists "saved meals delete own rows" on public.saved_meals;
create policy "saved meals own rows" on public.saved_meals for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meals insert own rows" on public.saved_meals for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meals update own rows" on public.saved_meals for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meals delete own rows" on public.saved_meals for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

drop policy if exists "saved meal items own rows" on public.saved_meal_items;
drop policy if exists "saved meal items insert own rows" on public.saved_meal_items;
drop policy if exists "saved meal items update own rows" on public.saved_meal_items;
drop policy if exists "saved meal items delete own rows" on public.saved_meal_items;
create policy "saved meal items own rows" on public.saved_meal_items for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meal items insert own rows" on public.saved_meal_items for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor() and exists (select 1 from public.saved_meals m where m.id=saved_meal_items.saved_meal_id and m.user_id=auth.uid()));
create policy "saved meal items update own rows" on public.saved_meal_items for update to authenticated using (auth.uid() = user_id and not public.is_limited_minor()) with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "saved meal items delete own rows" on public.saved_meal_items for delete to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

-- Notifications and feedback are not available to limited accounts.
drop policy if exists "notifications recipient read" on public.notifications;
drop policy if exists "notifications recipient update" on public.notifications;
create policy "notifications recipient read" on public.notifications for select to authenticated using (auth.uid() = recipient_id and not public.is_limited_minor());
create policy "notifications recipient update" on public.notifications for update to authenticated using (auth.uid() = recipient_id and not public.is_limited_minor()) with check (auth.uid() = recipient_id and not public.is_limited_minor());

drop policy if exists "feedback insert own rows" on public.feedback;
drop policy if exists "feedback own rows read" on public.feedback;
create policy "feedback insert own rows" on public.feedback for insert to authenticated with check (auth.uid() = user_id and not public.is_limited_minor());
create policy "feedback own rows read" on public.feedback for select to authenticated using (auth.uid() = user_id and not public.is_limited_minor());

-- Do not expose a limited account's parent/guardian email through profile discovery.
create or replace function public.search_people(p_query text)
returns table(id uuid,display_name text,email text,role text,business_name text)
language sql stable security definer set search_path=public as $$
  select p.id,p.display_name,
         case when p.email_search_enabled and not p.parental_consent_required then p.email else null end,
         p.role,p.business_name
  from public.profiles p
  where p.id <> auth.uid()
    and not public.is_limited_minor()
    and (trim(coalesce(p_query,''))='' or p.display_name ilike '%'||trim(p_query)||'%' or (p.email_search_enabled and not p.parental_consent_required and p.email ilike '%'||trim(p_query)||'%'))
  order by p.display_name
  limit 50;
$$;
grant execute on function public.search_people(text) to authenticated;

-- Meal sharing policies must also reject limited accounts.
drop policy if exists "food entries own rows" on public.food_entries;
create policy "food entries own rows" on public.food_entries for select to authenticated using (
  auth.uid() = user_id
  or (not public.is_limited_minor() and exists (
    select 1 from public.friend_connections c
    join public.profiles viewer on viewer.id = auth.uid()
    join public.profiles owner on owner.id = food_entries.user_id
    where c.status = 'accepted'
      and ((c.requester_id = auth.uid() and c.addressee_id = food_entries.user_id)
        or (c.requester_id = food_entries.user_id and c.addressee_id = auth.uid()))
      and ((viewer.role = 'trainer' and owner.role = 'user') or case when c.requester_id = food_entries.user_id then c.requester_share_meals else c.addressee_share_meals end = true)
  ))
);


-- Prevent unrelated users from reading profile contact fields directly.
drop policy if exists "authenticated profiles discovery" on public.profiles;
create policy "authenticated profiles discovery" on public.profiles for select to authenticated using (
  auth.uid() = id
  or exists (
    select 1 from public.friend_connections c
    where c.status='accepted'
      and ((c.requester_id=auth.uid() and c.addressee_id=profiles.id)
        or (c.requester_id=profiles.id and c.addressee_id=auth.uid()))
  )
);


drop function if exists public.set_meal_sharing(bigint, boolean);
create or replace function public.set_meal_sharing(connection_id bigint, enabled boolean)
returns public.friend_connections
language plpgsql
security definer
set search_path = public
as $$
declare
  connection_row public.friend_connections;
  my_role text;
  other_role text;
  other_user_id uuid;
begin
  if public.is_limited_minor() then raise exception 'Meal sharing is not available to limited accounts for users ages 13–15.'; end if;
  select *
    into connection_row
    from public.friend_connections
   where id = connection_id
     and status = 'accepted'
     and (requester_id = auth.uid() or addressee_id = auth.uid());

  if connection_row.id is null then
    raise exception 'Accepted friend connection not found.';
  end if;

  other_user_id := case
    when connection_row.requester_id = auth.uid() then connection_row.addressee_id
    else connection_row.requester_id
  end;

  select role into my_role from public.profiles where id = auth.uid();
  select role into other_role from public.profiles where id = other_user_id;

  -- A Personal user connected to a Personal Trainer must share their own
  -- food log with that trainer. The trainer can still independently choose
  -- whether to share the trainer's own food log with the client.
  update public.friend_connections
     set requester_share_meals = case
           when requester_id = auth.uid() then
             case
               when my_role = 'user' and other_role = 'trainer' then true
               else enabled
             end
           else requester_share_meals
         end,
         addressee_share_meals = case
           when addressee_id = auth.uid() then
             case
               when my_role = 'user' and other_role = 'trainer' then true
               else enabled
             end
           else addressee_share_meals
         end,
         share_meals = (
           case when requester_id = auth.uid() then enabled else requester_share_meals end
           or case when addressee_id = auth.uid() then enabled else addressee_share_meals end
         ),
         updated_at = now()
   where id = connection_row.id
  returning * into connection_row;

  return connection_row;
end;
$$;

grant execute on function public.set_meal_sharing(bigint, boolean) to authenticated;


create or replace function public.get_conversation_messages(p_friend_id uuid)
returns table(id bigint, sender_id uuid, recipient_id uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path=public
as $$
declare
  viewer_dob date;
  viewer_minor boolean;
  m record;
  blocked text;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if public.is_limited_minor() then raise exception 'Messaging is not available to limited accounts for users ages 13–15.'; end if;
  select date_of_birth into viewer_dob from public.profiles where profiles.id=auth.uid();
  viewer_minor := viewer_dob is null or age(current_date,viewer_dob) < interval '18 years';
  for m in
    select messages.id,messages.sender_id,messages.recipient_id,messages.body,messages.created_at
    from public.messages
    where (messages.sender_id=auth.uid() and messages.recipient_id=p_friend_id)
       or (messages.sender_id=p_friend_id and messages.recipient_id=auth.uid())
    order by messages.created_at
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
grant execute on function public.get_conversation_messages(uuid) to authenticated;


create or replace function public.send_message(p_recipient_id uuid, p_body text)
returns public.messages language plpgsql security definer set search_path=public as $$
declare new_message public.messages; validation_message text; my_status text; recipient_status text;
begin
 if auth.uid() is null then raise exception 'You must be signed in to send messages.'; end if;
 if public.is_limited_minor() then raise exception 'Messaging is not available to limited accounts for users ages 13–15.'; end if;
 select account_status into my_status from public.profiles where id=auth.uid();
 if coalesce(my_status,'active')='banned' then raise exception 'Your account is banned.'; end if;
 if coalesce(my_status,'active')='suspended' and exists(select 1 from public.profiles where id=auth.uid() and moderation_status_until is null) then raise exception 'Your account is suspended.'; end if;
 select account_status into recipient_status from public.profiles where id=p_recipient_id;
 if coalesce(recipient_status,'active')<>'active' then raise exception 'This user cannot receive messages right now.'; end if;
 if p_recipient_id=auth.uid() then raise exception 'You cannot message yourself.'; end if;
 validation_message:=public.validate_macro_text(p_body, 'message', false); if validation_message is not null then raise exception '%',validation_message; end if;
 if not exists(select 1 from public.friend_connections c where c.status='accepted' and ((c.requester_id=auth.uid() and c.addressee_id=p_recipient_id) or (c.requester_id=p_recipient_id and c.addressee_id=auth.uid()))) then raise exception 'You can only message an accepted friend.'; end if;
 insert into public.messages(sender_id,recipient_id,body) values(auth.uid(),p_recipient_id,trim(p_body)) returning * into new_message;
 if exists(select 1 from public.profiles p where p.id=p_recipient_id and p.message_notifications_enabled=true) then insert into public.notifications(recipient_id,sender_id,type,title,body,message_id) values(p_recipient_id,auth.uid(),'message','New message',trim(p_body),new_message.id); end if;
 return new_message;
end;
$$;
grant execute on function public.send_message(uuid,text) to authenticated;

