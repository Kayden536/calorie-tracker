-- MacroSync serving options migration (v27)
-- Run this in Supabase SQL Editor after the main schema.

alter table public.user_foods add column if not exists serving_grams numeric not null default 100 check (serving_grams > 0);
alter table public.user_foods add column if not exists serving_options jsonb not null default '[]'::jsonb;
alter table public.user_foods add column if not exists conversion_mode text not null default 'estimate';
alter table public.user_foods drop constraint if exists user_foods_conversion_mode_check;
alter table public.user_foods add constraint user_foods_conversion_mode_check check (conversion_mode in ('none','estimate'));

alter table public.community_foods add column if not exists conversion_mode text not null default 'estimate';
alter table public.community_foods drop constraint if exists community_foods_conversion_mode_check;
alter table public.community_foods add constraint community_foods_conversion_mode_check check (conversion_mode in ('none','estimate'));

-- Replace the old RPC so new food records can store creator-provided serving options.
drop function if exists public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text);
create or replace function public.create_food_records(
  p_name text, p_calories_per_100g numeric, p_protein_per_100g numeric, p_carbs_per_100g numeric, p_fat_per_100g numeric,
  p_serving_amount numeric, p_serving_unit text, p_serving_grams numeric, p_save_personal boolean default true, p_publish_community boolean default true,
  p_personal_calories numeric default null, p_personal_protein numeric default null, p_personal_carbs numeric default null, p_personal_fat numeric default null,
  p_personal_source text default 'manual', p_serving_options jsonb default '[]'::jsonb, p_conversion_mode text default 'estimate'
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare community_id bigint; personal_id bigint; clean_name text := nullif(trim(coalesce(p_name,'')), ''); unit text := nullif(trim(coalesce(p_serving_unit,'')), ''); opts jsonb := coalesce(p_serving_options,'[]'::jsonb);
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if clean_name is null then raise exception 'Food name cannot be empty.'; end if;
  if char_length(clean_name)>120 then raise exception 'Food names must be 120 characters or fewer.'; end if;
  if not p_save_personal and not p_publish_community then raise exception 'Choose at least one database.'; end if;
  if coalesce(p_serving_grams,0)<=0 or coalesce(p_serving_amount,0)<=0 then raise exception 'Default serving weight and amount must be positive.'; end if;
  if p_conversion_mode not in ('none','estimate') then raise exception 'Invalid conversion mode.'; end if;
  if jsonb_typeof(opts)<>'array' then raise exception 'Serving options must be an array.'; end if;
  if p_calories_per_100g<0 or p_protein_per_100g<0 or p_carbs_per_100g<0 or p_fat_per_100g<0 then raise exception 'Nutrition values cannot be negative.'; end if;
  if p_protein_per_100g+p_carbs_per_100g+p_fat_per_100g>100.5 then raise exception 'The macros exceed 100 g per 100 g and cannot be saved.'; end if;
  unit:=coalesce(unit,'serving');
  if p_publish_community then
    insert into public.community_foods(user_id,name,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,serving_options,conversion_mode,is_public)
    values(auth.uid(),clean_name,p_calories_per_100g,p_protein_per_100g,p_carbs_per_100g,p_fat_per_100g,
      jsonb_build_array(jsonb_build_object('amount',p_serving_amount,'unit',unit,'grams',p_serving_grams,'calories',coalesce(p_personal_calories,p_calories_per_100g*p_serving_grams/100),'protein',coalesce(p_personal_protein,p_protein_per_100g*p_serving_grams/100),'carbs',coalesce(p_personal_carbs,p_carbs_per_100g*p_serving_grams/100),'fat',coalesce(p_personal_fat,p_fat_per_100g*p_serving_grams/100))) || opts,p_conversion_mode,true) returning id into community_id;
  end if;
  if p_save_personal then
    insert into public.user_foods(user_id,name,serving_amount,serving_unit,serving_grams,serving_options,conversion_mode,calories,protein,carbs,fat,source,community_food_id)
    values(auth.uid(),clean_name,p_serving_amount,unit,p_serving_grams,opts,p_conversion_mode,coalesce(p_personal_calories,p_calories_per_100g*p_serving_grams/100),coalesce(p_personal_protein,p_protein_per_100g*p_serving_grams/100),coalesce(p_personal_carbs,p_carbs_per_100g*p_serving_grams/100),coalesce(p_personal_fat,p_fat_per_100g*p_serving_grams/100),coalesce(nullif(p_personal_source,''),'manual'),community_id) returning id into personal_id;
  end if;
  if community_id is not null and personal_id is not null then update public.community_foods set personal_food_id=personal_id where id=community_id; end if;
  return jsonb_build_object('community_food_id',community_id,'personal_food_id',personal_id);
end; $$;
grant execute on function public.create_food_records(text,numeric,numeric,numeric,numeric,numeric,text,numeric,boolean,boolean,numeric,numeric,numeric,numeric,text,jsonb,text) to authenticated;

-- Existing personal foods did not previously store a reliable gram weight.
-- Keep their original serving only rather than offering potentially misleading conversions.
update public.user_foods
set conversion_mode = 'none'
where coalesce(jsonb_array_length(serving_options), 0) = 0;
