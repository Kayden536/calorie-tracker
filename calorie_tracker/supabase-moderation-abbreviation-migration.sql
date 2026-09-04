-- MacroSync moderation abbreviation / obfuscation hardening migration
-- Run this in Supabase SQL Editor after the current MacroSync schema.
-- This keeps one authoritative validate_macro_text(text,text,boolean) function.

create or replace function public.moderation_normalize(p_text text)
returns text
language sql immutable
as $$
  select regexp_replace(
    translate(
      lower(coalesce(p_text,'')),
      '0134578@$!+',
      'oieastbasit'
    ),
    '[^a-z0-9]+', '', 'g'
  );
$$;

-- Authoritative non-AI moderation function. It uses normalization, token checks,
-- high-risk term groups, contextual phrase rules, and PII patterns. It deliberately
-- errs on the side of blocking questionable content rather than silently rewriting it.
create or replace function public.validate_macro_text(p_text text, p_kind text, p_is_minor boolean default false)
returns text
language plpgsql
immutable
as $$
declare
  raw text := lower(trim(coalesce(p_text,'')));
  normalized text := public.moderation_normalize(p_text);
  profanity text[] := array['fuck','fucker','fucking','motherfucker','shit','shitty','bullshit','bitch','bitches','asshole','dumbass','bastard','cunt','dick','dickhead','pussy','cock','slut','whore','damn','crap','piss','jackass','asshat','prick','twat','wanker','fck','fuk','fking','fkng','sht','btch','bch','a55','dck','dckhead','p55y','wh0re','pr1ck'];
  hate text[] := array['nigger','niggers','nigga','niggas','chink','chinks','spic','spics','kike','kikes','gook','gooks','wetback','wetbacks','beaner','beaners','raghead','ragheads','coon','coons','fag','fags','faggot','faggots','dyke','dykes','tranny','trannies','ch1nk','sp1c','k1ke','g00k','w3tback','b3aner','c00n','r4ghead','f4g','f4ggot','dyk3','tr4nny'];
  term text;
  token text;
  skeleton text;
  normalized_spaced text := regexp_replace(
    translate(lower(coalesce(p_text,'')), '0134578@$!+', 'oieastbasit'),
    '[^a-z0-9]+', ' ', 'g'
  );
  hate_abbreviation text[] := array['nig','nigg','n1g','n1gg','n1gga'];
  sexual_abbreviation text[] := array['bbc'];
begin
  if char_length(raw)=0 then return 'Text cannot be empty.'; end if;

  if p_kind='display_name' then
    if char_length(raw)>80 then return 'Display names must be 80 characters or fewer.'; end if;
  elsif p_kind in ('message','feedback') then
    if char_length(raw)>4000 then return 'Text must be 4000 characters or fewer.'; end if;
  end if;

  foreach term in array hate loop
    if normalized like '%'||public.moderation_normalize(term)||'%' then
      return 'This text contains hateful or discriminatory language and cannot be submitted.';
    end if;
  end loop;

  -- Also detect common vowel-removal abbreviations (for example, shortening a
  -- prohibited word by removing its vowels). This is intentionally limited to
  -- compact tokens to reduce false positives in ordinary words.
  foreach token in array regexp_split_to_array(trim(normalized_spaced), ' +') loop
    if char_length(token) >= 3 then
      foreach term in array hate loop
        skeleton := regexp_replace(public.moderation_normalize(term), '[aeiou]', '', 'g');
        if char_length(skeleton) >= 3 and token = skeleton then
          return 'This text contains hateful or discriminatory language and cannot be submitted.';
        end if;
      end loop;
      foreach term in array hate_abbreviation loop
        if token = public.moderation_normalize(term) then
          return 'This text contains hateful or discriminatory language and cannot be submitted.';
        end if;
      end loop;
    end if;
  end loop;

  -- Short sexual abbreviations are checked separately because they are often
  -- embedded in otherwise harmless-looking display names. This applies to display
  -- names as well as messages/feedback, and normalization catches common leetspeak.
  if p_kind='display_name' then
    foreach term in array sexual_abbreviation loop
      if normalized like '%'||public.moderation_normalize(term)||'%' then
        return 'That display name contains language or content that is not allowed.';
      end if;
    end loop;
  end if;

  -- Sexual terminology and explicit/suggestive solicitation are blocked for all ages.
  if normalized ~ '(pornography|porn|onlyfans|nudes|nude|naked|sexting|sex|sexual|sexy|sexualservices|sexuallyexplicit|childsexual|minorsexual|sexualcontent|rape|rapist|pedo|pedophile|groomer)' then
    return 'This text contains sexual or otherwise inappropriate content and cannot be submitted.';
  end if;

  -- Threat/self-harm encouragement and targeted violence terminology.
  if normalized ~ '(killyourself|kys|gobackto|die[[:alpha:]]*|ethniccleansing|genocide)' then
    return 'This text contains threatening or abusive content and cannot be submitted.';
  end if;

  -- Profanity is blocked in display names and feedback. Messages are now deliberately
  -- strict too; this avoids the inconsistent "some swears are okay" boundary until an AI
  -- contextual moderation layer is introduced.
  foreach term in array profanity loop
    if normalized like '%'||public.moderation_normalize(term)||'%' then
      if p_kind='display_name' then return 'That display name contains profanity or inappropriate language and is not allowed.';
      elsif p_kind='message' then return 'This message contains profanity that is not allowed on MacroSync.';
      else return 'This feedback contains profanity that is not allowed.';
      end if;
    end if;
  end loop;

  -- PII / doxxing patterns.
  if raw ~ '(^|[^0-9])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9]|$)' then return 'This text appears to contain an IP address. Remove it before submitting.'; end if;
  if raw ~ '([0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}' then return 'This text appears to contain an IP address. Remove it before submitting.'; end if;
  if raw ~ '(^|[^0-9])[0-9]{1,5}[[:space:]]+[[:alnum:].''-]+[[:space:]]+(street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|way|parkway|pkwy|place|pl)([^[:alpha:]]|$)' then return 'This text appears to contain a home address. Remove personal location information before submitting.'; end if;
  if raw ~ '(^|[^0-9])\+?[0-9][0-9(). -]{7,}[0-9]([^0-9]|$)' then return 'This text appears to contain a phone number. Remove personal contact information before submitting.'; end if;
  if raw ~ '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' then return 'This text appears to contain an email address. Remove personal contact information before submitting.'; end if;

  return null;
end;
$$;

-- Display-name hardening for short/embedded sexual abbreviations.
-- This intentionally checks the normalized display name so common character
-- substitutions such as 8 -> b cannot be used to bypass the rule.
