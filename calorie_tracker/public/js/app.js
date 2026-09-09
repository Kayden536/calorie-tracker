const MACROSYNC_VERSION = '0.59.0';
let telemetryDisabled = false;
let supabaseTelemetryClient = null;

async function trackEvent(name, properties = {}) {
  if (telemetryDisabled || !supabaseTelemetryClient) return;
  try {
    await supabaseTelemetryClient.rpc('log_app_event', {
      p_event_name: String(name).slice(0, 80),
      p_properties: { ...properties, app_version: MACROSYNC_VERSION }
    });
  } catch (error) { console.debug('Telemetry unavailable:', error?.message || error); }
}

async function reportClientError(error, context = {}) {
  if (telemetryDisabled || !supabaseTelemetryClient) return;
  try {
    await supabaseTelemetryClient.rpc('log_client_error', {
      p_page: location.pathname.slice(0, 200),
      p_message: String(error?.message || error || 'Unknown client error').slice(0, 1000),
      p_stack: String(error?.stack || '').slice(0, 4000),
      p_context: { ...context, app_version: MACROSYNC_VERSION, user_agent: navigator.userAgent.slice(0, 500) }
    });
  } catch (reportError) { console.debug('Client error reporting unavailable:', reportError?.message || reportError); }
}

window.addEventListener('error', event => {
  reportClientError(event.error || new Error(event.message || 'Unhandled browser error'), { source: 'window.error' });
});
window.addEventListener('unhandledrejection', event => {
  reportClientError(event.reason || new Error('Unhandled promise rejection'), { source: 'unhandledrejection' });
});

const PulsePlateApp = (() => {
  let supabase;
  let user;
  let selectedDate = new Date();
  let weekStart;
  let selectedFood = null;
  let searchTimer;
  let selectedFriendId = null;
  let selectedMealFriendId = null;
  let socialPeople = [];
  let socialConnections = [];
  let socialCurrentProfile = null;
  let userMeals = [];
  let selectedLoggingMeal = '';
  let planAheadEnabled = false;
  let messageRealtimeChannel;
  let mealRealtimeChannel;
  let conversationBeforeCursor = null;
  let conversationHasOlder = false;
  const sharedMealCollapsed = new Set();

  const GOAL_OPTIONS = [
    { value:'lose_basic', label:'Lose weight — basic', caloriesPerLb:12, proteinPerLb:0.8, fat:55, adjustment:'If weight stalls or weight loss slows, decrease carbs by 30 g/day. Completely readjust every 10–20 lb lost. Switch to maintenance after no more than 3 months of weight-loss focus and stay in maintenance for at least 45 days.' },
    { value:'lose_muscle', label:'Lose weight + maintain muscle', caloriesPerLb:12, proteinPerLb:1, fat:65, adjustment:'If weight stalls or weight loss slows, decrease carbs by 30 g/day. If muscle is starting to be lost, increase protein by 15 g/day. Completely readjust every 10–20 lb lost. Switch to maintenance after no more than 3 months of weight-loss focus and stay in maintenance for at least 45 days.' },
    { value:'lose_gain_muscle', label:'Lose fat + gain muscle', caloriesPerLb:12, proteinPerLb:1.25, fat:65, adjustment:'If weight stalls or weight loss slows, decrease carbs by 30 g/day. If muscle is starting to be lost or muscle gains stall, increase protein by 20 g/day. Completely readjust every 10–20 lb lost. Switch to maintenance after no more than 3 months of weight-loss focus and stay in maintenance for at least 45 days.' },
    { value:'gain_basic', label:'Gain weight — basic', caloriesPerLb:15, proteinPerLb:0.8, fat:65, adjustment:'If weight gain stalls or slows, increase carbs by 30 g/day. Completely readjust every 10–20 lb gained. Switch to maintenance after no more than 3 months of weight-gain focus and stay in maintenance for at least 45 days.' },
    { value:'gain_muscle_maintain_fat', label:'Gain muscle + maintain body fat', caloriesPerLb:15, proteinPerLb:1, fat:65, adjustment:'If weight gain stalls or slows, increase carbs by 30 g/day. If body fat is rising too fast, decrease carbs by 20 g/day and increase protein by 20 g/day. Completely readjust every 10–20 lb gained. Switch to maintenance after no more than 3 months of weight-gain focus and stay in maintenance for at least 45 days.' },
    { value:'lean_bulk', label:'Gain muscle + slow gain of body fat — lean bulk', caloriesPerLb:15, proteinPerLb:1.25, fat:65, adjustment:'If weight gain stalls or slows, increase carbs by 30 g/day. If body fat is rising too fast, decrease carbs by 20 g/day and increase protein by 20 g/day. If muscle is starting to be lost or muscle gains stall, increase protein by 20 g/day. Do not go over 15% body fat; if it reaches 15%, switch to a short maintenance phase and then a fat-loss phase. Completely readjust every 10–20 lb gained. Switch to maintenance after no more than 3 months of weight-gain focus and stay in maintenance for at least 45 days.' },
    { value:'maintain', label:'Maintain weight', caloriesPerLb:13, proteinPerLb:1, fat:55, adjustment:'If bodyweight is increasing, decrease carbs by 30 g/day. If bodyweight is decreasing, increase carbs by 30 g/day.' },
    { value:'recomp', label:'Maintain weight + lose body fat + gain muscle — recomp', caloriesPerLb:13, proteinPerLb:1, fat:55, adjustment:'If bodyweight is increasing, decrease carbs by 30 g/day. If bodyweight is decreasing, increase carbs by 30 g/day. If body fat is increasing, decrease carbs by 30 g/day and increase protein by 30 g/day.' }
  ];
  const GOAL_BY_VALUE = Object.fromEntries(GOAL_OPTIONS.map(goal => [goal.value, goal]));
  const GOAL_DISCLAIMER = 'Note/Disclaimer: these are starting recommendations and eceryone may need adjustments depending on each indibiduals metabolism and activity levels. recommended adjustments are with each choice the recommendations are exactly that, recommendations. you may need a larger or smaller adjustments. if you have a trainer and they have you following a certain set of calories and macros, please follow their recommendations, especially if they seem to be working for youl.';
  function calculateAutoMacroTargets(weight, goalValue, lowCarb = false) {
    const goal=GOAL_BY_VALUE[goalValue], w=Number(weight);
    if(!goal || !Number.isFinite(w) || w<=0) return null;
    const calories=w*goal.caloriesPerLb, protein=w*goal.proteinPerLb;
    let carbs=Math.max((calories-protein*4-goal.fat*9)/4,0), fat=goal.fat;
    if(goalValue==='recomp' && lowCarb){ carbs=40; fat=Math.max((calories-protein*4-carbs*4)/9,0); }
    return {calorie_goal:Math.round(calories),protein_goal:Math.round(protein*10)/10,carbs_goal:Math.round(carbs*10)/10,fat_goal:Math.round(fat*10)/10};
  }

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  // Calendar/log dates are user-local dates, not UTC dates. Supabase timestamptz
  // values remain UTC in storage, while date-only fields use the browser's
  // local calendar date so a user's day cannot shift because of the server timezone.
  const dateKey = (date = new Date()) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const formatTimestamp = (value) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const startOfWeek = (date) => {
    const d = new Date(date);
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  };
  const addDays = (date, amount) => { const d = new Date(date); d.setDate(d.getDate()+amount); return d; };
  const moneyless = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const formatDate = (date) => date.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
  // Display names are intentionally stricter than ordinary messages.  Keep this
  // list focused on clearly abusive, sexual, or otherwise inappropriate terms.
  // The database trigger is the final enforcement layer; this provides instant UI feedback.
  // Local first-pass moderation. The database performs the authoritative check.
  // Text is normalized for case, accents, separators and common leetspeak so simple
  // obfuscation does not bypass the filter.
  const PROFANITY_TERMS = [
    'fuck','fucker','fucking','motherfucker','shit','shitty','bullshit','bitch','bitches',
    'asshole','dumbass','bastard','cunt','dick','dickhead','pussy','cock','slut','whore',
    'damn','hell','crap','piss','jackass','asshat','prick','twat','wanker',
    // Common abbreviated / intentionally shortened spellings.
    'fck','fuk','fking','fkng','sht','btch','bch','a55','dck','dckhead','p55y','wh0re','pr1ck'
  ];
  const HATE_TERMS = [
    'nigger','niggers','nigga','niggas','chink','chinks','spic','spics','kike','kikes',
    'gook','gooks','wetback','wetbacks','beaner','beaners','raghead','ragheads','coon','coons',
    'fag','fags','faggot','faggots','dyke','dykes','tranny','trannies',
    // Common shortened / leetspeak variants that should not bypass the hate-speech filter.
    'nig','nigg','n1g','n1gg','n1gga','ch1nk','sp1c','k1ke','g00k','w3tback','b3aner','c00n',
    'r4ghead','f4g','f4ggot','dyk3','tr4nny'
  ];
  const HATE_ABBREVIATIONS = ['nig','nigg','n1g','n1gg','n1gga'];
  const SEXUAL_TERMS = ['porn','pornography','nude','nudes','naked','onlyfans','sexual services','sexually explicit','child sexual','minor sexual','sexting'];
  // Short sexual abbreviations are checked separately because they are often
  // embedded in otherwise harmless-looking display names (for example, an
  // abbreviation followed by a nickname). Do not treat these as ordinary words.
  const SEXUAL_ABBREVIATIONS = ['bbc'];
  const LEET_MAP = { '@':'a','4':'a','3':'e','1':'i','!':'i','0':'o','$':'s','5':'s','7':'t','+':'t','8':'b'};
  function normalizeModerationText(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[0134578@$!+]/g, c => LEET_MAP[c] || c).replace(/[^a-z0-9]+/g,'').replace(/(.)\1{2,}/g,'$1$1');
  }
  function tokenModerationText(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[0134578@$!+]/g, c => LEET_MAP[c] || c).replace(/[^a-z0-9]+/g,' ').replace(/(.)\1{2,}/g,'$1$1').trim();
  }
  function vowelStripped(value) { return value.replace(/[aeiou]/g,''); }
  function containsTerm(text, terms) {
    const normalized=normalizeModerationText(text);
    const tokens=tokenModerationText(text).split(/\s+/).filter(Boolean);
    const strippedTokens=tokens.map(vowelStripped);
    return terms.some(term => {
      const compact=normalizeModerationText(term);
      // Exact/substring matching catches punctuation, spaces, and many leetspeak variants.
      if (tokens.includes(compact) || (compact.length >= 4 && normalized.includes(compact))) return true;
      // For short forms, compare vowel-stripped tokens. This catches deliberate vowel
      // removal without making tiny fragments match inside normal words.
      const skeleton=vowelStripped(compact);
      return skeleton.length >= 3 && strippedTokens.some(token => token === skeleton);
    }) || HATE_ABBREVIATIONS.some(term => {
      const compact=normalizeModerationText(term);
      return tokens.includes(compact);
    });
  }
  const DOXXING_PATTERNS = [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}\b/gi,
    /\b\d{1,5}\s+[A-Za-z0-9.'-]+\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|way|parkway|pkwy|place|pl)\b/gi,
    /\b(?:\+?\d[\d\s().-]{7,}\d)\b/g,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  ];
  function resetPatterns(){ DOXXING_PATTERNS.forEach(rx=>{rx.lastIndex=0;}); }
  function validateDisplayName(text) {
    const value=String(text||'').trim();
    if(!value) return 'Please enter a display name.';
    if(value.length>80) return 'Display names must be 80 characters or fewer.';
    if(containsTerm(value,PROFANITY_TERMS)||containsTerm(value,HATE_TERMS)||containsTerm(value,SEXUAL_TERMS)||containsTerm(value,SEXUAL_ABBREVIATIONS)) return 'That display name contains language or content that is not allowed.';
    if(DOXXING_PATTERNS.some(rx=>rx.test(value))){resetPatterns();return 'Display names cannot contain contact or location information.';} resetPatterns(); return null;
  }
  function validateMessageText(text, isMinor=false) {
    const value=String(text||'').trim();
    if(!value) return 'Message cannot be empty.';
    if(value.length>4000) return 'Messages must be 4000 characters or fewer.';
    if(containsTerm(value,HATE_TERMS)) return 'This message contains hateful or discriminatory language and cannot be sent.';
    if(containsTerm(value,SEXUAL_TERMS)) return 'This message contains sexual or otherwise inappropriate content and cannot be sent.';
    if(isMinor && containsTerm(value,PROFANITY_TERMS)) return 'Profanity is not available for accounts under 18.';
    if(!isMinor && containsTerm(value,PROFANITY_TERMS)) return 'This message contains profanity that is not allowed on MacroSync.';
    if(DOXXING_PATTERNS.some(rx=>rx.test(value))){resetPatterns();return 'This message appears to contain personal information. Please remove IP addresses, home addresses, phone numbers, or email addresses.';} resetPatterns(); return null;
  }

  async function init() {
    try {
      supabase = await window.PulsePlate.ready;
      supabaseTelemetryClient = supabase;
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session) { window.location.href = 'auth.html'; return; }
      user = data.session.user;
      weekStart = startOfWeek(selectedDate);
      let profile = await ensureProfile();
      if (profile?.parental_consent_required && profile?.parental_consent_status === 'pending') {
        const { data: consentApproved, error: consentError } = await supabase.rpc('approve_parental_consent');
        if (!consentError && consentApproved) {
          const refreshed = await supabase.from('profiles').select('*').eq('id', user.id).single();
          if (!refreshed.error) profile = refreshed.data;
        }
      }
      await loadUserMeals();
      if (profile?.date_of_birth === null || profile?.date_of_birth === undefined) await requireAgeDeclaration();
      wireGlobalAuth(profile);
      if (await enforceLimitedMinorAccess(profile)) return;
      if (!profile?.onboarding_complete && !isLimitedMinorProfile(profile)) {
        await showOnboarding(profile);
        return;
      }
      const moderationRequiresNameChange = await reviewMyContent().catch(error => { console.warn('Content moderation review unavailable:', error); return false; });
      if (moderationRequiresNameChange) return;
      await renderPage();
    } catch (error) {
      console.error(error);
      reportClientError(error, { source: 'app.init' });
      document.body.insertAdjacentHTML('afterbegin', `<div class="alpha-error">MacroSync could not initialize. ${escapeHtml(error.message)}</div>`);
    }
  }

  function ageInYears(dob) {
    const d=new Date(`${dob}T00:00:00`), now=new Date();
    let age=now.getFullYear()-d.getFullYear();
    const beforeBirthday=(now.getMonth()<d.getMonth()) || (now.getMonth()===d.getMonth() && now.getDate()<d.getDate());
    if(beforeBirthday) age--;
    return age;
  }
  function isLimitedMinorProfile(profile) {
    const age = profile?.date_of_birth ? ageInYears(profile.date_of_birth) : null;
    return Number.isFinite(age) && age >= 13 && age < 16 && profile?.parental_consent_status !== 'approved';
  }

  async function enforceLimitedMinorAccess(profile) {
    const limited = isLimitedMinorProfile(profile);
    if (!limited) return false;
    const page = document.body.dataset.page || location.pathname.split('/').pop().replace('.html','');
    const allowed = new Set(['log', 'food-management']);
    if (!allowed.has(page)) {
      window.location.replace('log_food.html');
      return true;
    }
    return false;
  }

  async function requireAgeDeclaration() {
    const overlay=document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><p class="eyebrow">Age declaration required</p><h2>When were you born?</h2><p class="page-copy">MacroSync uses your date of birth only to apply age-appropriate content rules. It is an age declaration, not identity verification. Once saved, you cannot change it yourself.</p><form class="settings-stack" data-age-form><div class="field"><label>Date of birth</label><div class="date-picker" data-date-picker="declaration"><select id="declaredDobYear" aria-label="Birth year" required></select><select id="declaredDobMonth" aria-label="Birth month" required></select><select id="declaredDobDay" aria-label="Birth day" required></select></div><input id="declaredDob" type="hidden"></div><button class="primary-button" type="submit">Save date of birth</button><p class="settings-status" data-age-status role="status"></p></form></section>`;
    document.body.appendChild(overlay);
    const yearSelect = overlay.querySelector('#declaredDobYear');
    const monthSelect = overlay.querySelector('#declaredDobMonth');
    const daySelect = overlay.querySelector('#declaredDobDay');
    const hiddenDob = overlay.querySelector('#declaredDob');
    const today = new Date();
    const currentYear = today.getFullYear();
    const earliestYear = currentYear - 120;
    yearSelect.innerHTML = '<option value="">Year</option>' + Array.from({ length: currentYear - earliestYear + 1 }, (_, i) => { const year = currentYear - i; return `<option value="${year}">${year}</option>`; }).join('');
    monthSelect.innerHTML = '<option value="">Month</option>' + Array.from({ length: 12 }, (_, i) => { const value = String(i + 1).padStart(2, '0'); return `<option value="${value}">${new Date(2000, i, 1).toLocaleString(undefined, { month: 'long' })}</option>`; }).join('');
    const refreshDays = () => { const year = Number(yearSelect.value); const month = Number(monthSelect.value); const previous = daySelect.value; const daysInMonth = year && month ? new Date(year, month, 0).getDate() : 31; daySelect.innerHTML = '<option value="">Day</option>' + Array.from({ length: daysInMonth }, (_, i) => { const value = String(i + 1).padStart(2, '0'); return `<option value="${value}">${i + 1}</option>`; }).join(''); if (Number(previous) <= daysInMonth) daySelect.value = previous; };
    const syncDob = () => { hiddenDob.value = yearSelect.value && monthSelect.value && daySelect.value ? `${yearSelect.value}-${monthSelect.value}-${daySelect.value}` : ''; };
    yearSelect.addEventListener('change', () => { refreshDays(); syncDob(); });
    monthSelect.addEventListener('change', () => { refreshDays(); syncDob(); });
    daySelect.addEventListener('change', syncDob);
    refreshDays();
    overlay.querySelector('[data-age-form]').addEventListener('submit',async e=>{e.preventDefault();const status=overlay.querySelector('[data-age-status]');const dob=hiddenDob.value;if(!dob){status.textContent='Enter your date of birth.';return;}const selected=new Date(`${dob}T00:00:00`);if(selected>today){status.textContent='Your date of birth cannot be in the future.';return;}const age=ageInYears(dob);if(age<13){status.textContent='MacroSync accounts are not available for users under 13.';return;}if(age>120){status.textContent='Please enter a valid date of birth.';return;}status.textContent='Saving…';const {error}=await supabase.from('profiles').update({date_of_birth:dob}).eq('id',user.id).is('date_of_birth',null);if(error){status.textContent=error.message;return;}overlay.remove();window.location.reload();});
  }

  async function ensureProfile() {
    const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'MacroSync User';
    const { data: existing, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    if (!existing) {
      const { data: created, error: insertError } = await supabase.from('profiles').insert({ id: user.id, display_name: displayName, email: user.email || null, role: 'user', onboarding_complete: false, date_of_birth: user.user_metadata?.date_of_birth || null, terms_version: user.user_metadata?.terms_version || null, privacy_version: user.user_metadata?.privacy_version || null, terms_accepted_at: user.user_metadata?.terms_accepted_at || null, privacy_accepted_at: user.user_metadata?.privacy_accepted_at || null, parental_consent_required: user.user_metadata?.parental_consent_required || false, parental_consent_status: user.user_metadata?.parental_consent_status || 'not_required', parent_guardian_email: user.user_metadata?.parent_guardian_email || null }).select('*').single();
      if (insertError) throw insertError;
      return created;
    }
    if (existing.email !== (user.email || null)) {
      const { data: refreshed, error: refreshError } = await supabase.from('profiles').update({ email: user.email || null }).eq('id', user.id).select('*').single();
      if (!refreshError) return refreshed;
    }
    return existing;
  }

  async function showOnboarding(profile) {
    const existingGoals = await getGoals();
    const overlay = document.createElement('div');
    overlay.className = 'onboarding-overlay';
    overlay.innerHTML = `
      <section class="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboardingTitle">
        <div class="onboarding-progress"><span></span></div>
        <p class="eyebrow">First-time setup</p>
        <h1 id="onboardingTitle">Welcome to MacroSync</h1>
        <p class="page-copy">Let's personalize your dashboard. You can change these choices later from Goals and Account.</p>
        <form id="onboardingForm">
          <div class="onboarding-section">
            <h2>What is your main goal?</h2>
            <div class="goal-choice-grid">
              ${GOAL_OPTIONS.map(goal=>`<label class="choice-card"><input type="radio" name="primaryGoal" value="${goal.value}" ${(['lose','lose_basic'].includes(profile?.primary_goal)&&goal.value==='lose_basic')||(['gain','gain_basic'].includes(profile?.primary_goal)&&goal.value==='gain_basic')||profile?.primary_goal===goal.value?'checked':''}><span>${goal.label}</span></label>`).join('')}
            </div>
          </div>
          <div class="onboarding-grid">
            <div class="field"><label for="onboardCurrentWeight">Current weight <span>(optional)</span></label><input id="onboardCurrentWeight" type="number" min="0" step="0.1" value="${profile?.current_weight ?? existingGoals.current_weight ?? ''}" placeholder="Optional"></div>
            <div class="field"><label for="onboardGoalWeight">Goal weight <span>(optional)</span></label><input id="onboardGoalWeight" type="number" min="0" step="0.1" value="${profile?.goal_weight ?? existingGoals.goal_weight ?? ''}" placeholder="Optional"></div>
          </div>
          <div class="onboarding-section">
            <h2>Daily nutrition targets</h2>
            <p class="page-copy">These are starting targets. You can change them later.</p>
            <p class="goal-disclaimer">${GOAL_DISCLAIMER}</p>
            <div class="auto-macro-box"><div><p class="eyebrow">Automatic targets</p><h3>Calculate starting targets</h3><p class="page-copy">Choose a goal and enter your current weight to calculate starting targets.</p></div><button class="ghost-button" type="button" data-onboard-auto-calculate>Calculate targets</button><label class="toggle-row low-carb-toggle" data-onboard-low-carb-wrap hidden><input type="checkbox" data-onboard-low-carb><span><strong>Low-carb recomp</strong><small>Use 40 g carbs and let fat fill the remaining calories.</small></span></label><p class="settings-status" data-onboard-auto-status role="status"></p></div>
            <div class="onboarding-grid onboarding-grid-four">
              <div class="field"><label for="onboardCalories">Calories</label><input id="onboardCalories" type="number" min="500" max="10000" required value="${existingGoals.calorie_goal}"></div>
              <div class="field"><label for="onboardProtein">Protein (g)</label><input id="onboardProtein" type="number" min="0" max="1000" required value="${existingGoals.protein_goal}"></div>
              <div class="field"><label for="onboardCarbs">Carbs (g)</label><input id="onboardCarbs" type="number" min="0" max="1500" required value="${existingGoals.carbs_goal}"></div>
              <div class="field"><label for="onboardFat">Fat (g)</label><input id="onboardFat" type="number" min="0" max="500" required value="${existingGoals.fat_goal}"></div>
            </div>
          </div>
          <div class="onboarding-section">
            <h2>Are you a personal trainer?</h2>
            <div class="role-choice-grid">
              <label class="choice-card"><input type="radio" name="role" value="user" checked><span>No, I'm using MacroSync for myself</span></label>
              <label class="choice-card"><input type="radio" name="role" value="trainer"><span>Yes, I'm a personal trainer</span></label>
            </div>
            <div class="field trainer-business-field" id="trainerBusinessField" hidden><label for="onboardBusiness">Business / gym / organization <span>(optional)</span></label><input id="onboardBusiness" maxlength="120" placeholder="Leave blank if independent"></div>
          </div>
          <p class="onboarding-status" id="onboardingStatus" role="status"></p>
          <button class="primary-button" type="submit">Finish setup</button>
        </form>
      </section>`;
    document.body.appendChild(overlay);
    const business = overlay.querySelector('#trainerBusinessField');
    const syncRole = () => { business.hidden = overlay.querySelector('input[name="role"]:checked')?.value !== 'trainer'; };
    overlay.querySelectorAll('input[name="role"]').forEach(input => input.addEventListener('change', syncRole));
    syncRole();
    const onboardAuto=overlay.querySelector('[data-onboard-auto-calculate]');
    const onboardStatus=overlay.querySelector('[data-onboard-auto-status]');
    const lowWrap=overlay.querySelector('[data-onboard-low-carb-wrap]');
    const lowInput=overlay.querySelector('[data-onboard-low-carb]');
    const syncOnboardGoal=()=>{ lowWrap.hidden=overlay.querySelector('input[name="primaryGoal"]:checked')?.value!=='recomp'; };
    overlay.querySelectorAll('input[name="primaryGoal"]').forEach(i=>i.addEventListener('change',syncOnboardGoal)); syncOnboardGoal();
    onboardAuto?.addEventListener('click',()=>{const goal=overlay.querySelector('input[name="primaryGoal"]:checked')?.value;const targets=calculateAutoMacroTargets(Number(overlay.querySelector('#onboardCurrentWeight').value),goal,Boolean(lowInput?.checked));if(!targets){onboardStatus.textContent='Select a goal and enter a valid current weight first.';return;}overlay.querySelector('#onboardCalories').value=targets.calorie_goal;overlay.querySelector('#onboardProtein').value=targets.protein_goal;overlay.querySelector('#onboardCarbs').value=targets.carbs_goal;overlay.querySelector('#onboardFat').value=targets.fat_goal;onboardStatus.textContent='Starting targets calculated. You can adjust them before saving.';});
    overlay.querySelector('#onboardingForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = overlay.querySelector('#onboardingStatus');
      status.textContent = 'Saving your setup…';
      const primaryGoal = overlay.querySelector('input[name="primaryGoal"]:checked')?.value || 'health';
      const role = overlay.querySelector('input[name="role"]:checked')?.value || 'user';
      const profilePayload = { id:user.id, display_name:profile?.display_name || user.user_metadata?.display_name || user.email?.split('@')[0] || 'MacroSync User', role, business_name:role==='trainer' ? overlay.querySelector('#onboardBusiness').value.trim() || null : null, primary_goal:primaryGoal, onboarding_complete:true };
      const goalsPayload = { user_id:user.id, calorie_goal:Number(overlay.querySelector('#onboardCalories').value), protein_goal:Number(overlay.querySelector('#onboardProtein').value), carbs_goal:Number(overlay.querySelector('#onboardCarbs').value), fat_goal:Number(overlay.querySelector('#onboardFat').value), current_weight:Number(overlay.querySelector('#onboardCurrentWeight').value)||null, goal_weight:Number(overlay.querySelector('#onboardGoalWeight').value)||null, low_carb:Boolean(overlay.querySelector('[data-onboard-low-carb]')?.checked) };
      const { error: profileError } = await supabase.from('profiles').upsert(profilePayload);
      if (profileError) { status.textContent=profileError.message; return; }
      const { error: goalError } = await supabase.from('nutrition_goals').upsert(goalsPayload);
      if (goalError) { status.textContent=goalError.message; return; }
      await trackEvent('onboarding_completed', { role, primary_goal: primaryGoal });
      overlay.remove();
      await renderPage();
    });
  }

  function wireGlobalAuth(profile) {
    const topbar = $('.topbar');
    if (!topbar || $('#alphaSettingsMenu')) return;

    const bar = document.createElement('div');
    bar.id = 'alphaAccountBar';
    bar.className = 'alpha-account-bar';
    bar.innerHTML = `<span class="alpha-account-email">${escapeHtml(user.email || '')}</span>`;
    topbar.appendChild(bar);

    const menuMarkup = `
      <div class="mobile-menu-sheet-backdrop" data-mobile-sheet-backdrop hidden></div>
      <section class="mobile-menu-sheet" id="alphaSettingsMenu" hidden aria-label="MacroSync menu" aria-modal="true" role="dialog">
        <div class="mobile-menu-handle" data-mobile-menu-handle aria-hidden="true"><span></span></div>
        <div class="mobile-menu-sheet-header">
          <div class="mobile-menu-brand"><img class="menu-logo" src="assets/macrosync-favicon.png" alt=""><div><p class="eyebrow">MacroSync</p><h2>Menu</h2></div></div>
          <button class="modal-close" type="button" data-close-mobile-menu aria-label="Close menu">×</button>
        </div>
        <div class="mobile-menu-sheet-content" data-mobile-menu-content>
          <a href="index.html">Dashboard</a>
          <a href="settings.html">Settings</a>
          <a href="trainers.html">Find a Trainer</a>
          <a href="recipes.html">Recipes</a>
          <a href="goals.html">Goals</a>
          <a href="admin.html" data-admin-only hidden>Admin Moderation</a>
          <button type="button" data-notifications>Notifications <span class="menu-badge" data-menu-notification-count hidden>0</span></button>
          <button type="button" data-message-notification-settings>Message notifications <span data-message-notification-state>On</span></button>
          <button type="button" data-theme-toggle>Light mode</button>
          <button type="button" data-enable-browser-notifications>Enable browser notifications</button>
          <button type="button" data-logout>Log out</button>
        </div>
      </section>`;
    document.body.insertAdjacentHTML('beforeend', menuMarkup);

    const isAdmin = profile?.is_admin === true;
    $$('[data-admin-only]').forEach(el => { el.hidden = !isAdmin; });
    const limitedMinor = isLimitedMinorProfile(profile);
    if (limitedMinor) {
      $$('a[href="social.html"], a[href="friends-add.html"], a[href="friends-messages.html"], a[href="friends-meals.html"], a[href="trainers.html"], a[href="goals.html"], a[href="progress.html"], a[href="recipes.html"], a[href="account.html"], a[href="settings.html"]').forEach(el => { el.hidden = true; });
      $$('[data-mobile-nav] a').forEach(el => { if (!['log_food.html','log.html'].includes(el.getAttribute('href'))) el.hidden = true; });
      $$('[data-mobile-menu] a').forEach(el => { if (!['log_food.html','log.html'].includes(el.getAttribute('href'))) el.hidden = true; });
    }

    const menu = $('#alphaSettingsMenu');
    const backdrop = $('[data-mobile-sheet-backdrop]');
    const menuButtons = $$('[data-mobile-menu]');
    let menuStartY = 0;
    let menuCurrentY = 0;
    let menuDragging = false;

    const setMenuTransform = (offset) => {
      menu.style.setProperty('--menu-drag-offset', `${Math.max(0, offset)}px`);
    };
    const openMenu = () => {
      menu.hidden = false;
      backdrop.hidden = false;
      document.body.classList.add('mobile-menu-open');
      requestAnimationFrame(() => {
        menu.classList.add('is-open');
        backdrop.classList.add('is-open');
      });
      menuButtons.forEach(button => button.setAttribute('aria-expanded', 'true'));
    };
    const closeMenu = () => {
      menu.classList.remove('is-open');
      backdrop.classList.remove('is-open');
      document.body.classList.remove('mobile-menu-open');
      menu.style.removeProperty('--menu-drag-offset');
      menuButtons.forEach(button => button.setAttribute('aria-expanded', 'false'));
      setTimeout(() => { menu.hidden = true; backdrop.hidden = true; }, 260);
    };

    menuButtons.forEach(button => button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    }));
    backdrop.addEventListener('click', closeMenu);
    $('[data-close-mobile-menu]')?.addEventListener('click', closeMenu);

    const handle = $('[data-mobile-menu-handle]');
    handle?.addEventListener('touchstart', event => {
      menuStartY = event.touches[0].clientY;
      menuCurrentY = menuStartY;
      menuDragging = true;
      menu.style.transition = 'none';
    }, { passive: true });
    handle?.addEventListener('touchmove', event => {
      if (!menuDragging) return;
      menuCurrentY = event.touches[0].clientY;
      setMenuTransform(Math.max(0, menuCurrentY - menuStartY));
    }, { passive: true });
    handle?.addEventListener('touchend', () => {
      if (!menuDragging) return;
      menuDragging = false;
      menu.style.transition = '';
      if (menuCurrentY - menuStartY > 90) closeMenu();
      else if (menuStartY - menuCurrentY > 70) {
        menu.classList.add('is-expanded');
        setMenuTransform(0);
      } else setMenuTransform(0);
    }, { passive: true });

    menu.addEventListener('touchstart', event => {
      menuStartY = event.touches[0].clientY;
      menuCurrentY = menuStartY;
      menuDragging = true;
      menu.style.transition = 'none';
    }, { passive: true });
    menu.addEventListener('touchmove', event => {
      if (!menuDragging) return;
      menuCurrentY = event.touches[0].clientY;
      const content = $('[data-mobile-menu-content]');
      const atTop = !content || content.scrollTop <= 0;
      const delta = menuCurrentY - menuStartY;
      if (delta > 0 && atTop) setMenuTransform(delta);
    }, { passive: true });
    menu.addEventListener('touchend', () => {
      if (!menuDragging) return;
      menuDragging = false;
      menu.style.transition = '';
      if (menuCurrentY - menuStartY > 90) closeMenu();
      else if (menuStartY - menuCurrentY > 70) menu.classList.add('is-expanded');
      setMenuTransform(0);
    }, { passive: true });

    const content = $('[data-mobile-menu-content]');
    content?.addEventListener('touchstart', event => {
      menuStartY = event.touches[0].clientY;
      menuCurrentY = menuStartY;
      menuDragging = false;
    }, { passive: true });
    content?.addEventListener('touchmove', event => {
      menuCurrentY = event.touches[0].clientY;
    }, { passive: true });

    $('[data-theme-toggle]')?.addEventListener('click', () => {
      const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
      localStorage.setItem('macrosync-theme', next);
      localStorage.setItem('pulseplate-theme', next);
      applyTheme();
    });
    $('[data-notifications]')?.addEventListener('click', () => { closeMenu(); showNotificationsModal(); });
    $('[data-message-notification-settings]')?.addEventListener('click', () => { closeMenu(); showMessageNotificationSettingsModal(); });
    $('[data-enable-browser-notifications]')?.addEventListener('click', async () => {
      closeMenu();
      const messageNotificationsEnabled = await getMessageNotificationSetting().catch(() => true);
      if (!messageNotificationsEnabled) { alert('Message notifications are turned off in MacroSync settings. Turn them on first to enable browser notifications.'); return; }
      if (!('Notification' in window)) { alert('This browser does not support browser notifications.'); return; }
      const permission = await Notification.requestPermission();
      if (permission === 'granted') new Notification('MacroSync notifications enabled', { body: 'You will be notified when new messages arrive while MacroSync is open.' });
    });
    applyTheme();
    refreshNotifications().catch(console.error);
    $$('[data-mobile-menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function applyTheme() {
    const theme = localStorage.getItem('macrosync-theme') || localStorage.getItem('pulseplate-theme') || 'dark';
    localStorage.setItem('macrosync-theme', theme);
    document.body.classList.toggle('light-theme', theme === 'light');
    const logoSrc = theme === 'light' ? 'assets/macrosync-logo-light.png' : 'assets/macrosync-logo-dark.png';
    $$('[data-theme-logo]').forEach(img => { img.src = logoSrc; });
    $$('[data-theme-toggle]').forEach(button => { button.textContent = theme === 'light' ? 'Dark mode' : 'Light mode'; });
  }

  async function getMessageNotificationSetting() {
    const { data, error } = await supabase.from('profiles').select('message_notifications_enabled').eq('id', user.id).single();
    if (error) {
      if (/message_notifications_enabled/i.test(error.message || '')) return true;
      throw error;
    }
    return data?.message_notifications_enabled !== false;
  }

  async function refreshMessageNotificationSetting() {
    if (!supabase || !user) return;
    const enabled = await getMessageNotificationSetting();
    const state = $('[data-message-notification-state]');
    if (state) state.textContent = enabled ? 'On' : 'Off';
  }

  async function getUnreadNotifications() {
    const { data, error } = await supabase.from('notifications').select('*').eq('recipient_id', user.id).is('read_at', null).order('created_at', { ascending: false }).limit(25);
    if (error) {
      // Older databases may not have the notifications table yet. Keep the app usable until schema is applied.
      if (/notifications/i.test(error.message || '')) return [];
      throw error;
    }
    return data || [];
  }

  async function refreshNotifications() {
    if (!supabase || !user) return;
    const messageNotificationsEnabled = await getMessageNotificationSetting().catch(() => true);
    if (!messageNotificationsEnabled) {
      const badge = $('[data-notification-badge]');
      const menuCount = $('[data-menu-notification-count]');
      if (badge) badge.hidden = true;
      if (menuCount) menuCount.hidden = true;
      return;
    }
    const notifications = await getUnreadNotifications();
    const count = notifications.length;
    const badge = $('[data-notification-badge]');
    const menuCount = $('[data-menu-notification-count]');
    if (badge) { badge.textContent = count > 99 ? '99+' : String(count); badge.hidden = count === 0; }
    if (menuCount) { menuCount.textContent = count > 99 ? '99+' : String(count); menuCount.hidden = count === 0; }
    const previous = Number(window.__macroSyncLastUnreadCount || 0);
    window.__macroSyncLastUnreadCount = count;
    if (count > previous && previous >= 0 && 'Notification' in window && Notification.permission === 'granted') {
      const latest = notifications[0];
      if (latest && latest.id !== window.__macroSyncLastNotificationId) {
        window.__macroSyncLastNotificationId = latest.id;
        new Notification(latest.title || 'New MacroSync message', { body: latest.body || 'You have a new notification.' });
      }
    }
  }

  async function showMessageNotificationSettingsModal() {
    const enabled = await getMessageNotificationSetting().catch(() => true);
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = `
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="messageNotificationSettingsTitle">
        <div class="modal-header"><div><p class="eyebrow">Notification settings</p><h2 id="messageNotificationSettingsTitle">Message notifications</h2></div><button type="button" class="icon-button" data-close-settings>×</button></div>
        <label class="toggle-row notification-setting-row"><input type="checkbox" data-message-notifications-toggle ${enabled ? 'checked' : ''}><span><strong>Notify me when I receive a message</strong><small>Turn this off if you do not want MacroSync to create notifications for new messages sent to you.</small></span></label>
        <p class="settings-status" data-message-notification-status role="status"></p>
        <div class="modal-actions"><button class="primary-button" type="button" data-close-settings>Done</button></div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-message-notifications-toggle')?.addEventListener('change', async event => {
      const toggle = event.target;
      const status = overlay.querySelector('[data-message-notification-status]');
      toggle.disabled = true;
      status.textContent = 'Saving…';
      const { error } = await supabase.from('profiles').update({ message_notifications_enabled: toggle.checked }).eq('id', user.id);
      toggle.disabled = false;
      if (error) {
        toggle.checked = !toggle.checked;
        status.textContent = error.message;
        return;
      }
      status.textContent = toggle.checked ? 'Message notifications are enabled.' : 'Message notifications are disabled.';
      const state = $('[data-message-notification-state]');
      if (state) state.textContent = toggle.checked ? 'On' : 'Off';
      if (!toggle.checked) {
        window.__macroSyncLastUnreadCount = 0;
        window.__macroSyncLastNotificationId = null;
      }
    });
  }

  async function showNotificationsModal() {
    const notifications = await getUnreadNotifications().catch(error => { alert(error.message); return []; });
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = `
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="notificationsTitle">
        <div class="modal-header"><div><p class="eyebrow">Notifications</p><h2 id="notificationsTitle">Your notifications</h2></div><button type="button" class="icon-button" data-close-settings>×</button></div>
        <div class="notification-list">${notifications.length ? notifications.map(n => `<article class="notification-card"><strong>${escapeHtml(n.title || 'Notification')}</strong><p>${escapeHtml(n.body || '')}</p><small>${formatTimestamp(n.created_at)}</small></article>`).join('') : '<p class="page-copy">You have no unread notifications.</p>'}</div>
        <div class="modal-actions"><button class="ghost-button" type="button" data-mark-notifications-read ${notifications.length ? '' : 'disabled'}>Mark all as read</button><button class="primary-button" type="button" data-close-settings>Close</button></div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-mark-notifications-read')?.addEventListener('click', async () => {
      const { error } = await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_id', user.id).is('read_at', null);
      if (error) { alert(error.message); return; }
      overlay.remove();
      await refreshNotifications();
    });
  }

  function showEmailChangeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = `
      <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="emailTitle">
        <div class="modal-header"><div><p class="eyebrow">Account settings</p><h2 id="emailTitle">Change email</h2></div><button type="button" class="icon-button" data-close-settings>×</button></div>
        <p class="page-copy">Enter a new email address. Supabase may require you to confirm the change from your email inbox.</p>
        <form data-email-form>
          <div class="field"><label for="newEmail">New email</label><input id="newEmail" type="email" required value="${escapeHtml(user.email || '')}"></div>
          <p class="settings-status" data-email-status role="status"></p>
          <div class="modal-actions"><button class="ghost-button" type="button" data-close-settings>Cancel</button><button class="primary-button" type="submit">Update email</button></div>
        </form>
      </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close-settings]').forEach(b => b.onclick = () => overlay.remove());
    overlay.querySelector('[data-email-form]').addEventListener('submit', async event => {
      event.preventDefault();
      const status = overlay.querySelector('[data-email-status]');
      const newEmail = overlay.querySelector('#newEmail').value.trim();
      if (!newEmail) return;
      status.textContent = 'Updating email…';
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) { status.textContent = error.message; return; }
      await supabase.from('profiles').update({ email: newEmail }).eq('id', user.id);
      status.textContent = 'Email update requested. Check your inbox for any confirmation links.';
      user.email = newEmail;
      setTimeout(() => overlay.remove(), 1800);
    });
  }

  async function renderPage() {
    const page = document.body.dataset.page || location.pathname.split('/').pop().replace('.html','');
    trackEvent('page_view', { page });
    const currentProfile = await getCurrentProfile().catch(() => null);
    if (isLimitedMinorProfile(currentProfile) && !['log','food-management'].includes(page)) { window.location.replace('log_food.html'); return; }
    if (page === 'dashboard' || page === 'index') await renderDashboard();
    if (page === 'log') await renderFoodLogger();
    if (page === 'account') await renderAccount();
    if (page === 'settings') await renderSettings();
    if (page === 'goals') await renderGoals();
    if (page === 'progress') await renderProgress();
    if (page === 'recipes') await renderRecipes();
    if (page === 'social' || page === 'friends-add' || page === 'friends-messages' || page === 'friends-meals') await renderSocial();
    if (page === 'trainers') await renderTrainers();
    if (page === 'trainer-settings') await renderTrainerSettings();
    if (page === 'admin') await renderAdmin();
    wireDateControls();
  }

  async function reviewMyContent() {
    if (!supabase || !user) return false;
    const { data, error } = await supabase.rpc('review_my_content');
    if (error) { console.warn(error); return false; }
    const openFlags = (data || []).filter(f => f.status === 'open');
    const nameFlag = openFlags.find(f => f.content_type === 'display_name');

    if (nameFlag) {
      await showMandatoryDisplayNameChange(nameFlag.reason);
      return true;
    }

    if (!openFlags.length) return false;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card moderation-notice" role="dialog" aria-modal="true" aria-labelledby="moderationNoticeTitle"><p class="eyebrow">Action required</p><h2 id="moderationNoticeTitle">Some of your messages need attention</h2><p class="page-copy">MacroSync found messages that may violate its rules. You can delete the flagged messages below.</p><div class="moderation-items">${openFlags.map(f => `<div class="moderation-item" data-moderation-flag="${f.id}"><strong>Message</strong><p>${escapeHtml(f.reason)}</p><div class="modal-actions"><button type="button" class="ghost-button danger-button" data-delete-flagged-message="${f.content_id}">Delete message</button></div></div>`).join('')}</div><div class="modal-actions"><button type="button" class="primary-button" data-close-moderation>Review later</button></div></section>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close-moderation]')?.addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-delete-flagged-message]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this message permanently?')) return;
      const flag = btn.closest('[data-moderation-flag]');
      const { data: deleted, error: delError } = await supabase.rpc('delete_message', { p_message_id: Number(btn.dataset.deleteFlaggedMessage) });
      if (delError) { alert(delError.message); return; }
      if (!deleted) { alert('The message could not be deleted.'); return; }
      await supabase.from('moderation_flags').update({ status:'resolved', resolved_at:new Date().toISOString() }).eq('id', flag.dataset.moderationFlag).eq('user_id', user.id);
      flag.remove();
      if (!overlay.querySelector('[data-moderation-flag]')) overlay.remove();
    }));
    return false;
  }

  async function showMandatoryDisplayNameChange(reason) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card moderation-notice" role="dialog" aria-modal="true" aria-labelledby="requiredNameTitle"><p class="eyebrow">Action required</p><h2 id="requiredNameTitle">Your display name must be changed</h2><p class="page-copy">Your current display name does not meet MacroSync's content rules. You must choose a new display name before you can continue using the app.</p><p class="settings-status">${escapeHtml(reason || 'Your display name contains language or content that is not allowed.')}</p><form class="settings-stack" data-required-name-form><div class="field"><label for="requiredDisplayName">New display name</label><input id="requiredDisplayName" maxlength="80" autocomplete="nickname" required autofocus /></div><button class="primary-button" type="submit">Change display name</button><p class="settings-status" data-required-name-status role="status"></p></form></section>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('[data-required-name-form]');
    const input = overlay.querySelector('#requiredDisplayName');
    const status = overlay.querySelector('[data-required-name-status]');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const displayName = input.value.trim();
      const validation = validateDisplayName(displayName);
      if (validation) { status.textContent = validation; return; }
      status.textContent = 'Saving…';
      const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
      if (error) { status.textContent = error.message; return; }
      const { error: authError } = await supabase.auth.updateUser({ data: { display_name: displayName } });
      if (authError) { status.textContent = authError.message; return; }
      await supabase.from('moderation_flags').update({ status:'resolved', resolved_at:new Date().toISOString() }).eq('user_id', user.id).eq('content_type','display_name').eq('status','open');
      overlay.remove();
      window.location.reload();
    });
  }

  async function getGoals() {
    const { data } = await supabase.from('nutrition_goals').select('*').eq('user_id', user.id).maybeSingle();
    return data || { calorie_goal:2050, protein_goal:147, carbs_goal:230, fat_goal:68, current_weight:null, goal_weight:null };
  }

  async function getEntries(date = selectedDate) {
    const { data, error } = await supabase.from('food_entries').select('*').eq('user_id', user.id).eq('logged_date', dateKey(date)).order('created_at');
    if (error) throw error;
    return data || [];
  }

  async function loadUserMeals() {
    // Prefer the table directly so the meal UI still works if the RPC is missing
    // from an older database or Supabase's function cache has not refreshed yet.
    let { data, error } = await supabase
      .from('meals')
      .select('id,user_id,meal_date,meal_number,name,created_at')
      .eq('user_id', user.id)
      .eq('meal_date', dateKey(selectedDate))
      .order('meal_number', { ascending: true });

    if (error) throw error;

    // Existing accounts may have an empty meals table. Create the required
    // starting meals directly under the user's RLS policy.
    if (!data || data.length === 0) {
      const defaults = [1, 2, 3].map(n => ({
        user_id: user.id,
        meal_date: dateKey(selectedDate),
        meal_number: n,
        name: `Meal ${n}`,
        sort_order: n
      }));
      const { data: created, error: createError } = await supabase
        .from('meals')
        .insert(defaults)
        .select('id,user_id,meal_date,meal_number,name,sort_order,created_at');
      if (createError) throw createError;
      data = created || [];
    }

    userMeals = data.sort((a, b) => Number(a.meal_number) - Number(b.meal_number));
    return userMeals;
  }

  function mealOptionsMarkup(selected = '') {
    return userMeals.map(meal => `<option value="${escapeHtml(meal.name)}" ${meal.name === selected ? 'selected' : ''}>${escapeHtml(meal.name)}</option>`).join('');
  }

  async function refreshMealUI() {
    await loadUserMeals();
    await renderSelectedDateEntries();
    await renderMealManager();
  }

  async function openRenameMealModal(meal) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="renameMealTitle">
      <button class="modal-close" data-close type="button" aria-label="Close">×</button>
      <p class="eyebrow">Meal ${Number(meal.meal_number)}</p><h2 id="renameMealTitle">Rename meal</h2>
      <p class="page-copy">Rename this meal without losing any foods already logged under it.</p>
      <div class="field"><label for="renameMealInput">Meal name</label><input id="renameMealInput" maxlength="40" value="${escapeHtml(meal.name)}" autocomplete="off"></div>
      <p class="save-status" data-meal-status role="status"></p>
      <div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-rename type="button">Save name</button></div>
    </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close]').forEach(b => b.onclick = () => overlay.remove());
    const input = overlay.querySelector('#renameMealInput'); input.focus(); input.select();
    overlay.querySelector('[data-save-rename]').onclick = async () => {
      const name = input.value.trim();
      const status = overlay.querySelector('[data-meal-status]');
      if (!name) { status.textContent = 'Enter a meal name.'; return; }
      status.textContent = 'Saving…';
      const { error } = await supabase.rpc('rename_meal', { p_meal_id: meal.id, p_name: name, p_meal_date: dateKey(selectedDate) });
      if (error) { status.textContent = error.message; return; }
      overlay.remove();
      await refreshMealUI();
    };
  }

  async function openAddMealModal() {
    if (userMeals.length >= 10) { alert('You can have up to 10 meals.'); return; }
    const nextNumber = Math.max(0, ...userMeals.map(m => Number(m.meal_number))) + 1;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="addMealTitle">
      <button class="modal-close" data-close type="button" aria-label="Close">×</button>
      <p class="eyebrow">Meal ${nextNumber}</p><h2 id="addMealTitle">Add a meal</h2>
      <p class="page-copy">New meals start with a numbered name, and you can rename them whenever you want.</p>
      <div class="field"><label for="newMealInput">Meal name</label><input id="newMealInput" maxlength="40" value="Meal ${nextNumber}" autocomplete="off"></div>
      <p class="save-status" data-meal-status role="status"></p>
      <div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-add type="button">Add meal</button></div>
    </section>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close]').forEach(b => b.onclick = () => overlay.remove());
    const input = overlay.querySelector('#newMealInput'); input.focus(); input.select();
    overlay.querySelector('[data-save-add]').onclick = async () => {
      const name = input.value.trim();
      const status = overlay.querySelector('[data-meal-status]');
      if (!name) { status.textContent = 'Enter a meal name.'; return; }
      status.textContent = 'Adding…';
      const { error } = await supabase.rpc('add_meal', { p_name: name, p_meal_date: dateKey(selectedDate) });
      if (error) { status.textContent = error.message; return; }
      overlay.remove();
      await refreshMealUI();
    };
  }

  async function deleteMeal(meal) {
    if (userMeals.length <= 3) { alert('MacroSync requires at least 3 meals.'); return; }
    const entries = await getEntries(selectedDate);
    const hasEntries = entries.some(e => e.meal === meal.name);
    if (hasEntries) {
      alert(`${meal.name} still has foods logged today. Move or delete those foods before deleting the meal.`);
      return;
    }
    if (!confirm(`Delete ${meal.name}? This cannot be undone.`)) return;
    const { error } = await supabase.rpc('delete_meal', { p_meal_id: meal.id, p_meal_date: dateKey(selectedDate) });
    if (error) { alert(error.message); return; }
    await refreshMealUI();
  }

  async function renderMealManager() {
    const box = $('[data-meal-manager]'); if (!box) return;
    box.innerHTML = `<div class="meal-manager-list">${userMeals.map(meal => `<div class="meal-manager-row"><div><strong>${escapeHtml(meal.name)}</strong><small>Meal ${Number(meal.meal_number)}</small></div><div class="meal-manager-actions"><button class="ghost-button" type="button" data-rename-meal="${meal.id}">Rename</button><button class="ghost-button danger-button" type="button" data-delete-meal="${meal.id}" ${userMeals.length <= 3 ? 'disabled' : ''}>Delete</button></div></div>`).join('')}</div>
      <button class="primary-button meal-manager-add" type="button" data-add-meal ${userMeals.length >= 10 ? 'disabled' : ''}>+ Add meal${userMeals.length >= 10 ? ' (10 max)' : ''}</button>
      <p class="page-copy">Meal choices are saved separately for each day. You can have 3 to 10 meals on this day without changing any other day. A meal with foods logged on this day must be emptied before it can be deleted.</p>`;
    box.querySelectorAll('[data-rename-meal]').forEach(button => button.onclick = () => {
      const meal = userMeals.find(m => String(m.id) === button.dataset.renameMeal);
      if (meal) openRenameMealModal(meal);
    });
    box.querySelectorAll('[data-delete-meal]').forEach(button => button.onclick = () => {
      const meal = userMeals.find(m => String(m.id) === button.dataset.deleteMeal);
      if (meal) deleteMeal(meal);
    });
    box.querySelector('[data-add-meal]')?.addEventListener('click', openAddMealModal);
  }

  async function renderDashboard() {
    const [goals, entries] = await Promise.all([getGoals(), getEntries()]);
    const totals = totalsFor(entries);
    setText('[data-date-label]', formatDate(selectedDate));
    setText('[data-cal-left]', Math.max(goals.calorie_goal - totals.calories, 0).toLocaleString());
    setText('[data-cal-eaten]', totals.calories.toLocaleString());
    setText('[data-cal-goal]', goals.calorie_goal.toLocaleString());
    setText('[data-percent]', `${Math.round((totals.calories / Math.max(goals.calorie_goal,1))*100)}%`);
    setText('[data-day-summary]', entries.length ? `${entries.length} food item${entries.length===1?'':'s'} logged today.` : 'No foods logged yet. Add your first meal to start your diary.');
    setText('#coachNote', entries.length ? 'Keep building your day with foods that fit your targets.' : 'Search the food database to add your first meal.');
    setText('[data-water]', '— cups');
    setText('[data-steps]', '— steps');
    setText('[data-protein-text]', `${moneyless(totals.protein)} / ${moneyless(goals.protein_goal)}g`);
    setText('[data-carbs-text]', `${moneyless(totals.carbs)} / ${moneyless(goals.carbs_goal)}g`);
    setText('[data-fat-text]', `${moneyless(totals.fat)} / ${moneyless(goals.fat_goal)}g`);
    setText('[data-dashboard-cal-goal]', goals.calorie_goal.toLocaleString());
    setText('[data-dashboard-protein-goal]', `${moneyless(goals.protein_goal)}g`);
    setWidth('[data-goal-progress]', totals.calories/goals.calorie_goal*100);
    setWidth('[data-protein-bar]', totals.protein/goals.protein_goal*100);
    setWidth('[data-carbs-bar]', totals.carbs/goals.carbs_goal*100);
    setWidth('[data-fat-bar]', totals.fat/goals.fat_goal*100);
    $$('.ring-fill').forEach(r => r.style.setProperty('--ring-offset', 352 - Math.min(totals.calories/goals.calorie_goal,1)*352));
    await renderMeals(entries);
    await renderMealManager();
    await renderPreviousDay();
    await renderCalendar();
  }

  function totalsFor(entries) { return entries.reduce((t,e)=>({calories:t.calories+Number(e.calories||0),protein:t.protein+Number(e.protein||0),carbs:t.carbs+Number(e.carbs||0),fat:t.fat+Number(e.fat||0)}),{calories:0,protein:0,carbs:0,fat:0}); }

  const mealCollapsed = new Set();

  async function renderMeals(entries) {
    const list = $('[data-meal-list]'); if (!list) return;
    const grouped = userMeals.map(meal => ({ meal: meal.name, mealId: meal.id, mealNumber: meal.meal_number, items: entries.filter(e => e.meal === meal.name) }));
    list.innerHTML = grouped.map(group => {
      const calories = group.items.reduce((sum, e) => sum + Number(e.calories || 0), 0);
      const stateKey = `${dateKey(selectedDate)}:${group.mealId}`;
      const isOpen = !mealCollapsed.has(stateKey);
      return `<details class="meal-group" data-meal-state-key="${stateKey}" ${isOpen ? 'open' : ''}>
        <summary class="meal-group-header">
          <span class="meal-group-title"><span class="meal-chevron" aria-hidden="true">›</span><span><strong>${group.meal}</strong><small>${group.items.length ? `${group.items.length} item${group.items.length === 1 ? '' : 's'}` : 'No foods logged'}</small></span></span>
          <span class="meal-group-total">${moneyless(calories)} cal</span>
        </summary>
        <div class="meal-group-body">
          ${group.items.length ? group.items.map(e => `<article class="meal-item">
            <div class="meal-item-main"><strong>${escapeHtml(e.food_name)}</strong><span>${escapeHtml(e.serving)}</span></div>
            <div class="meal-item-nutrition"><strong>${moneyless(e.calories)} cal</strong><span>P ${moneyless(e.protein)}g</span><span>C ${moneyless(e.carbs)}g</span><span>F ${moneyless(e.fat)}g</span></div>
            <div class="meal-item-actions"><button class="text-button" type="button" data-edit-entry="${e.id}">Edit</button><button class="text-button danger-button" type="button" data-delete-entry="${e.id}">Delete</button><button class="text-button" type="button" data-move-entry="${e.id}">Move</button>${(() => { const target=addDays(new Date(selectedDate),1); return dateKey(target)>=localTodayKey() && dateKey(target)<=dateKey(maxPlanAheadDate()) ? `<button class="text-button" type="button" data-copy-entry="${e.id}">Copy tomorrow</button>` : ''; })()}</div>
          </article>`).join('') : '<p class="meal-empty-copy">No foods logged yet.</p>'}
          <div class="meal-group-actions"><a class="meal-add-link" href="log_food.html">+ Add to ${group.meal}</a>${group.items.length ? `<button class="text-button" type="button" data-save-current-meal="${group.meal}">Save this meal</button>` : ''}</div>
        </div>
      </details>`;
    }).join('');
    list.querySelectorAll('[data-meal-state-key]').forEach(details => details.addEventListener('toggle', () => {
      const key = details.dataset.mealStateKey;
      if (details.open) mealCollapsed.delete(key); else mealCollapsed.add(key);
    }));
    list.querySelectorAll('[data-save-current-meal]').forEach(button => button.addEventListener('click', () => saveCurrentMealAsSaved(button.dataset.saveCurrentMeal)));
    list.querySelectorAll('[data-edit-entry]').forEach(button => button.addEventListener('click', () => { const entry = entries.find(e => String(e.id) === button.dataset.editEntry); if (entry) openEditEntryModal(entry); }));
    list.querySelectorAll('[data-delete-entry]').forEach(button => button.addEventListener('click', async () => {
      if (!confirm('Delete this food entry permanently?')) return;
      const { error } = await supabase.from('food_entries').delete().eq('id', button.dataset.deleteEntry).eq('user_id', user.id);
      if (error) return alert(error.message);
      await renderPage();
    }));
    list.querySelectorAll('[data-move-entry]').forEach(button => button.addEventListener('click', () => { const entry = entries.find(e => String(e.id) === button.dataset.moveEntry); if (entry) openMoveEntryModal(entry); }));
    list.querySelectorAll('[data-copy-entry]').forEach(button => button.addEventListener('click', async () => { const entry=entries.find(e=>String(e.id)===button.dataset.copyEntry); if(entry) await copyEntryToTomorrow(entry); }));
  }

  async function copyEntryToTomorrow(entry) {
    const targetDate=addDays(new Date(entry.logged_date+'T00:00:00'),1);
    if(!canSelectLogDate(targetDate)){alert('This food cannot be copied farther than 2 days ahead. Turn on Planning ahead when needed.');return;}
    const {data,error}=await supabase.rpc('copy_food_entry_to_date',{p_entry_id:Number(entry.id),p_target_date:dateKey(targetDate)});
    if(error){alert(error.message);return;}
    await renderPage();
  }

  function parseServingAmount(serving) {
    const match = String(serving || '').match(/[-+]?\d*\.?\d+/);
    return match ? Number(match[0]) : null;
  }

  async function openEditEntryModal(entry) {
    const oldAmount = parseServingAmount(entry.serving) || 1;
    const unitMatch = String(entry.serving || '').match(/[-+]?\d*\.?\d+\s*(.*)$/);
    const unit = unitMatch?.[1]?.trim() || 'serving';
    const overlay = document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Edit food</p><h2>${escapeHtml(entry.food_name)}</h2><p class="page-copy">Changing the amount scales the logged nutrition values proportionally.</p><div class="field"><label for="editEntryAmount">Amount</label><input id="editEntryAmount" type="number" min="0.01" step="0.01" value="${oldAmount}"></div><div class="field"><label for="editEntryUnit">Unit</label><input id="editEntryUnit" value="${escapeHtml(unit)}" maxlength="40"></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-edit type="button">Save changes</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-save-edit]').onclick=async()=>{
      const amount=Number(overlay.querySelector('#editEntryAmount').value); const newUnit=overlay.querySelector('#editEntryUnit').value.trim() || 'serving';
      if(!Number.isFinite(amount)||amount<=0)return alert('Enter a valid amount.');
      const factor=oldAmount>0?amount/oldAmount:1;
      const payload={serving:`${moneyless(amount)} ${newUnit}`,calories:Number(entry.calories||0)*factor,protein:Number(entry.protein||0)*factor,carbs:Number(entry.carbs||0)*factor,fat:Number(entry.fat||0)*factor};
      const {error}=await supabase.from('food_entries').update(payload).eq('id',entry.id).eq('user_id',user.id); if(error)return alert(error.message);
      overlay.remove(); await renderPage();
    };
  }

  function openMoveEntryModal(entry) {
    const overlay=document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Move food</p><h2>${escapeHtml(entry.food_name)}</h2><div class="field"><label for="moveEntryMeal">Move to meal</label><select id="moveEntryMeal">${mealOptionsMarkup(entry.meal)}</select></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-move type="button">Move food</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelector('#moveEntryMeal').value=entry.meal; overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-save-move]').onclick=async()=>{const meal=overlay.querySelector('#moveEntryMeal').value;if(meal===entry.meal){overlay.remove();return;}const {error}=await supabase.from('food_entries').update({meal}).eq('id',entry.id).eq('user_id',user.id);if(error)return alert(error.message);overlay.remove();await renderPage();};
  }

  async function renderPreviousDay() {
    const box = $('[data-previous-day]'); if (!box) return;
    const previousDate = addDays(selectedDate, -1);
    try {
      const { data, error } = await supabase.from('food_entries').select('*').eq('user_id', user.id).eq('logged_date', dateKey(previousDate)).order('created_at');
      if (error) throw error;
      const entries = data || [];
      const label = previousDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      if (!entries.length) {
        box.innerHTML = `<div class="previous-day-card"><div><p class="eyebrow">${escapeHtml(label)}</p><h3>No food logged</h3><span>This day has no entries yet.</span></div><button class="ghost-button" type="button" data-view-previous-day>View day</button></div>`;
      } else {
        const totals = totalsFor(entries);
        const meals = [...new Set(entries.map(e => String(e.meal || '').trim()).filter(Boolean))];
        box.innerHTML = `<div class="previous-day-card"><div><p class="eyebrow">${escapeHtml(label)}</p><h3>${entries.length} food item${entries.length === 1 ? '' : 's'} logged</h3><span>${meals.length} meal${meals.length === 1 ? '' : 's'} · ${moneyless(totals.calories)} cal</span></div><button class="ghost-button" type="button" data-view-previous-day>View day</button></div>`;
      }
      box.querySelector('[data-view-previous-day]')?.addEventListener('click', async () => {
        selectedDate = previousDate;
        weekStart = startOfWeek(selectedDate);
        await renderPage();
      });
    } catch (error) {
      box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`;
    }
  }

  const localTodayKey = () => dateKey(new Date());
  const maxPlanAheadDate = () => addDays(new Date(), 2);
  function canSelectLogDate(date) {
    const target = new Date(date); target.setHours(0,0,0,0);
    const today = new Date(); today.setHours(0,0,0,0);
    if (target <= today) return true;
    return planAheadEnabled && target <= maxPlanAheadDate();
  }

  async function renderCalendar() {
    const cal = $('[data-calendar-days]'); if (!cal) return;
    const monthLabel = $('[data-calendar-month]');
    if (monthLabel) monthLabel.textContent = weekStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    let loggedKeys = new Set();
    try {
      const endDate = addDays(weekStart, 6);
      const { data, error } = await supabase.from('food_entries').select('logged_date').eq('user_id', user.id).gte('logged_date', dateKey(weekStart)).lte('logged_date', dateKey(endDate));
      if (error) throw error;
      loggedKeys = new Set((data || []).map(row => String(row.logged_date)));
    } catch (error) { console.warn('Could not load weekly calendar status:', error.message); }
    cal.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const allowed = canSelectLogDate(d);
      const logged = loggedKeys.has(dateKey(d));
      const b = document.createElement('button');
      b.type = 'button'; b.disabled = !allowed;
      b.className = 'calendar-day ' + (logged ? 'logged' : 'not-logged') + (dateKey(d) === dateKey(selectedDate) ? ' active' : '') + (!allowed ? ' disabled' : '');
      b.innerHTML = `<span>${d.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>${d.getDate()}</strong><small>${!allowed ? 'Plan ahead off' : logged ? 'Logged' : 'Not logged'}</small>`;
      b.onclick = async () => { if (!canSelectLogDate(d)) return; selectedDate = d; await renderPage(); };
      cal.appendChild(b);
    }
  }
  function wireDateControls(){
    $$('[data-prev-day]').forEach(b=>b.onclick=async()=>{const next=addDays(selectedDate,-1);if(!canSelectLogDate(next))return;selectedDate=next;weekStart=startOfWeek(selectedDate);await renderPage();});
    $$('[data-next-day]').forEach(b=>b.onclick=async()=>{const next=addDays(selectedDate,1);if(!canSelectLogDate(next)){if(!planAheadEnabled) alert('Turn on Planning ahead to add foods to future dates. You can plan up to 2 days ahead.');return;}selectedDate=next;weekStart=startOfWeek(selectedDate);await renderPage();});
    $$('[data-prev-week]').forEach(b=>b.onclick=async()=>{const next=addDays(weekStart,-7);weekStart=next;selectedDate=next;await renderPage();});
    $$('[data-next-week]').forEach(b=>b.onclick=async()=>{const next=addDays(weekStart,7);if(!canSelectLogDate(next)){weekStart=next;selectedDate=next;await renderPage();return;}weekStart=next;selectedDate=next;await renderPage();});
    $$('[data-today-button]').forEach(b=>b.onclick=async()=>{selectedDate=new Date();weekStart=startOfWeek(selectedDate);await renderPage();});
  }
  async function renderFoodLogger() {
    await renderCalendar();
    const search = $('[data-food-search]');
    const list = $('[data-food-database-list]');
    if (!search || !list) return;

    await renderPersonalFoods();
    await renderMyCommunityFoods();
    await renderRecentFoods();
    await renderMealManager();

    const { data: verificationRow } = await supabase.from('trainer_verifications').select('status').eq('user_id', user.id).maybeSingle();
    const canPublishCommunity = verificationRow?.status === 'approved';
    document.body.dataset.canPublishCommunity = canPublishCommunity ? 'true' : 'false';
    const communityToggle = $('[data-community-toggle]');
    if (communityToggle) {
      communityToggle.hidden = !canPublishCommunity;
      communityToggle.title = canPublishCommunity ? 'Add a Community Food' : 'Only verified trainers can publish Community Foods.';
    }
    if (!canPublishCommunity) $$('[data-community-publish-note]').forEach(el => el.hidden = false);

    const mealSelect = $('[data-logging-meal]');
    if (mealSelect) {
      if (!selectedLoggingMeal || !userMeals.some(m => m.name === selectedLoggingMeal)) selectedLoggingMeal = userMeals[0]?.name || 'Meal 1';
      mealSelect.innerHTML = mealOptionsMarkup(selectedLoggingMeal);
      mealSelect.value = selectedLoggingMeal;
      mealSelect.onchange = () => { selectedLoggingMeal = mealSelect.value; };
    }
    const planToggle = $('[data-plan-ahead]');
    if (planToggle) {
      planToggle.checked = planAheadEnabled;
      planToggle.onchange = async () => {
        planAheadEnabled = planToggle.checked;
        const today = new Date(); today.setHours(0,0,0,0);
        if (!planAheadEnabled && selectedDate > today) { selectedDate = new Date(); weekStart = startOfWeek(selectedDate); }
        await renderPage();
      };
    }

    let foodSource = 'external';
    const sourceButtons = $$('[data-food-source]');
    const sourceHint = $('[data-food-source-hint]');
    const setFoodSource = async source => {
      foodSource = source;
      sourceButtons.forEach(b => b.classList.toggle('active', b.dataset.foodSource === source));
      if (sourceHint) sourceHint.textContent = source === 'external'
        ? 'Search USDA FoodData Central, Open Food Facts, Health Canada CNF, and UK CoFID together. Results keep their original database source.'
        : 'Search your private Personal Foods and the shared Community Foods together. Personal Foods are available to every user regardless of plan.';
      await runFoodSearch();
    };
    sourceButtons.forEach(b => b.addEventListener('click', () => setFoodSource(b.dataset.foodSource)));
    const getSearchLabel = source => source === 'external' ? 'all external food databases' : 'MacroSync Foods';
    const searchEndpoint = source => source === 'external' ? '/api/foods/search-all' : null;

    const fetchMacroSyncSearch = async (query, page=1, pageSize=15) => {
      const raw = query.trim();
      const clean = raw.replace(/[%_]/g,'');
      const authorSearch = raw.startsWith('@');
      let personalReq = supabase.from('user_foods').select('*', { count: 'exact' }).eq('user_id', user.id).order('name').limit(100);
      let communityReq = supabase.from('community_foods').select('*', { count: 'exact' }).eq('is_public', true).order('name').limit(100);
      if (authorSearch) {
        personalReq = null;
        const ids = await findCommunityAuthorIds(raw);
        communityReq = ids.length ? communityReq.in('user_id', ids) : null;
      } else if (clean) {
        personalReq = personalReq.or(`name.ilike.%${clean}%,brand_name.ilike.%${clean}%,store_name.ilike.%${clean}%`);
        communityReq = communityReq.or(`name.ilike.%${clean}%,brand_name.ilike.%${clean}%,store_name.ilike.%${clean}%`);
      }
      const [personalResult, communityResult] = await Promise.all([
        personalReq || Promise.resolve({data:[],error:null}),
        communityReq || Promise.resolve({data:[],error:null})
      ]);
      if (personalResult.error) throw personalResult.error;
      if (communityResult.error) throw communityResult.error;
      const personal = (personalResult.data || []).map(f => ({ ...f, _source: 'personal' }));
      const community = (communityResult.data || []).map(f => ({ ...f, _source: 'community' }));
      const foods = [...personal, ...community].sort((a,b) => String(a.name).localeCompare(String(b.name)));
      const start=(page-1)*pageSize;
      const sliced=foods.slice(start,start+pageSize);
      return { foods:sliced, totalHits:foods.length, page, pageSize, totalPages:Math.max(1,Math.ceil(foods.length/pageSize)) };
    };

    const bindFoodResults = (container, foods, source) => {
      container.querySelectorAll('[data-community-food-id]').forEach(card => card.addEventListener('click', event => {
        if(event.target.closest('[data-edit-community-food],[data-delete-community-food]')) return;
        const food=foods.find(f=>String(f.id)===card.dataset.communityFoodId); if(food) openServingModal(food,'community');
      }));
      container.querySelectorAll('[data-edit-community-food]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();const food=foods.find(f=>String(f.id)===button.dataset.editCommunityFood);if(food)openFoodEditor(food,'community');}));
      container.querySelectorAll('[data-delete-community-food]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();await deleteCommunityFood(button.dataset.deleteCommunityFood);}));
      container.querySelectorAll('[data-personal-food-id]').forEach(card => card.addEventListener('click', event => {
        if(event.target.closest('[data-edit-personal-food],[data-delete-personal-food]')) return;
        const food=foods.find(f=>String(f.id)===card.dataset.personalFoodId); if(food) openServingModal(food,'personal');
      }));
      container.querySelectorAll('[data-edit-personal-food]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();const food=foods.find(f=>String(f.id)===button.dataset.editPersonalFood);if(food)openFoodEditor(food,'personal');}));
      container.querySelectorAll('[data-delete-personal-food]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();await deletePersonalFood(button.dataset.deletePersonalFood);}));
      container.querySelectorAll('[data-open-food]').forEach(card => card.addEventListener('click', event => { if(event.target.closest('[data-compare-food]')) return; const food=foods.find(f=>String(f.id)===card.dataset.openFood); if(food)openServingModal(food, food.source || source); }));
      container.querySelectorAll('[data-compare-food]').forEach(button=>button.addEventListener('click',async event=>{event.stopPropagation();await openCrossReferenceModal(button.dataset.compareFoodName);}));
    };

    const renderPagedSearchModal = (query, source, initialData) => {
      const overlay=document.createElement('div');overlay.className='modal-overlay';
      overlay.innerHTML=`<section class="modal-card food-search-modal" role="dialog" aria-modal="true" aria-labelledby="foodSearchModalTitle"><button class="modal-close" data-close-food-search type="button" aria-label="Close">×</button><p class="eyebrow">${escapeHtml(getSearchLabel(source))}</p><h2 id="foodSearchModalTitle">Search results</h2><p class="page-copy">Showing 15 foods per page. Select a food to choose its serving.</p><div data-food-modal-results></div><div class="food-search-pagination" data-food-pagination></div></section>`;
      document.body.appendChild(overlay); overlay.querySelector('[data-close-food-search]').onclick=()=>overlay.remove();
      const results=overlay.querySelector('[data-food-modal-results]'); const pagination=overlay.querySelector('[data-food-pagination]'); let activePage=1;
      const loadPage=async page=>{results.innerHTML='<p class="page-copy">Loading results…</p>';pagination.innerHTML='';try{let data;if(source==='macrosync')data=page===1&&initialData?initialData:await fetchMacroSyncSearch(query,page,15);else{const response=await fetch(`${searchEndpoint(source)}?q=${encodeURIComponent(query)}&page=${page}&pageSize=15`);data=await response.json();if(!response.ok)throw new Error(data.error||'Food search failed.');}activePage=Number(data.page)||page;const foods=Array.isArray(data.foods)?data.foods:[];if(!foods.length){results.innerHTML='<p class="page-copy">No foods found on this page.</p>';return;}results.innerHTML=foods.map(food=>source==='macrosync'?(food._source==='community'?communityFoodCard(food):personalFoodCard(food)):foodCard(food,food.source||'external')).join('');bindFoodResults(results,foods,source);const totalPages=Math.max(1,Number(data.totalPages)||Math.ceil((Number(data.totalHits)||foods.length)/15));if(totalPages>1){const buttons=[];const first=Math.max(1,activePage-2),last=Math.min(totalPages,first+4);if(activePage>1)buttons.push(`<button type="button" class="ghost-button" data-page="${activePage-1}">Previous</button>`);for(let i=first;i<=last;i++)buttons.push(`<button type="button" class="${i===activePage?'primary-button':'ghost-button'}" data-page="${i}">${i}</button>`);if(activePage<totalPages)buttons.push(`<button type="button" class="ghost-button" data-page="${activePage+1}">Next</button>`);pagination.innerHTML=buttons.join('');pagination.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>loadPage(Number(b.dataset.page)));}}catch(error){results.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;}};loadPage(1);
    };

    const runFoodSearch = async () => {
      const q=search.value.trim();
      if(q.length<2){list.innerHTML=`<p class="page-copy">Type at least two characters to search ${getSearchLabel(foodSource)}.</p>`;return;}
      list.innerHTML=`<p class="page-copy">Searching ${getSearchLabel(foodSource)}…</p>`;
      try{
        const data=foodSource==='macrosync'?await fetchMacroSyncSearch(q,1,15):await (async()=>{const response=await fetch(`${searchEndpoint('external')}?q=${encodeURIComponent(q)}&page=1&pageSize=15`);const d=await response.json();if(!response.ok)throw new Error(d.error||'Food search failed.');return d;})();
        const foods=Array.isArray(data.foods)?data.foods:[];
        const visible=foods.slice(0,10);
        const viewAll=Number(data.totalHits||foods.length)>10?`<div class="food-search-view-all"><button type="button" class="ghost-button" data-view-all-foods>View all results</button></div>`:'';
        const markup=foodSource==='macrosync'?visible.map(f=>f._source==='community'?communityFoodCard(f):personalFoodCard(f)).join(''):visible.map(f=>foodCard(f,f.source||'external')).join('');
        list.innerHTML=visible.length?`<p class="food-search-count">Showing ${visible.length} result${visible.length===1?'':'s'}${data.totalHits?` of ${Number(data.totalHits).toLocaleString()}`:''}.</p>${markup}${viewAll}`:'<p class="page-copy">No matching foods found.</p>';
        bindFoodResults(list,visible,foodSource);list.querySelector('[data-view-all-foods]')?.addEventListener('click',()=>renderPagedSearchModal(q,foodSource,data));
      }catch(error){console.error(error);list.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;}
    };
    search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runFoodSearch,350);};
    $('[data-manual-toggle]')?.addEventListener('click',()=>openManualFoodModal());
    $('[data-community-toggle]')?.addEventListener('click',()=>openCommunityFoodModal());
    await renderSelectedDateEntries();
    await renderRecentFoods();
  }

  function foodCard(food, source='usda') {
    const n = food.nutrients || {};
    const serving = food.servingSize ? `${moneyless(food.servingSize)}${food.servingUnit ? ` ${escapeHtml(food.servingUnit)}` : ''}` : '100 g';
    const sourceLabels = { usda:'USDA FoodData Central', openfoodfacts:'Open Food Facts', cnf:'Health Canada CNF', cofid:'UK CoFID' };
    const sourceLabel = sourceLabels[food.source || source] || food.dataType || 'External database';
    const brand = food.brand ? escapeHtml(food.brand) : '';
    const verification = food.nutritionVerification || {};
    const warning = Array.isArray(verification.warnings) && verification.warnings.length
      ? `<small class="food-verification-warning">Nutrition data has a consistency warning</small>`
      : `<small class="food-verification-ok">Nutrition values passed basic consistency checks</small>`;
    return `<article class="food-db-card food-db-result" data-open-food="${escapeHtml(String(food.id))}">
      <div class="food-card-main"><strong>${escapeHtml(food.name)}</strong>
      <p>${brand ? `${brand} · ` : ''}${escapeHtml(sourceLabel)} · ${serving}</p>
      <div class="macro-row"><span>${moneyless(n.calories)} cal</span><span>${moneyless(n.protein)}g protein</span><span>${moneyless(n.carbs)}g carbs</span><span>${moneyless(n.fat)}g fat</span></div>
      ${warning}</div>
      <div class="food-card-actions"><button type="button" class="ghost-button food-compare-button" data-compare-food data-compare-food-name="${escapeHtml(food.name)}">Compare sources</button><button type="button" class="primary-button food-select-button">Add</button></div>
    </article>`;
  }

  async function openCrossReferenceModal(query) {
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card cross-reference-modal" role="dialog" aria-modal="true" aria-labelledby="crossRefTitle"><button class="modal-close" data-close-cross type="button" aria-label="Close">×</button><p class="eyebrow">Nutrition cross-reference</p><h2 id="crossRefTitle">${escapeHtml(query)}</h2><p class="page-copy">MacroSync checks independent databases side by side. It does not average conflicting values or silently replace one source with another.</p><div data-cross-reference-body><p class="page-copy">Checking USDA, Health Canada, UK CoFID, and Open Food Facts…</p></div></section>`;
    document.body.appendChild(overlay); overlay.querySelector('[data-close-cross]').onclick = () => overlay.remove();
    try {
      const response = await fetch(`/api/foods/cross-reference?q=${encodeURIComponent(query)}`);
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Cross-reference failed.');
      const body = overlay.querySelector('[data-cross-reference-body]'); const sources = data.sources || {};
      const labels = { usda:'USDA FoodData Central', cnf:'Health Canada Canadian Nutrient File', cofid:'UK CoFID', openfoodfacts:'Open Food Facts' };
      const pct = value => `${Math.round(Number(value || 0) * 100)}%`;
      const nutrientRows = food => {
        if (!food) return '';
        const n=food.nutrients||{}; const extra=food.extraNutrients||{};
        const extras = Object.values(extra).slice(0,8).map(x => `<span>${escapeHtml(x.label)} ${moneyless(x.value)}</span>`).join('');
        return `<div class="cross-extra-nutrients"><span>Fiber ${moneyless(n.fiber||0)}g</span><span>Sugars ${moneyless(n.sugar||0)}g</span><span>Sodium ${moneyless(n.sodium||0)}mg</span>${extras}</div>`;
      };
      const panel = (food, label) => food ? `<article class="cross-source-card"><p class="eyebrow">${label}</p><h3>${escapeHtml(food.name)}</h3><p>${escapeHtml(food.brand || food.dataType || label)}</p><div class="macro-row"><span>${moneyless(food.nutrients.calories)} cal</span><span>${moneyless(food.nutrients.protein)}g protein</span><span>${moneyless(food.nutrients.carbs)}g carbs</span><span>${moneyless(food.nutrients.fat)}g fat</span></div>${nutrientRows(food)}<small>${food.servingSize ? `Serving reference: ${moneyless(food.servingSize)} ${escapeHtml(food.servingUnit || 'g')}` : 'Values shown per 100 g'}</small></article>` : `<article class="cross-source-card"><p class="eyebrow">${label}</p><p class="page-copy">No matching result.</p></article>`;
      const order=['usda','cnf','cofid','openfoodfacts'];
      let html = `<div class="cross-source-grid cross-source-grid-wide">${order.map(k=>panel((sources[k]||[])[0],labels[k])).join('')}</div>`;
      if (data.comparison?.comparisons?.length) {
        html += `<div class="cross-reference-summary"><strong>Independent-source comparison</strong><p>Compared against ${escapeHtml(labels[data.comparison.baseSource] || data.comparison.baseSource)}. ${data.comparison.comparisons.map(c => `${escapeHtml(labels[c.source]||c.source)}: ${c.nutrition.status}, max nutrition difference ${pct(c.nutrition.maxDifference)}`).join(' · ')}</p><small>${escapeHtml(data.comparison.note || '')}</small></div>`;
      } else {
        html += '<p class="page-copy">MacroSync could not find enough configured sources with a candidate match. You can still choose any individual result shown above.</p>';
      }
      html += `<div class="cross-reference-lists cross-reference-lists-wide">${order.map(source => `<div><strong>${labels[source]}</strong>${(sources[source]||[]).slice(0,5).map(f=>`<button type="button" class="cross-candidate" data-cross-source="${source}" data-cross-id="${escapeHtml(String(f.id))}">${escapeHtml(f.name)} <span>${moneyless(f.nutrients.calories)} cal</span></button>`).join('') || '<small class="page-copy">No candidates.</small>'}</div>`).join('')}</div>`;
      body.innerHTML = html;
      body.querySelectorAll('.cross-candidate').forEach(button => button.onclick = () => { const source=button.dataset.crossSource; const food=(sources[source]||[]).find(f=>String(f.id)===button.dataset.crossId); if(food){overlay.remove();openServingModal(food,source);} });
    } catch(error){ overlay.querySelector('[data-cross-reference-body]').innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`; }
  }

  function personalFoodCard(food) {
    return `<div class="food-db-card personal-food-card" data-personal-food-id="${food.id}">
      <div class="food-card-main"><strong>${escapeHtml(food.name)}</strong>
      <p>My Food · ${moneyless(food.serving_amount)} ${escapeHtml(food.serving_unit)}${food.brand_name ? ` · ${escapeHtml(food.brand_name)}` : ''}${food.store_name ? ` · ${escapeHtml(food.store_name)}` : ''}</p>
      <div class="macro-row"><span>${moneyless(food.calories)} cal</span><span>${moneyless(food.protein)}g protein</span><span>${moneyless(food.carbs)}g carbs</span><span>${moneyless(food.fat)}g fat</span></div></div>
      <div class="food-card-actions"><button type="button" class="ghost-button" data-edit-personal-food="${food.id}">Edit</button><button type="button" class="food-delete-button" data-delete-personal-food="${food.id}" aria-label="Delete ${escapeHtml(food.name)}">Delete</button></div>
    </div>`;
  }

  function communityFoodCard(food) {
    const author = food.author_profile?.display_name || 'MacroSync User';
    const role = food.author_profile?.role === 'trainer' ? 'Personal Trainer' : 'User';
    const mine = String(food.user_id) === String(user.id);
    return `<div class="food-db-card community-food-card" data-community-food-id="${food.id}">
      <div class="food-card-main"><strong>${escapeHtml(food.name)}</strong>
      <p>Community Food · ${escapeHtml(food.serving_options?.[0]?.amount || 1)} ${escapeHtml(food.serving_options?.[0]?.unit || 'serving')}${food.brand_name ? ` · ${escapeHtml(food.brand_name)}` : ''}${food.store_name ? ` · ${escapeHtml(food.store_name)}` : ''}</p>
      <p class="food-author">@${escapeHtml(author)} · ${escapeHtml(role)}</p>
      <div class="macro-row"><span>${moneyless(food.calories_per_100g)} cal</span><span>${moneyless(food.protein_per_100g)}g protein</span><span>${moneyless(food.carbs_per_100g)}g carbs</span><span>${moneyless(food.fat_per_100g)}g fat</span></div></div>
      ${mine ? `<div class="food-card-actions"><button type="button" class="ghost-button" data-edit-community-food="${food.id}">Edit</button><button type="button" class="food-delete-button" data-delete-community-food="${food.id}" aria-label="Delete ${escapeHtml(food.name)}">Delete</button></div>` : ''}
    </div>`;
  }

  async function findCommunityAuthorIds(authorQuery) {
    const q = authorQuery.replace(/^@+/, '').trim();
    if (!q) return [];
    const {data,error}=await supabase.from('profiles').select('id,display_name,role,business_name').or(`display_name.ilike.%${q}%,business_name.ilike.%${q}%`).limit(30);
    if(error) throw error;
    return (data||[]).map(p=>p.id);
  }

  async function renderMyCommunityFoods() {
    const box = $('[data-my-community-food-list]');
    if (!box) return;
    const { data, error } = await supabase.from('community_foods').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
    if (error) { box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; return; }
    const foods = data || [];
    if (foods.length) {
      foods.forEach(f => { f.author_profile = null; });
    }
    box.innerHTML = foods.length ? foods.map(communityFoodCard).join('') : '<p class="page-copy">You have not published any Community Foods yet.</p>';
    box.querySelectorAll('[data-community-food-id]').forEach(card => card.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-community-food]')) return;
      const food = foods.find(f => String(f.id) === card.dataset.communityFoodId);
      if (food) openServingModal(food, 'community');
    }));
    box.querySelectorAll('[data-edit-community-food]').forEach(button => button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const food = foods.find(f => String(f.id) === button.dataset.editCommunityFood);
      if (food) openFoodEditor(food, 'community');
    }));
    box.querySelectorAll('[data-delete-community-food]').forEach(button => button.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteCommunityFood(button.dataset.deleteCommunityFood);
    }));
  }

  async function renderCommunityFoods(query='') {
    const box=$('[data-community-food-list]') || $('[data-food-database-list]'); if(!box)return;
    const raw=query.trim();
    const authorSearch=raw.startsWith('@');
    let request=supabase.from('community_foods').select('*').eq('is_public', true).order('name').limit(50);
    if(authorSearch){
      const ids=await findCommunityAuthorIds(raw);
      if(!ids.length){box.innerHTML='<p class="page-copy">No users or personal trainers matched that @name.</p>';return;}
      request=request.in('user_id', ids);
    } else {
      // Include the current user's own published foods in the normal Community search.
      // The RLS policy already allows owners to read their own records, and hiding them
      // here made a food disappear immediately after the user published it.
      if(raw) request=request.ilike('name', `%${raw.replace(/[%_]/g,'')}%`);
    }
    const {data,error}=await request;
    if(error){box.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const foods=data||[];
    if(foods.length){
      const ids=[...new Set(foods.map(f=>f.user_id).filter(Boolean))];
      const {data:profiles}=await supabase.from('profiles').select('id,display_name,role,business_name').in('id',ids);
      const byId=new Map((profiles||[]).map(p=>[p.id,p]));
      foods.forEach(f=>f.author_profile=byId.get(f.user_id)||null);
    }
    box.innerHTML=foods.length?foods.map(communityFoodCard).join(''):'<p class="page-copy">No published community foods found.</p>';
    box.querySelectorAll('[data-community-food-id]').forEach(card=>card.addEventListener('click',(e)=>{if(e.target.closest('[data-delete-community-food],[data-edit-community-food]'))return;const food=foods.find(f=>String(f.id)===card.dataset.communityFoodId);if(food)openServingModal(food,'community');}));
    box.querySelectorAll('[data-edit-community-food]').forEach(button=>button.addEventListener('click',async(e)=>{e.stopPropagation();const food=foods.find(f=>String(f.id)===button.dataset.editCommunityFood);if(food)openFoodEditor(food,'community');}));
    box.querySelectorAll('[data-delete-community-food]').forEach(button=>button.addEventListener('click',async(e)=>{e.stopPropagation();await deleteCommunityFood(button.dataset.deleteCommunityFood);}));
  }

  async function deletePersonalFood(id) {
    const foodName = document.querySelector(`[data-personal-food-id="${CSS.escape(String(id))}"] strong`)?.textContent || 'this food';
    const {data:food,error:lookupError}=await supabase.from('user_foods').select('id,name,community_food_id').eq('id',id).eq('user_id',user.id).maybeSingle();
    if(lookupError){alert(lookupError.message);return;}
    if(!food)return;

    const communityId=food.community_food_id;
    let deleteCommunity=false;
    if(communityId){
      const choice=await choosePersonalFoodDelete(foodName);
      if(choice==='cancel')return;
      deleteCommunity=choice==='both';
    } else if(!confirm(`Delete ${foodName} from My Foods?`)) {
      return;
    }

    if(deleteCommunity){
      const {error}=await supabase.from('community_foods').delete().eq('id',communityId).eq('user_id',user.id);
      if(error){alert(error.message);return;}
    }

    const {error}=await supabase.from('user_foods').delete().eq('id',id).eq('user_id',user.id);
    if(error){alert(error.message);return;}
    await renderPersonalFoods();
    await renderMyCommunityFoods();
    if(deleteCommunity && $('[data-food-source].active')?.dataset.foodSource==='community') {
      await renderCommunityFoods($('[data-food-search]')?.value || '');
    }
  }

  function choosePersonalFoodDelete(foodName){
    return new Promise(resolve=>{
      const overlay=document.createElement('div');
      overlay.className='modal-overlay';
      overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="deleteFoodTitle"><button class="modal-close" data-delete-choice="cancel" type="button">×</button><p class="eyebrow">Delete food</p><h2 id="deleteFoodTitle">${escapeHtml(foodName)}</h2><p class="page-copy">This personal food is also linked to a Community Food you published. Choose what you want to remove.</p><div class="modal-actions delete-food-actions"><button class="ghost-button" data-delete-choice="cancel" type="button">Cancel</button><button class="ghost-button" data-delete-choice="personal" type="button">Delete from My Foods only</button><button class="primary-button danger-button" data-delete-choice="both" type="button">Delete from both</button></div></section>`;
      document.body.appendChild(overlay);
      const finish=choice=>{overlay.remove();resolve(choice);};
      overlay.querySelectorAll('[data-delete-choice]').forEach(button=>button.addEventListener('click',()=>finish(button.dataset.deleteChoice)));
    });
  }

  async function deleteCommunityFood(id) {
    const foodName = document.querySelector(`[data-community-food-id="${CSS.escape(String(id))}"] strong`)?.textContent || 'this food';
    if(!confirm(`Delete ${foodName} from Community Foods? A linked copy in My Foods will remain private.`)) return;
    const {error}=await supabase.from('community_foods').delete().eq('id',id).eq('user_id',user.id);
    if(error){alert(error.message);return;}
    await renderCommunityFoods($('[data-food-search]')?.value || '');
    await renderMyCommunityFoods();
  }

  function servingOptionRow(index, values = {}) {
    const amount = values.amount ?? '';
    const unit = values.unit ?? '';
    const grams = values.grams ?? '';
    const calories = values.calories ?? '';
    const protein = values.protein ?? '';
    const carbs = values.carbs ?? '';
    const fat = values.fat ?? '';
    return `<div class="serving-option-editor" data-serving-option-row="${index}">
      <div class="serving-option-heading"><strong>Additional serving</strong><button type="button" class="ghost-button" data-remove-serving-option>Remove</button></div>
      <div class="form-grid">
        <div class="field"><label>Amount</label><input data-option-amount type="number" min="0.01" step="0.01" value="${escapeHtml(String(amount))}" placeholder="4"></div>
        <div class="field"><label>Unit</label><input data-option-unit maxlength="40" value="${escapeHtml(String(unit))}" placeholder="oz, g, egg, cup"></div>
        <div class="field"><label>Weight in grams <span class="field-hint">(needed for reference)</span></label><input data-option-grams type="number" min="0.01" step="0.01" value="${escapeHtml(String(grams))}" placeholder="113.4"></div>
      </div>
      <div class="serving-option-nutrition">
        <p class="field-help">Optional: enter nutrition for this serving exactly as you know it. If left blank, MacroSync can estimate it from the default serving.</p>
        <div class="form-grid">
          <div class="field"><label>Calories</label><input data-option-cal type="number" min="0" step="0.1" value="${escapeHtml(String(calories))}"></div>
          <div class="field"><label>Protein (g)</label><input data-option-protein type="number" min="0" step="0.1" value="${escapeHtml(String(protein))}"></div>
          <div class="field"><label>Carbs (g)</label><input data-option-carbs type="number" min="0" step="0.1" value="${escapeHtml(String(carbs))}"></div>
          <div class="field"><label>Fat (g)</label><input data-option-fat type="number" min="0" step="0.1" value="${escapeHtml(String(fat))}"></div>
        </div>
      </div>
    </div>`;
  }

  function collectServingOptions(overlay) {
    return [...overlay.querySelectorAll('[data-serving-option-row]')].map(row => {
      const amount=Number(row.querySelector('[data-option-amount]')?.value);
      const unit=row.querySelector('[data-option-unit]')?.value.trim() || '';
      const grams=Number(row.querySelector('[data-option-grams]')?.value);
      const vals=['cal','protein','carbs','fat'].map(k => row.querySelector(`[data-option-${k}]`)?.value.trim() || '');
      const nutritionProvided=vals.every(v => v !== '');
      return {amount,unit,grams, nutritionProvided, ...(nutritionProvided ? {calories:Number(vals[0]),protein:Number(vals[1]),carbs:Number(vals[2]),fat:Number(vals[3])} : {})};
    });
  }

  function attachServingOptionEditor(overlay) {
    const list=overlay.querySelector('[data-serving-option-list]');
    overlay.querySelector('[data-add-serving-option]')?.addEventListener('click',()=>{
      const index=list.children.length;
      list.insertAdjacentHTML('beforeend',servingOptionRow(index));
      list.lastElementChild.querySelector('[data-remove-serving-option]').onclick=()=>list.lastElementChild.remove();
    });
    list?.querySelectorAll('[data-remove-serving-option]').forEach(b=>b.onclick=()=>b.closest('[data-serving-option-row]')?.remove());
  }

  function servingOptionHelpText() {
    return `Add exact serving choices when you know them (for example, 4 oz, 100 g, 1 egg, or 1 cup). If you enter nutrition for an additional serving, MacroSync uses those values directly instead of converting them. If you do not provide an exact option, you can either keep the food limited to its default serving or allow estimated conversions.`;
  }

  function openFoodEditor(food, source='community') {
    const isCommunity = source === 'community';
    const defaultOption = Array.isArray(food.serving_options) && food.serving_options.length
      ? food.serving_options[0]
      : {amount: food.serving_amount || 1, unit: food.serving_unit || 'serving', grams: food.serving_grams || 100,
         calories: food.calories ?? Number(food.calories_per_100g || 0) * Number(food.serving_grams || 100) / 100,
         protein: food.protein ?? Number(food.protein_per_100g || 0) * Number(food.serving_grams || 100) / 100,
         carbs: food.carbs ?? Number(food.carbs_per_100g || 0) * Number(food.serving_grams || 100) / 100,
         fat: food.fat ?? Number(food.fat_per_100g || 0) * Number(food.serving_grams || 100) / 100};
    const options = (Array.isArray(food.serving_options) ? food.serving_options : []).slice(1);
    const cal = Number(defaultOption.calories ?? food.calories ?? 0);
    const pro = Number(defaultOption.protein ?? food.protein ?? 0);
    const carb = Number(defaultOption.carbs ?? food.carbs ?? 0);
    const fat = Number(defaultOption.fat ?? food.fat ?? 0);
    const overlay=document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">${isCommunity?'Community Food':'My Food'}</p><h2>Edit food</h2><p class="page-copy">Correct the food without deleting and recreating it. Changes are saved to this food record.${isCommunity?' If this Community Food has a linked private copy in My Foods, that copy will be updated too.':''}</p><div class="form-grid"><div class="field"><label>Name</label><input data-e-name maxlength="120" value="${escapeHtml(food.name)}"></div><div class="field"><label>Brand <span class="field-hint">(optional)</span></label><input data-e-brand maxlength="120" value="${escapeHtml(food.brand_name || '')}" placeholder="Mission"></div><div class="field"><label>Store <span class="field-hint">(optional)</span></label><input data-e-store maxlength="120" value="${escapeHtml(food.store_name || '')}" placeholder="Walmart"></div><div class="field"><label>Default serving amount</label><input data-e-amount type="number" min="0.01" step="0.01" value="${escapeHtml(String(defaultOption.amount||1))}"></div><div class="field"><label>Default serving unit</label><input data-e-unit maxlength="40" value="${escapeHtml(defaultOption.unit||'serving')}"></div><div class="field"><label>Default serving weight (g)</label><input data-e-grams type="number" min="0.01" step="0.01" value="${escapeHtml(String(defaultOption.grams||100))}"></div><div class="field"><label>Calories for default serving</label><input data-e-cal type="number" min="0" step="0.1" value="${escapeHtml(String(cal))}"></div><div class="field"><label>Protein (g)</label><input data-e-protein type="number" min="0" step="0.1" value="${escapeHtml(String(pro))}"></div><div class="field"><label>Carbs (g)</label><input data-e-carbs type="number" min="0" step="0.1" value="${escapeHtml(String(carb))}"></div><div class="field"><label>Fat (g)</label><input data-e-fat type="number" min="0" step="0.1" value="${escapeHtml(String(fat))}"></div></div><div class="serving-options-builder"><div class="serving-option-builder-header"><div><h3>Additional serving options</h3><p class="page-copy">Edit or remove the serving choices you previously created.</p></div><button type="button" class="ghost-button" data-add-serving-option>+ Add option</button></div><div data-serving-option-list></div></div><div class="field"><label>When an exact option is not provided</label><select data-e-conversion><option value="none" ${food.conversion_mode==='none'?'selected':''}>Exact servings only</option><option value="estimate" ${food.conversion_mode==='estimate'?'selected':''}>Allow MacroSync auto conversions</option></select></div><p class="save-status" data-e-status></p><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-e-save type="button">Save changes</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    const list=overlay.querySelector('[data-serving-option-list]'); options.forEach((o,i)=>{list.insertAdjacentHTML('beforeend',servingOptionRow(i,o));}); attachServingOptionEditor(overlay);
    overlay.querySelector('[data-e-save]').onclick=async()=>{
      const status=overlay.querySelector('[data-e-status]'); const name=overlay.querySelector('[data-e-name]').value.trim();
      const amount=Number(overlay.querySelector('[data-e-amount]').value), grams=Number(overlay.querySelector('[data-e-grams]').value), unit=overlay.querySelector('[data-e-unit]').value.trim()||'serving';
      const brandName=overlay.querySelector('[data-e-brand]')?.value.trim()||null; const storeName=overlay.querySelector('[data-e-store]')?.value.trim()||null;
      const values=[Number(overlay.querySelector('[data-e-cal]').value),Number(overlay.querySelector('[data-e-protein]').value),Number(overlay.querySelector('[data-e-carbs]').value),Number(overlay.querySelector('[data-e-fat]').value)];
      const [calories,protein,carbs,fat]=values; const conversionMode=overlay.querySelector('[data-e-conversion]').value; const extraOptions=collectServingOptions(overlay);
      const errorMsg=validateDisplayName(name); if(errorMsg){status.textContent=errorMsg;return;}
      if(!Number.isFinite(amount)||amount<=0||!Number.isFinite(grams)||grams<=0||values.some(v=>!Number.isFinite(v)||v<0)){status.textContent='Enter valid nutrition values and a positive default serving weight.';return;}
      if(protein+carbs+fat>100.5){status.textContent='The default serving macros are too large to be valid.';return;}
      for(const o of extraOptions){if(!Number.isFinite(o.amount)||o.amount<=0||!o.unit||!Number.isFinite(o.grams)||o.grams<=0){status.textContent='Complete every additional serving option, including its gram weight.';return;}if(o.nutritionProvided&&[o.calories,o.protein,o.carbs,o.fat].some(v=>!Number.isFinite(v)||v<0)){status.textContent='Additional serving nutrition must use valid non-negative values.';return;}}
      status.textContent='Saving…';
      const p100={calories_per_100g:calories*100/grams,protein_per_100g:protein*100/grams,carbs_per_100g:carbs*100/grams,fat_per_100g:fat*100/grams};
      const allOptions=[{amount,unit,grams,calories,protein,carbs,fat},...extraOptions];
      if(isCommunity){
        const {data:updated,error}=await supabase.from('community_foods').update({name, brand_name:brandName, store_name:storeName, ...p100, serving_options:allOptions, conversion_mode:conversionMode}).eq('id',food.id).eq('user_id',user.id).select('*').single();
        if(error){status.textContent=error.message;return;}
        if(updated.personal_food_id){const {error:personalError}=await supabase.from('user_foods').update({name,brand_name:brandName,store_name:storeName,serving_amount:amount,serving_unit:unit,serving_grams:grams,serving_options:extraOptions,conversion_mode:conversionMode,calories,protein,carbs,fat,source:'community'}).eq('id',updated.personal_food_id).eq('user_id',user.id);if(personalError){status.textContent=personalError.message;return;}}
      } else {
        const {data:updated,error}=await supabase.from('user_foods').update({name,brand_name:brandName,store_name:storeName,serving_amount:amount,serving_unit:unit,serving_grams:grams,serving_options:extraOptions,conversion_mode:conversionMode,calories,protein,carbs,fat}).eq('id',food.id).eq('user_id',user.id).select('*').single();
        if(error){status.textContent=error.message;return;}
      }
      overlay.remove(); await renderPersonalFoods(); await renderMyCommunityFoods(); await renderCommunityFoods($('[data-food-search]')?.value || '');
    };
  }

  function openCommunityFoodModal(){
    if (document.body.dataset.canPublishCommunity !== 'true') { alert('Only verified trainers can publish Community Foods.'); return; }
    const overlay=document.createElement('div');overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Food databases</p><h2>Add a food</h2><p class="page-copy">Set one default serving and its nutrition. Then add optional exact serving choices for people who prefer grams, ounces, cups, or individual units.</p><div class="form-grid"><div class="field"><label>Name</label><input data-c-name maxlength="120" placeholder="Egg"></div><div class="field"><label>Brand <span class="field-hint">(optional)</span></label><input data-c-brand maxlength="120" placeholder="Mission"></div><div class="field"><label>Store <span class="field-hint">(optional)</span></label><input data-c-store maxlength="120" placeholder="Walmart"></div><div class="field"><label>Default serving amount</label><input data-c-amount type="number" min="0.01" step="0.01" value="1"></div><div class="field"><label>Default serving unit</label><input data-c-unit maxlength="40" value="serving" placeholder="egg, slice, cup"></div><div class="field"><label>Default serving weight (g)</label><input data-c-grams type="number" min="0.01" step="0.01" value="100"></div><div class="field"><label>Calories for default serving</label><input data-c-cal type="number" min="0" step="0.1"></div><div class="field"><label>Protein (g)</label><input data-c-protein type="number" min="0" step="0.1"></div><div class="field"><label>Carbs (g)</label><input data-c-carbs type="number" min="0" step="0.1"></div><div class="field"><label>Fat (g)</label><input data-c-fat type="number" min="0" step="0.1"></div></div><div class="serving-options-builder"><div class="serving-option-builder-header"><div><h3>Additional serving options</h3><p class="page-copy">${servingOptionHelpText()}</p></div><button type="button" class="ghost-button" data-add-serving-option>+ Add option</button></div><div data-serving-option-list></div></div><div class="field"><label>When an exact option is not provided</label><select data-c-conversion><option value="none" selected>Exact servings only</option><option value="estimate">Allow MacroSync auto conversions</option></select><p class="field-help">Estimated conversions are based on the serving weight and may not match the source exactly.</p></div><label class="toggle-row"><input data-c-personal type="checkbox" checked><span><strong>Save to My Foods</strong><small>Keep a private copy in your personal food database.</small></span></label><label class="toggle-row"><input data-c-publish type="checkbox" checked><span><strong>Publish to Community Foods</strong><small>Make the food searchable by other MacroSync users.</small></span></label><p class="save-status" data-c-status></p><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-c-save type="button">Save food</button></div></section>`;
    document.body.appendChild(overlay);overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());attachServingOptionEditor(overlay);
    overlay.querySelector('[data-c-save]').onclick=async()=>{
      const status=overlay.querySelector('[data-c-status]');const name=overlay.querySelector('[data-c-name]').value.trim();const brandName=overlay.querySelector('[data-c-brand]')?.value.trim()||null;const storeName=overlay.querySelector('[data-c-store]')?.value.trim()||null;const cal=Number(overlay.querySelector('[data-c-cal]').value),pro=Number(overlay.querySelector('[data-c-protein]').value),carb=Number(overlay.querySelector('[data-c-carbs]').value),fat=Number(overlay.querySelector('[data-c-fat]').value),amount=Number(overlay.querySelector('[data-c-amount]').value),grams=Number(overlay.querySelector('[data-c-grams]').value),unit=overlay.querySelector('[data-c-unit]').value.trim()||'serving';
      const savePersonal=overlay.querySelector('[data-c-personal]').checked; const publishCommunity= document.body.dataset.canPublishCommunity === 'true' && overlay.querySelector('[data-c-publish]').checked; const conversionMode=overlay.querySelector('[data-c-conversion]').value; const options=collectServingOptions(overlay);
      const errorMsg=validateDisplayName(name); if(errorMsg){status.textContent=errorMsg;return;} if(!savePersonal&&!publishCommunity){status.textContent='Choose at least one database.';return;}
      if([cal,pro,carb,fat,amount,grams].some(v=>!Number.isFinite(v)||v<0)||amount<=0||grams<=0){status.textContent='Enter valid nutrition values and a positive default serving weight.';return;}
      for(const o of options){if(!Number.isFinite(o.amount)||o.amount<=0||!o.unit||!Number.isFinite(o.grams)||o.grams<=0){status.textContent='Complete every additional serving option, including its gram weight.';return;}if(o.nutritionProvided&&[o.calories,o.protein,o.carbs,o.fat].some(v=>!Number.isFinite(v)||v<0)){status.textContent='Additional serving nutrition must use valid non-negative values.';return;}}
      if(options.some(o=>o.nutritionProvided&&o.protein+o.carbs+o.fat>100.5)){status.textContent='One additional serving has macros above 100 g and cannot be saved.';return;}
      if(pro+carb+fat>100.5){status.textContent='The default serving macros are too large to be valid.';return;}
      status.textContent='Saving…';
      const p100={p_calories_per_100g:cal*100/grams,p_protein_per_100g:pro*100/grams,p_carbs_per_100g:carb*100/grams,p_fat_per_100g:fat*100/grams};
      const {data,error}=await supabase.rpc('create_food_records',{p_name:name,...p100,p_serving_amount:amount,p_serving_unit:unit,p_serving_grams:grams,p_serving_options:options,p_conversion_mode:conversionMode,p_save_personal:savePersonal,p_publish_community:publishCommunity,p_personal_source:'community',p_personal_calories:cal,p_personal_protein:pro,p_personal_carbs:carb,p_personal_fat:fat,p_brand_name:brandName,p_store_name:storeName});
      if(error){status.textContent=error.message;return;} overlay.remove();await renderPersonalFoods();if(publishCommunity){await renderCommunityFoods();await renderMyCommunityFoods();}
      if(data?.personal_food_id&&savePersonal){const {data:personal}=await supabase.from('user_foods').select('*').eq('id',data.personal_food_id).single();if(personal)openServingModal(personal,'personal');}
    };
  }

  function recentFoodCard(food) {
    const sourceLabel = food.source === 'personal' ? 'Personal Food' : food.source === 'community' ? 'Community Food' : food.source === 'usda' ? 'USDA' : food.source === 'openfoodfacts' ? 'Open Food Facts' : food.source === 'cnf' ? 'Health Canada CNF' : food.source === 'cofid' ? 'UK CoFID' : 'Recently logged';
    return `<article class="food-db-card recent-food-card" data-recent-food-id="${escapeHtml(String(food.id))}"><div class="food-card-main"><strong>${escapeHtml(food.food_name)}</strong><p>${escapeHtml(sourceLabel)} · ${escapeHtml(food.serving || '1 serving')}${food.brand_name ? ` · ${escapeHtml(food.brand_name)}` : ''}</p><div class="macro-row"><span>${moneyless(food.calories)} cal</span><span>${moneyless(food.protein)}g protein</span><span>${moneyless(food.carbs)}g carbs</span><span>${moneyless(food.fat)}g fat</span></div></div><div class="food-card-actions"><button type="button" class="primary-button" data-add-recent-food="${escapeHtml(String(food.id))}">+ Add</button></div></article>`;
  }
  async function renderRecentFoods() {
    const box=$('[data-recent-food-list]'); if(!box)return;
    const {data,error}=await supabase.from('recent_foods').select('*').eq('user_id',user.id).order('last_used_at',{ascending:false}).limit(20);
    if(error){box.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const foods=data||[];
    box.innerHTML=foods.length?foods.map(recentFoodCard).join(''):'<p class="page-copy">Foods you log will appear here for quick reuse. Up to 20 recent foods are kept.</p>';
    box.querySelectorAll('[data-add-recent-food]').forEach(button=>button.addEventListener('click',async()=>{const food=foods.find(f=>String(f.id)===button.dataset.addRecentFood);if(food)await addRecentFood(food);}));
  }
  async function addRecentFood(food){
    const meal=selectedLoggingMeal||userMeals[0]?.name||'Meal 1';
    const target={user_id:user.id,logged_date:dateKey(selectedDate),meal,food_name:food.food_name,serving:food.serving||'1 serving',fdc_id:food.fdc_id||null,source:food.source||'unknown',source_id:food.source_id||'',serving_amount:food.serving_amount||parseServingAmount(food.serving)||1,serving_unit:food.serving_unit||'serving',serving_grams:food.serving_grams||null,brand_name:food.brand_name||null,store_name:food.store_name||null,calories:Number(food.calories||0),protein:Number(food.protein||0),carbs:Number(food.carbs||0),fat:Number(food.fat||0)};
    const {error}=await supabase.from('food_entries').insert(target); if(error){alert(error.message);return;}
    await trackEvent('food_logged',{source:target.source,from_recent:true}); await renderSelectedDateEntries(); await renderRecentFoods();
  }

  async function renderPersonalFoods() {
    const box = $('[data-personal-food-list]');
    if (!box) return;
    const { data, error } = await supabase.from('user_foods').select('*').eq('user_id', user.id).order('name');
    if (error) { box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; return; }
    const foods = data || [];
    box.innerHTML = foods.length ? foods.map(personalFoodCard).join('') : '<p class="page-copy">You have not created any personal foods yet.</p>';
    box.querySelectorAll('[data-personal-food-id]').forEach(card => card.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-personal-food]')) return;
      const food = foods.find(f => String(f.id) === card.dataset.personalFoodId);
      if (food) openServingModal(food, 'personal');
    }));
    box.querySelectorAll('[data-edit-personal-food]').forEach(button => button.addEventListener('click', async (e) => {
      e.stopPropagation();
      const food = (await supabase.from('user_foods').select('*').eq('id',button.dataset.editPersonalFood).eq('user_id',user.id).maybeSingle()).data;
      if (food) openFoodEditor(food, 'personal');
    }));
    box.querySelectorAll('[data-delete-personal-food]').forEach(button => button.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deletePersonalFood(button.dataset.deletePersonalFood);
    }));
  }

  async function renderSavedMeals() {
    const box = $('[data-saved-meal-list]');
    if (!box) return;
    const { data, error } = await supabase.from('saved_meals').select('*, saved_meal_items(*)').eq('user_id', user.id).order('name');
    if (error) { box.innerHTML = `<p class="page-copy">${escapeHtml(error.message)}</p>`; return; }
    const meals = data || [];
    box.innerHTML = meals.length ? meals.map(savedMealCard).join('') : '<p class="page-copy">No saved meals yet. Save a meal from your diary to log it faster later.</p>';
    box.querySelectorAll('[data-log-saved-meal]').forEach(button => button.addEventListener('click', async () => {
      const meal = meals.find(m => String(m.id) === button.dataset.logSavedMeal);
      if (meal) await logSavedMeal(meal);
    }));
  }

  function savedMealCard(meal) {
    const items = Array.isArray(meal.saved_meal_items) ? meal.saved_meal_items : [];
    const calories = items.reduce((sum, item) => sum + Number(item.calories || 0), 0);
    return `<article class="saved-meal-card"><div><strong>${escapeHtml(meal.name)}</strong><p>${items.length} item${items.length === 1 ? '' : 's'} · ${moneyless(calories)} cal</p></div><button class="ghost-button" type="button" data-log-saved-meal="${meal.id}">Add</button></article>`;
  }

  function normalizeServingUnit(unit) {
    const u = String(unit || '').trim().toLowerCase();
    if (/^cups?$/.test(u) || u.includes('cup')) return 'cup';
    if (/^tablespoons?$|^tbsps?$|^tbsp$/.test(u)) return 'tbsp';
    if (/^teaspoons?$|^tsps?$|^tsp$/.test(u)) return 'tsp';
    if (/^milliliters?$|^millilitres?$|^ml$/.test(u)) return 'ml';
    if (/^grams?$|^g$/.test(u)) return 'g';
    if (/^ounces?$|^oz$/.test(u)) return 'oz';
    if (/^pieces?$|^piece$/.test(u)) return 'piece';
    if (/^slices?$|^slice$/.test(u)) return 'slice';
    if (/^eggs?$|^egg$/.test(u)) return 'egg';
    if (/^scoops?$|^scoop$/.test(u)) return 'scoop';
    return u;
  }

  function buildExternalAutoConversions(food, sourceMeasures = []) {
    const raw = Array.isArray(sourceMeasures) ? sourceMeasures : [];
    const options = [];
    const add = (amount, unit, grams, meta = {}) => {
      const a = Number(amount), g = Number(grams), u = String(unit || '').trim();
      if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(g) || g <= 0 || !u) return;
      const key = `${a}|${normalizeServingUnit(u)}|${g}`;
      if (options.some(o => o._key === key)) return;
      options.push({ amount:a, unit:u, grams:g, ...meta, _key:key });
    };

    raw.forEach(m => add(m.amount || 1, m.unit || m.label || 'serving', m.grams, { sourceProvided:true }));

    // Keep the food's search-result serving as the first fallback when the
    // detail endpoint has no household measures. This keeps the modal opening
    // on the source's own serving instead of unexpectedly defaulting to cups.
    if (Number(food.servingSize) > 0) {
      add(Number(food.servingSize), food.servingUnit || 'g', Number(food.servingSize), { sourceProvided:true });
    }

    const unitOf = o => normalizeServingUnit(o.unit || o.label);
    const cup = options.find(o => unitOf(o) === 'cup');
    let cupGrams = cup?.grams || 0;
    if (!cupGrams) {
      const ml = options.find(o => unitOf(o) === 'ml');
      const tbsp = options.find(o => unitOf(o) === 'tbsp');
      const tsp = options.find(o => unitOf(o) === 'tsp');
      if (ml) cupGrams = (ml.grams / ml.amount) * 240;
      else if (tbsp) cupGrams = (tbsp.grams / tbsp.amount) * 16;
      else if (tsp) cupGrams = (tsp.grams / tsp.amount) * 48;
    }

    // External databases are allowed to use MacroSync's automatic conversion
    // layer. If a source does not expose a household-volume weight, use the
    // standard 240 ml cup as a clearly marked estimate rather than pretending
    // that every food has the same true density.
    if (!(cupGrams > 0)) {
      const baseGrams = Number(food.servingSize) > 0 ? Number(food.servingSize) : 100;
      const baseUnit = normalizeServingUnit(food.servingUnit);
      const densityGramsPerUnit = baseUnit === 'ml' ? baseGrams / 100 : 0;
      cupGrams = densityGramsPerUnit > 0 ? densityGramsPerUnit * 240 : 240;
    }

    if (!cup) add(1, 'cup', cupGrams, { autoGenerated:true, estimated:true });
    const cupSource = options.find(o => unitOf(o) === 'cup');
    const gramsPerCup = Number(cupSource?.grams || cupGrams);
    if (gramsPerCup > 0) {
      if (!options.some(o => unitOf(o) === 'tbsp')) add(1, 'tbsp', gramsPerCup / 16, { autoGenerated:true, estimated:true });
      if (!options.some(o => unitOf(o) === 'tsp')) add(1, 'tsp', gramsPerCup / 48, { autoGenerated:true, estimated:true });
      if (!options.some(o => unitOf(o) === 'ml')) add(240, 'ml', gramsPerCup, { autoGenerated:true, estimated:true });
    }

    const commonUnits = [
      ['piece', ['piece','pieces']],
      ['slice', ['slice','slices']],
      ['egg', ['egg','eggs']],
      ['scoop', ['scoop','scoops']]
    ];
    // Preserve source-provided food-specific units. Never invent a piece/slice/
    // egg/scoop weight from the food name alone.
    for (const [canonical, labels] of commonUnits) {
      const existing = options.find(o => labels.includes(String(o.unit).toLowerCase()) || unitOf(o) === canonical);
      if (existing) continue;
    }

    add(100, 'g', 100, { autoGenerated:true, estimated:false });
    add(1, 'oz', 28.3495, { autoGenerated:true, estimated:false });
    return options.map(({_key, ...o}) => o);
  }

  async function fetchExternalServingOptions(food, source) {
    try {
      if (source === 'usda' && food.id) {
        const response = await fetch(`/api/foods/details-usda/${encodeURIComponent(food.id)}`);
        if (response.ok) { const data = await response.json(); return buildExternalAutoConversions(food, data.measures || []); }
      }
      if (source === 'openfoodfacts' && food.id) {
        const response = await fetch(`/api/foods/details-openfoodfacts/${encodeURIComponent(food.id)}`);
        if (response.ok) { const data = await response.json(); return buildExternalAutoConversions(food, data.measures || []); }
      }
    } catch (error) { console.debug('External serving lookup unavailable:', error?.message || error); }
    return buildExternalAutoConversions(food, []);
  }

  async function openServingModal(food, source) {
    const actualSource = source === 'external' ? (food.source || 'usda') : source;
    const n = actualSource === 'personal'
      ? { calories:Number(food.calories)||0, protein:Number(food.protein)||0, carbs:Number(food.carbs)||0, fat:Number(food.fat)||0 }
      : actualSource === 'community'
        ? { calories:Number(food.calories_per_100g)||0, protein:Number(food.protein_per_100g)||0, carbs:Number(food.carbs_per_100g)||0, fat:Number(food.fat_per_100g)||0 }
        : (food.nutrients || {});
    const storedOptions = Array.isArray(food.serving_options) ? food.serving_options : [];
    const defaultOption = actualSource === 'community'
      ? (storedOptions[0] || {amount:1,unit:'serving',grams:100})
      : actualSource === 'personal'
        ? {amount:Number(food.serving_amount||1),unit:food.serving_unit||'serving',grams:Number(food.serving_grams||100),calories:Number(food.calories)||0,protein:Number(food.protein)||0,carbs:Number(food.carbs)||0,fat:Number(food.fat)||0}
        : null;
    const additionalOptions = actualSource === 'community' ? storedOptions.slice(1) : actualSource === 'personal' ? storedOptions : [];
    const conversionMode = actualSource === 'community' || actualSource === 'personal' ? (food.conversion_mode || 'none') : 'estimate';
    let externalOptions = [];
    if (!['personal','community'].includes(actualSource)) externalOptions = await fetchExternalServingOptions(food, actualSource);
    const externalBaseGrams = Number(food.servingSize) > 0 ? Number(food.servingSize) : 100;
    const externalDefault = externalOptions[0] || { amount:externalBaseGrams, unit:food.servingUnit || 'g', grams:externalBaseGrams };
    const creatorOptions = actualSource === 'community' ? [defaultOption,...additionalOptions] : actualSource === 'personal' ? [defaultOption,...additionalOptions] : [];
    const servingOptions = [...creatorOptions, ...externalOptions.map((o,i)=>({amount:Number(o.amount)||1,unit:o.unit||o.label||'serving',grams:Number(o.grams)||100,external:true,index:i}))];
    const uniqueOptions = []; const seen = new Set();
    for (const option of servingOptions) { const key=`${Number(option.amount)}|${String(option.unit).toLowerCase()}|${Number(option.grams)}`; if(!seen.has(key)){seen.add(key);uniqueOptions.push(option);} }
    const defaultAmount = actualSource === 'personal' || actualSource === 'community' ? Number(defaultOption.amount||1) : Number(externalDefault.amount||1);
    const defaultUnitIndex = uniqueOptions.findIndex(o => String(o.unit).toLowerCase() === String(actualSource === 'personal' || actualSource === 'community' ? defaultOption.unit : externalDefault.unit).toLowerCase() && Number(o.amount||1) === defaultAmount);
    const overlay=document.createElement('div');overlay.className='modal-overlay';
    const sourceLabel = actualSource==='personal'?'My Food':actualSource==='community'?'Community Food':actualSource==='openfoodfacts'?'Open Food Facts':actualSource==='cnf'?'Health Canada CNF':actualSource==='cofid'?'UK CoFID':'USDA Food';
    const weightConversionsAllowed = actualSource !== 'personal' && actualSource !== 'community' || conversionMode !== 'none';
    const todayKey = dateKey(new Date());
    const selectedKey = dateKey(selectedDate);
    const selectedIsToday = selectedKey === todayKey;
    const futureDateOptions = planAheadEnabled ? `
      <div class="field" data-log-date-choice-wrap>
        <label for="servingLogDate">Add food to</label>
        <select id="servingLogDate">
          <option value="selected">${selectedIsToday ? 'Today' : `Selected date (${formatDate(selectedDate)})`}</option>
          <option value="day1">1 day ahead (${formatDate(addDays(new Date(),1))})</option>
          <option value="day2">2 days ahead (${formatDate(addDays(new Date(),2))})</option>
          <option value="both">Both 1 and 2 days ahead</option>
        </select>
        <p class="field-help">Planning ahead can add the same food to one or both future days. Future entries are separate log entries.</p>
      </div>` : '';
    overlay.innerHTML=`<section class="modal-card serving-modal" role="dialog" aria-modal="true" aria-labelledby="servingTitle"><button class="modal-close" type="button" data-close-modal aria-label="Close">×</button><p class="eyebrow">${sourceLabel}</p><h2 id="servingTitle">${escapeHtml(food.name)}</h2>${food.brand_name||food.brand?`<div class="serving-reference"><strong>${escapeHtml(food.brand_name||food.brand)}</strong>${food.store_name?`<span>Store: ${escapeHtml(food.store_name)}</span>`:''}</div>`:''}<div class="serving-reference"><strong>Adding to: ${escapeHtml(selectedLoggingMeal || userMeals[0]?.name || 'Meal 1')}</strong><span>${actualSource==='personal'||actualSource==='community'?'Choose an exact saved serving whenever possible.':externalOptions.length?'MacroSync found serving measurements for this food and will use them before estimated conversions.':'MacroSync can automatically convert this external food to common measurements. Source-provided measurements are preferred; generated household conversions are marked as estimated.'}</span></div><div class="form-grid serving-controls"><div class="field"><label for="servingAmount">Amount</label><input id="servingAmount" type="number" min="0.01" step="0.01" value="${defaultAmount}"></div><div class="field"><label for="servingUnit">Serving type</label><select id="servingUnit">${uniqueOptions.map((o,i)=>`<option value="option-${i}" ${i===defaultUnitIndex?'selected':''}>${moneyless(o.amount)} ${escapeHtml(o.unit)}${o.grams?` (${moneyless(o.grams)} g)`:''}${o.sourceProvided?' · source measure':o.autoGenerated&&o.estimated?' · estimated auto':' · auto'}</option>`).join('')}</select></div>${futureDateOptions}</div><p class="serving-help">Use source-provided measurements whenever available. MacroSync converts every external food through gram weights and provides common measurements such as cups, tablespoons, teaspoons, ml, grams, and ounces. Food-specific units such as slices, pieces, eggs, or scoops are included when the source provides their weight.</p><p class="serving-conversion-warning">${actualSource==='personal'||actualSource==='community'?(conversionMode==='none'?'Only exact creator-provided serving choices are available for this user-added food.':'MacroSync auto conversions are estimates unless an exact serving was provided.'):'External foods always have MacroSync auto conversions. Source-provided measurements are preferred; generated household conversions are marked as estimated.'}</p>${actualSource==='usda'&&food.nutritionVerification?.warnings?.length?`<p class="save-status">USDA reports a consistency warning for this food. The record passed the hard validation checks, but the calorie/macro values may differ because of rounding, fiber, or other USDA calculation methods.</p>`:''}<div class="nutrition-summary" data-serving-preview></div><div class="modal-actions"><button class="ghost-button" type="button" data-close-modal>Cancel</button><button class="primary-button" type="button" data-confirm-serving>Add to ${escapeHtml(selectedLoggingMeal || userMeals[0]?.name || 'meal')}</button></div></section>`;
    document.body.appendChild(overlay);
    const amountInput=overlay.querySelector('#servingAmount'),unitSelect=overlay.querySelector('#servingUnit'),preview=overlay.querySelector('[data-serving-preview]');
    function calculate(){
      const amount=Math.max(0.01,Number(amountInput.value)||1), unit=unitSelect.value; let values,display,exact=false, option=null;
      if(unit.startsWith('option-')) option=uniqueOptions[Number(unit.slice(7))];
      if(option){ const baseAmount=Number(option.amount)||1; const grams=Number(option.grams)||100; if(actualSource==='personal'){ if(option.calories!==undefined){const ratio=amount/baseAmount;values={calories:Number(option.calories)*ratio,protein:Number(option.protein)*ratio,carbs:Number(option.carbs)*ratio,fat:Number(option.fat)*ratio};exact=true;} else {const ratio=(amount*grams/baseAmount)/Number(defaultOption.grams||100);values={calories:n.calories*ratio,protein:n.protein*ratio,carbs:n.carbs*ratio,fat:n.fat*ratio};} } else { const multiplier=amount*grams/baseAmount/100; values={calories:Number(option.calories??n.calories)*multiplier,protein:Number(option.protein??n.protein)*multiplier,carbs:Number(option.carbs??n.carbs)*multiplier,fat:Number(option.fat??n.fat)*multiplier}; if((actualSource==='community')&&option.calories!==undefined){const ratio=amount/baseAmount;values={calories:Number(option.calories)*ratio,protein:Number(option.protein)*ratio,carbs:Number(option.carbs)*ratio,fat:Number(option.fat)*ratio};exact=true;} } display=`${moneyless(amount)} ${option.unit}`; }
      else if(unit==='g'){const multiplier=actualSource==='personal'?(amount/Number(defaultOption.grams||100)):amount/100;values={calories:n.calories*multiplier,protein:n.protein*multiplier,carbs:n.carbs*multiplier,fat:n.fat*multiplier};display=`${moneyless(amount)} g`;}
      else {const multiplier=actualSource==='personal'?(amount*28.3495)/Number(defaultOption.grams||100):(amount*28.3495)/100;values={calories:n.calories*multiplier,protein:n.protein*multiplier,carbs:n.carbs*multiplier,fat:n.fat*multiplier};display=`${moneyless(amount)} oz`;}
      const label=exact?'Exact saved serving':'Calculated from serving weight';preview.innerHTML=`<div><strong>${moneyless(values.calories)}</strong><span>Calories</span></div><div><strong>${moneyless(values.protein)}g</strong><span>Protein</span></div><div><strong>${moneyless(values.carbs)}g</strong><span>Carbs</span></div><div><strong>${moneyless(values.fat)}g</strong><span>Fat</span></div><small class="serving-preview-note">${label}</small>`;return{amount,unit,display,values,option};
    }
    amountInput.oninput=calculate;unitSelect.onchange=calculate;calculate();overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-confirm-serving]').onclick=async()=>{
      const result=calculate();
      const meal=selectedLoggingMeal||userMeals[0]?.name||'Meal 1';
      const sourceId=String(food.id??'');
      const dateChoice=overlay.querySelector('#servingLogDate')?.value||'selected';
      const today=new Date(); today.setHours(0,0,0,0);
      const selectedBase=new Date(selectedDate); selectedBase.setHours(0,0,0,0);
      const targetDates = dateChoice==='day1' ? [addDays(today,1)] : dateChoice==='day2' ? [addDays(today,2)] : dateChoice==='both' ? [addDays(today,1),addDays(today,2)] : [selectedBase];
      const maxDate=addDays(today,2);
      if(targetDates.some(d=>d>maxDate || (d>today && !planAheadEnabled))){alert('Turn on Planning ahead to add foods to future dates. You can plan up to 2 days ahead.');return;}
      const rows=targetDates.map(targetDate=>({user_id:user.id,logged_date:dateKey(targetDate),meal,food_name:food.name,serving:result.display,fdc_id:actualSource==='usda'?Number(food.id):(food.fdc_id?Number(food.fdc_id):null),source:actualSource,source_id:sourceId,serving_amount:result.amount,serving_unit:result.option?.unit||result.unit,serving_grams:result.option?.grams||null,brand_name:food.brand_name||null,store_name:food.store_name||null,calories:result.values.calories,protein:result.values.protein,carbs:result.values.carbs,fat:result.values.fat}));
      const{error}=await supabase.from('food_entries').insert(rows);if(error){alert(error.message);return;}
      await trackEvent('food_logged',{source:actualSource,entries_added:rows.length,planned_days:dateChoice});
      overlay.remove();await renderSelectedDateEntries();await renderRecentFoods();await renderPersonalFoods();
    };
  }

  function openManualFoodModal() {
    const overlay=document.createElement('div');overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" type="button" data-close-modal>×</button><p class="eyebrow">Food databases</p><h2>Create manual food</h2><p class="page-copy">Set the default serving and nutrition first. User-added foods stay exact-only by default. You can add exact alternative servings or explicitly allow MacroSync auto conversions.</p><div class="form-grid"><div class="field"><label>Name</label><input data-manual-name placeholder="Homemade burrito"></div><div class="field"><label>Brand <span class="field-hint">(optional)</span></label><input data-manual-brand maxlength="120" placeholder="Mission"></div><div class="field"><label>Store <span class="field-hint">(optional)</span></label><input data-manual-store maxlength="120" placeholder="Walmart"></div><div class="field"><label>Default serving amount</label><input data-manual-serving type="number" min="0.01" step="0.01" value="1"></div><div class="field"><label>Default serving unit</label><input data-manual-unit value="serving" placeholder="serving, egg, cup..."></div><div class="field"><label>Default serving weight (g)</label><input data-manual-grams type="number" min="0.01" step="0.01" value="100"></div><div class="field"><label>Calories for default serving</label><input data-manual-cal type="number" min="0" step="0.1"></div><div class="field"><label>Protein (g)</label><input data-manual-protein type="number" min="0" step="0.1"></div><div class="field"><label>Carbs (g)</label><input data-manual-carbs type="number" min="0" step="0.1"></div><div class="field"><label>Fat (g)</label><input data-manual-fat type="number" min="0" step="0.1"></div></div><div class="serving-options-builder"><div class="serving-option-builder-header"><div><h3>Additional serving options</h3><p class="page-copy">${servingOptionHelpText()}</p></div><button type="button" class="ghost-button" data-add-serving-option>+ Add option</button></div><div data-serving-option-list></div></div><div class="field"><label>When an exact option is not provided</label><select data-manual-conversion><option value="none" selected>Exact servings only</option><option value="estimate">Allow MacroSync auto conversions</option></select><p class="field-help">Auto conversions are generated from the stored serving weight. For user-added foods, enable this only when you accept estimated household conversions.</p></div><label class="toggle-row"><input data-manual-community type="checkbox"><span><strong>Also publish to Community Foods</strong><small>Publish the same serving choices for other MacroSync users.</small></span></label><div class="modal-actions"><button class="ghost-button" data-close-modal type="button">Cancel</button><button class="primary-button" data-save-manual type="button">Save food & add to meal</button></div><p class="save-status" data-manual-status></p></section>`;
    document.body.appendChild(overlay);
    if (document.body.dataset.canPublishCommunity !== 'true') { const publishToggle = overlay.querySelector('[data-manual-community]')?.closest('.toggle-row'); if (publishToggle) publishToggle.hidden = true; }
    overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());attachServingOptionEditor(overlay);
    overlay.querySelector('[data-save-manual]').onclick=async()=>{
      const status=overlay.querySelector('[data-manual-status]');const name=overlay.querySelector('[data-manual-name]').value.trim();const brandName=overlay.querySelector('[data-manual-brand]')?.value.trim()||null;const storeName=overlay.querySelector('[data-manual-store]')?.value.trim()||null;if(!name){status.textContent='Enter a food name.';return;}
      const servingAmount=Number(overlay.querySelector('[data-manual-serving]').value),grams=Number(overlay.querySelector('[data-manual-grams]').value),calories=Number(overlay.querySelector('[data-manual-cal]').value)||0,protein=Number(overlay.querySelector('[data-manual-protein]').value)||0,carbs=Number(overlay.querySelector('[data-manual-carbs]').value)||0,fat=Number(overlay.querySelector('[data-manual-fat]').value)||0,unit=overlay.querySelector('[data-manual-unit]').value.trim()||'serving';const options=collectServingOptions(overlay);const conversionMode=overlay.querySelector('[data-manual-conversion]').value;const publishCommunity= document.body.dataset.canPublishCommunity === 'true' && overlay.querySelector('[data-manual-community]').checked;
      const errorMsg=validateDisplayName(name);if(errorMsg){status.textContent=errorMsg;return;}if(!Number.isFinite(servingAmount)||servingAmount<=0||!Number.isFinite(grams)||grams<=0||[calories,protein,carbs,fat].some(v=>!Number.isFinite(v)||v<0)){status.textContent='Enter valid nutrition values and a positive default serving weight.';return;}
      for(const o of options){if(!Number.isFinite(o.amount)||o.amount<=0||!o.unit||!Number.isFinite(o.grams)||o.grams<=0){status.textContent='Complete every additional serving option, including its gram weight.';return;}if(o.nutritionProvided&&[o.calories,o.protein,o.carbs,o.fat].some(v=>!Number.isFinite(v)||v<0)){status.textContent='Additional serving nutrition must use valid non-negative values.';return;}}
      if(protein+carbs+fat>100.5){status.textContent='The default serving macros are too large to be valid.';return;}status.textContent='Saving…';
      const {data,error}=await supabase.rpc('create_food_records',{p_name:name,p_calories_per_100g:calories*100/grams,p_protein_per_100g:protein*100/grams,p_carbs_per_100g:carbs*100/grams,p_fat_per_100g:fat*100/grams,p_serving_amount:servingAmount,p_serving_unit:unit,p_serving_grams:grams,p_serving_options:options,p_conversion_mode:conversionMode,p_save_personal:true,p_publish_community:publishCommunity,p_personal_calories:calories,p_personal_protein:protein,p_personal_carbs:carbs,p_personal_fat:fat,p_brand_name:brandName,p_store_name:storeName});
      if(error){status.textContent=error.message;return;}overlay.remove();await renderPersonalFoods();if(publishCommunity){await renderCommunityFoods();await renderMyCommunityFoods();}const personalId=data?.personal_food_id;if(personalId){const {data:personal}=await supabase.from('user_foods').select('*').eq('id',personalId).single();if(personal)openServingModal(personal,'personal');}
    };
  }

  async function saveManualFoodAndLog() { openManualFoodModal(); }

  async function logSavedMeal(meal) {
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    overlay.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Saved meal</p><h2>${escapeHtml(meal.name)}</h2><div class="field"><label for="savedMealDestination">Add to meal</label><select id="savedMealDestination">${mealOptionsMarkup(userMeals[0]?.name || '')}</select></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-confirm-saved-meal type="button">Add to meal</button></div></section>`;
    document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());
    overlay.querySelector('[data-confirm-saved-meal]').onclick=async()=>{const mealName=overlay.querySelector('#savedMealDestination').value;const items=(meal.saved_meal_items||[]).map(item=>({user_id:user.id,logged_date:dateKey(selectedDate),meal:mealName,food_name:item.food_name,serving:item.serving,fdc_id:item.fdc_id,source:item.source||'saved_meal',source_id:item.source_id||'',serving_amount:item.serving_amount||parseServingAmount(item.serving)||1,serving_unit:item.serving_unit||'serving',serving_grams:item.serving_grams||null,brand_name:item.brand_name||null,store_name:item.store_name||null,calories:item.calories,protein:item.protein,carbs:item.carbs,fat:item.fat}));if(!items.length)return;const {error}=await supabase.from('food_entries').insert(items);if(error){alert(error.message);return;}overlay.remove();await renderSelectedDateEntries();};
  }

  async function saveCurrentMealAsSaved(mealName) {
    const entries = (await getEntries()).filter(e => e.meal === mealName);
    if (!entries.length) { alert(`There are no foods logged under ${mealName}.`); return; }
    const name = prompt(`Name this saved ${mealName.toLowerCase()} meal:`, `My ${mealName}`); if (!name?.trim()) return;
    const { data: saved, error } = await supabase.from('saved_meals').insert({user_id:user.id,name:name.trim()}).select('*').single();
    if(error){alert(error.message);return;}
    const items = entries.map(e => ({saved_meal_id:saved.id,user_id:user.id,food_name:e.food_name,serving:e.serving,fdc_id:e.fdc_id,source:e.source||'saved_meal',source_id:e.source_id||'',serving_amount:e.serving_amount||parseServingAmount(e.serving)||1,serving_unit:e.serving_unit||'serving',serving_grams:e.serving_grams||null,brand_name:e.brand_name||null,store_name:e.store_name||null,calories:e.calories,protein:e.protein,carbs:e.carbs,fat:e.fat}));
    const {error:itemError}=await supabase.from('saved_meal_items').insert(items); if(itemError){alert(itemError.message);return;}
    await renderSavedMeals(); alert(`${name.trim()} was saved.`);
  }

  async function saveFood() { openManualFoodModal(); }

  async function renderSelectedDateEntries(){ const list=$('[data-meal-list]'); if(!list)return; const entries=await getEntries(); await renderMeals(entries); }

  function csvEscape(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function downloadTextFile(filename, text, mime = 'text/csv;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function parseCsv(text) {
    const input = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (quoted) {
        if (char === '"') {
          if (input[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else {
          cell += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(cell); cell = '';
      } else if (char === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
      } else if (char === '\r') {
        if (input[i + 1] !== '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      } else {
        cell += char;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(v => String(v).trim() !== ''));
  }

  function normalizeCsvHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function buildCsvHeaderMap(headers) {
    const map = {};
    headers.forEach((header, index) => {
      const key = normalizeCsvHeader(header);
      if (key && map[key] === undefined) map[key] = index;
    });
    return map;
  }

  function csvValue(row, map, aliases) {
    for (const alias of aliases) {
      const index = map[normalizeCsvHeader(alias)];
      if (index !== undefined) return String(row[index] ?? '').trim();
    }
    return '';
  }

  function parseCsvNumber(value) {
    const cleaned = String(value || '').replace(/,/g, '').replace(/[^0-9.+-]/g, '');
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : 0;
  }

  function parseImportDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    let match = raw.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)/);
    if (match) {
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const d = new Date(year, month - 1, day);
      if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) return dateKey(d);
    }
    match = raw.match(/^([01]?\d)[\/-]([0-3]?\d)[\/-](\d{4})$/);
    if (match) {
      const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
      const d = new Date(year, month - 1, day);
      if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) return dateKey(d);
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : dateKey(parsed);
  }

  function canonicalImportMealName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  async function buildImportMealMap(importedNames) {
    await loadUserMeals();
    const map = new Map();
    const existingByName = new Map(userMeals.map(meal => [meal.name.trim().toLowerCase(), meal.name]));
    const aliases = {
      breakfast: 1,
      lunch: 2,
      dinner: 3,
      snack: 4,
      snacks: 4
    };

    for (const rawName of importedNames) {
      const original = canonicalImportMealName(rawName) || 'Meal 1';
      const key = original.toLowerCase();
      if (existingByName.has(key)) {
        map.set(original, existingByName.get(key));
        continue;
      }
      const aliasNumber = aliases[key];
      if (aliasNumber) {
        const aliasMeal = userMeals.find(meal => Number(meal.meal_number) === aliasNumber);
        if (aliasMeal) { map.set(original, aliasMeal.name); continue; }
        if (userMeals.length < aliasNumber) {
          const next = { user_id: user.id, meal_number: aliasNumber, name: original, sort_order: aliasNumber };
          const { data, error } = await supabase.from('meals').insert(next).select('id,user_id,meal_number,name,sort_order,created_at').single();
          if (!error && data) { userMeals.push(data); userMeals.sort((a,b)=>Number(a.meal_number)-Number(b.meal_number)); existingByName.set(key, data.name); map.set(original, data.name); continue; }
        }
      }
      if (userMeals.length >= 10) continue;
      const nextNumber = Math.max(0, ...userMeals.map(meal => Number(meal.meal_number))) + 1;
      const next = { user_id: user.id, meal_number: nextNumber, name: original.slice(0, 40), sort_order: nextNumber };
      const { data, error } = await supabase.from('meals').insert(next).select('id,user_id,meal_number,name,sort_order,created_at').single();
      if (error || !data) continue;
      userMeals.push(data);
      userMeals.sort((a,b)=>Number(a.meal_number)-Number(b.meal_number));
      existingByName.set(key, data.name);
      map.set(original, data.name);
    }
    return map;
  }

  function normalizeImportRow(row, map) {
    const date = parseImportDate(csvValue(row, map, ['Date', 'Logged Date', 'Log Date']));
    const meal = canonicalImportMealName(csvValue(row, map, ['Meal', 'Meal Name', 'Meal Type']));
    const food = csvValue(row, map, ['Food', 'Food Name', 'Name', 'Description']);
    const serving = csvValue(row, map, ['Serving', 'Serving Size', 'Quantity', 'Amount']) || '1 serving';
    if (!date || !food || /^(total|totals|daily total|exercise|food diary)$/i.test(food.trim())) return null;
    return {
      logged_date: date,
      imported_meal: meal || 'Meal 1',
      food_name: food.slice(0, 300),
      serving: serving.slice(0, 120),
      calories: Math.max(0, parseCsvNumber(csvValue(row, map, ['Calories', 'Energy']))),
      protein: Math.max(0, parseCsvNumber(csvValue(row, map, ['Protein', 'Protein (g)']))),
      carbs: Math.max(0, parseCsvNumber(csvValue(row, map, ['Carbohydrates', 'Carbs', 'Carbohydrate', 'Carbs (g)']))),
      fat: Math.max(0, parseCsvNumber(csvValue(row, map, ['Fat', 'Fat (g)', 'Total Fat']))),
      fdc_id: null
    };
  }

  function importRowKey(row) {
    return [row.logged_date, row.meal, row.food_name, row.serving, row.calories, row.protein, row.carbs, row.fat].map(v => String(v ?? '').trim().toLowerCase()).join('|');
  }

  async function importMealCsv(file) {
    const status = $('[data-import-status]');
    if (!file) return;
    status.textContent = 'Reading CSV…';
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error('The CSV does not contain any data rows.');
      const header = rows[0];
      const map = buildCsvHeaderMap(header);
      const hasFood = ['Food', 'Food Name', 'Name', 'Description'].some(key => map[normalizeCsvHeader(key)] !== undefined);
      const hasDate = ['Date', 'Logged Date', 'Log Date'].some(key => map[normalizeCsvHeader(key)] !== undefined);
      const hasCalories = ['Calories', 'Energy'].some(key => map[normalizeCsvHeader(key)] !== undefined);
      if (!hasFood || !hasDate || !hasCalories) throw new Error('This does not look like a nutrition CSV. Choose the MyFitnessPal “Your Nutrition” CSV or a MacroSync meal-history CSV.');

      const parsed = [];
      let skipped = 0;
      for (let i = 1; i < rows.length; i++) {
        const item = normalizeImportRow(rows[i], map);
        if (item) parsed.push(item); else skipped++;
      }
      if (!parsed.length) throw new Error('No importable food rows were found in the CSV.');
      if (parsed.length > 20000) throw new Error('This CSV contains more than 20,000 food rows. Split the export into smaller date ranges and import them separately.');

      const mealNames = [...new Set(parsed.map(item => item.imported_meal))];
      const mealMap = await buildImportMealMap(mealNames);
      const prepared = parsed.map(item => ({
        user_id: user.id,
        logged_date: item.logged_date,
        meal: mealMap.get(item.imported_meal) || null,
        food_name: item.food_name,
        serving: item.serving,
        fdc_id: item.fdc_id,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat
      })).filter(item => item.meal);
      if (!prepared.length) throw new Error('None of the imported meal names could be mapped to your available meals.');

      const skipDuplicates = true;
      let existingKeys = new Set();
      if (skipDuplicates) {
        const dates = prepared.map(r => r.logged_date).sort();
        const { data: existing, error: existingError } = await supabase.from('food_entries').select('logged_date,meal,food_name,serving,calories,protein,carbs,fat').eq('user_id', user.id).gte('logged_date', dates[0]).lte('logged_date', dates[dates.length - 1]);
        if (existingError) throw existingError;
        existingKeys = new Set((existing || []).map(importRowKey));
      }
      const uniquePrepared = prepared.filter(row => !existingKeys.has(importRowKey(row)));
      if (!uniquePrepared.length) {
        status.textContent = `Nothing imported. All ${prepared.length.toLocaleString()} rows already exist.`;
        return;
      }

      status.textContent = `Importing ${uniquePrepared.length.toLocaleString()} food rows…`;
      let imported = 0;
      for (let i = 0; i < uniquePrepared.length; i += 500) {
        const chunk = uniquePrepared.slice(i, i + 500);
        const { error } = await supabase.from('food_entries').insert(chunk);
        if (error) throw error;
        imported += chunk.length;
        status.textContent = `Imported ${imported.toLocaleString()} of ${uniquePrepared.length.toLocaleString()} rows…`;
      }
      await loadUserMeals();
      status.textContent = `Imported ${imported.toLocaleString()} food rows. ${skipped ? `${skipped.toLocaleString()} rows were skipped because they were not food entries. ` : ''}Exact duplicates were skipped.`;
      await renderPage();
    } catch (error) {
      console.error(error);
      status.textContent = error?.message || 'The CSV could not be imported.';
    }
  }

  async function exportMealHistoryCsv() {
    const status = $('[data-import-status]');
    status.textContent = 'Preparing your meal history…';
    try {
      const { data, error } = await supabase.from('food_entries').select('logged_date,meal,food_name,serving,calories,protein,carbs,fat,fdc_id,created_at').eq('user_id', user.id).order('logged_date', { ascending: true }).order('created_at', { ascending: true });
      if (error) throw error;
      const headers = ['Date','Meal','Food','Serving','Calories','Protein','Carbs','Fat','FDC ID','Logged At'];
      const lines = [headers.map(csvEscape).join(',')];
      for (const row of (data || [])) {
        lines.push([
          row.logged_date,
          row.meal,
          row.food_name,
          row.serving,
          row.calories,
          row.protein,
          row.carbs,
          row.fat,
          row.fdc_id ?? '',
          row.created_at ?? ''
        ].map(csvEscape).join(','));
      }
      const stamp = dateKey(new Date());
      downloadTextFile(`macrosync-meal-history-${stamp}.csv`, lines.join('\r\n'));
      status.textContent = `Exported ${(data || []).length.toLocaleString()} food rows.`;
    } catch (error) {
      console.error(error);
      status.textContent = error?.message || 'The meal history could not be exported.';
    }
  }

  const TRAINER_TYPES = ['General Fitness','Strength Training','Weight Training','Conditioning','Sports Performance','Mobility / Flexibility','Functional Training','Group Training','Beginner Training','Youth Training','Senior Fitness','Nutrition / Meal Planning','Other'];
  const TRAINER_TYPE_IDS = Object.fromEntries(TRAINER_TYPES.map((name,i)=>[name,i+1]));
  const TRAINER_TYPE_NAMES = Object.fromEntries(TRAINER_TYPES.map((name,i)=>[i+1,name]));
  const TRAINER_PRICES = {1:'Under $25/session',2:'$25–$49/session',3:'$50–$74/session',4:'$75–$99/session',5:'$100+/session',6:'Contact trainer'};

  function trainerWordCount(text) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

  function trainerPriceLabel(value){ return TRAINER_PRICES[value] || 'Price not specified'; }
  function socialUrl(kind,value){ if(!value)return null; const v=value.trim(); if(/^https?:\/\//i.test(v))return v; const bases={instagram:'https://www.instagram.com/',facebook:'https://www.facebook.com/',tiktok:'https://www.tiktok.com/@',youtube:'https://www.youtube.com/@'}; return bases[kind]?bases[kind]+v.replace(/^@/,''):null; }
  function renderTrainerCard(t){ const types=(t.training_types||[]).slice(0,4).map(x=>escapeHtml(TRAINER_TYPE_NAMES[x] || x)).join(' · '); return `<article class="trainer-card"><div class="trainer-card-top"><div><div class="profile-strip"><span class="avatar">${escapeHtml((t.display_name||'T').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(t.display_name||'Trainer')}</strong>${t.business_name?`<p>${escapeHtml(t.business_name)}</p>`:''}</span></div></div><span class="role-badge trainer">Personal Trainer ✓ Verified</span></div><div class="trainer-meta">${t.location?`<span>${escapeHtml(t.location)}</span>`:''}${t.years_experience!=null?`<span>${t.years_experience} years experience</span>`:''}${t.price_range?`<span>${escapeHtml(trainerPriceLabel(t.price_range))}</span>`:''}</div>${types?`<p class="trainer-types">${types}</p>`:''}${t.bio?`<p class="trainer-bio">${escapeHtml(t.bio)}</p>`:''}<button class="primary-button" type="button" data-view-trainer="${t.user_id}">View profile</button></article>`; }
  async function showTrainerProfile(id){ const {data,error}=await supabase.rpc('get_trainer_profile',{p_trainer_id:id}); if(error) throw error; const t=Array.isArray(data)?data[0]:data; if(!t) throw new Error('Trainer profile not found.'); const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.innerHTML=`<section class="modal-card trainer-detail-modal" role="dialog" aria-modal="true"><button class="modal-close" data-close-trainer type="button" aria-label="Close">×</button><p class="eyebrow">Personal trainer</p><h2>${escapeHtml(t.display_name)} <span class="verified-badge" title="Verified Trainer" aria-label="Verified Trainer">✓</span></h2>${t.business_name?`<p class="page-copy">${escapeHtml(t.business_name)}</p>`:''}<div class="trainer-meta">${t.location?`<span>${escapeHtml(t.location)}</span>`:''}${t.years_experience!=null?`<span>${t.years_experience} years experience</span>`:''}${t.price_range?`<span>${escapeHtml(trainerPriceLabel(t.price_range))}</span>`:''}</div>${t.training_types?.length?`<div class="trainer-detail-section"><h3>Training</h3><p>${t.training_types.map(x=>escapeHtml(TRAINER_TYPE_NAMES[x] || x)).join(' · ')}</p></div>`:''}${t.bio?`<div class="trainer-detail-section"><h3>About</h3><p>${escapeHtml(t.bio)}</p></div>`:''}${t.location?`<div class="trainer-detail-section"><h3>Based in</h3><p>${escapeHtml(t.location)}</p></div>`:''}${t.phone?`<div class="trainer-detail-section"><h3>Phone</h3><p>${escapeHtml(t.phone)}</p></div>`:''}<div class="trainer-detail-section"><h3>Contact & links</h3><div class="trainer-links">${['instagram','facebook','tiktok','youtube','website'].map(k=>{const u=socialUrl(k,t[k]);return u?`<a class="ghost-button" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${k[0].toUpperCase()+k.slice(1)}</a>`:''}).join('')}</div></div><div class="modal-actions"><button class="primary-button" type="button" data-trainer-connect="${t.user_id}">Connect with trainer</button></div><p class="settings-status" data-trainer-connect-status role="status"></p></section>`; document.body.appendChild(overlay); overlay.querySelector('[data-close-trainer]').onclick=()=>overlay.remove(); overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove()}); overlay.querySelector('[data-trainer-connect]').onclick=async()=>{const st=overlay.querySelector('[data-trainer-connect-status]'); st.textContent='Sending connection request…'; const {error}=await supabase.rpc('request_trainer_connection',{p_trainer_id:t.user_id}); if(error){st.textContent=error.code==='23505'?'A connection request already exists.':error.message;return;} st.textContent='Connection request sent. Once accepted, you can use MacroSync messaging and trainer/client sharing.';}; }
  async function renderTrainerSettings(){
    const form = $('[data-trainer-profile-form]');
    if (!form) return;
    const status = $('[data-trainer-settings-status]');
    const typesBox = $('[data-trainer-types]');
    const TRAINER_PROFILE_TYPES = [
      'General Fitness','Strength Training','Weight Training','Conditioning','Sports Performance',
      'Mobility / Flexibility','Functional Training','Group Training','Beginner Training','Youth Training',
      'Senior Fitness','Nutrition / Meal Planning','Other'
    ];
    const typeInputs = TRAINER_PROFILE_TYPES.map((name, index) => `<label class="trainer-type-choice"><input type="checkbox" value="${index+1}"><span>${escapeHtml(name)}</span></label>`).join('');
    if (typesBox) typesBox.innerHTML = typeInputs;

    const profileResult = await supabase.from('profiles').select('role,business_name').eq('id', user.id).single();
    if (profileResult.error) { if (status) status.textContent = profileResult.error.message; return; }
    if (profileResult.data?.role !== 'trainer') {
      form.innerHTML = '<div class="trainer-settings-notice"><p class="eyebrow">Trainer account required</p><h3>This page is for trainer accounts.</h3><p class="page-copy">Only accounts with the trainer role can create or manage a trainer profile.</p><a class="primary-button" href="settings.html">Back to Settings</a></div>';
      return;
    }

    const { data, error } = await supabase.from('trainer_profiles').select('bio,location,phone,instagram,facebook,tiktok,youtube,website,training_types,price_range,years_experience,is_public').eq('user_id', user.id).maybeSingle();
    if (error) { if (status) status.textContent = error.message; return; }
    const t = data || {};
    $('#trainerBusinessName').value = profileResult.data?.business_name || '';
    $('#trainerLocation').value = t.location || '';
    $('#trainerPhone').value = t.phone || '';
    $('#trainerYears').value = t.years_experience ?? '';
    $('#trainerBio').value = t.bio || '';
    $('#trainerPrice').value = t.price_range ?? '';
    $('#trainerWebsite').value = t.website || '';
    $('#trainerInstagram').value = t.instagram || '';
    $('#trainerFacebook').value = t.facebook || '';
    $('#trainerTikTok').value = t.tiktok || '';
    $('#trainerYoutube').value = t.youtube || '';
    $('#trainerIsPublic').checked = t.is_public === true;
    const selectedTypes = new Set((t.training_types || []).map(Number));
    typesBox?.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = selectedTypes.has(Number(input.value)); });

    const verificationSection = $('[data-trainer-verification-section]');
    const verificationForm = $('[data-trainer-verification-form]');
    const verificationStatus = $('[data-trainer-verification-status]');
    const verificationReview = $('[data-trainer-verification-review]');
    const verificationFormStatus = $('[data-trainer-verification-form-status]');
    if (verificationForm && verificationSection) {
      const { data: verification, error: verificationError } = await supabase
        .from('trainer_verifications')
        .select('status,requested_at,reviewed_at,reviewer_note,experience,credentials,credential_number,proof_url,instagram,facebook,tiktok,youtube,other_social,professional_background,statement')
        .eq('user_id', user.id)
        .maybeSingle();
      if (verificationError) {
        verificationFormStatus.textContent = verificationError.message;
      } else {
        const vStatus = verification?.status || 'none';
        const labels = { none:'Not requested', pending:'Pending review', approved:'Verified trainer', rejected:'Rejected', revoked:'Verification revoked' };
        if (verificationStatus) {
          verificationStatus.textContent = labels[vStatus] || 'Not requested';
          verificationStatus.dataset.status = vStatus;
        }
        if (verification?.reviewer_note && verificationReview) {
          verificationReview.hidden = false;
          verificationReview.innerHTML = `<p><strong>Review note</strong></p><p>${escapeHtml(verification.reviewer_note)}</p>`;
        }
        const setValue = (selector, value) => { const el = $(selector); if (el) el.value = value || ''; };
        setValue('#verificationExperience', verification?.experience);
        setValue('#verificationCredentials', verification?.credentials);
        setValue('#verificationCredentialNumber', verification?.credential_number);
        setValue('#verificationProofUrl', verification?.proof_url);
        setValue('#verificationInstagram', verification?.instagram);
        setValue('#verificationFacebook', verification?.facebook);
        setValue('#verificationTikTok', verification?.tiktok);
        setValue('#verificationYoutube', verification?.youtube);
        setValue('#verificationOtherSocial', verification?.other_social);
        setValue('#verificationBackground', verification?.professional_background);
        setValue('#verificationStatement', verification?.statement);

        const locked = vStatus === 'pending' || vStatus === 'approved';
        verificationForm.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = locked; });
        if (locked) {
          verificationFormStatus.textContent = vStatus === 'pending'
            ? 'Your verification request is awaiting administrator review.'
            : 'Your trainer account is verified.';
        }
      }

      const submitVerification = async event => {
        event.preventDefault();
        const experience = $('#verificationExperience').value.trim();
        const credentials = $('#verificationCredentials').value.trim();
        const credentialNumber = $('#verificationCredentialNumber').value.trim();
        const proofUrl = $('#verificationProofUrl').value.trim();
        const instagram = $('#verificationInstagram').value.trim();
        const facebook = $('#verificationFacebook').value.trim();
        const tiktok = $('#verificationTikTok').value.trim();
        const youtube = $('#verificationYoutube').value.trim();
        const otherSocial = $('#verificationOtherSocial').value.trim();
        const background = $('#verificationBackground').value.trim();
        const statement = $('#verificationStatement').value.trim();
        if (!experience || !credentials || !background || !statement) {
          verificationFormStatus.textContent = 'Please complete all required verification fields.';
          return;
        }
        if (proofUrl) {
          try { new URL(proofUrl); } catch (_) {
            verificationFormStatus.textContent = 'Please enter a valid verification link.';
            return;
          }
        }
        verificationFormStatus.textContent = 'Submitting verification request…';
        const { error } = await supabase.rpc('request_trainer_verification', {
          p_experience: experience,
          p_credentials: credentials,
          p_credential_number: credentialNumber || null,
          p_proof_url: proofUrl || null,
          p_instagram: instagram || null,
          p_facebook: facebook || null,
          p_tiktok: tiktok || null,
          p_youtube: youtube || null,
          p_other_social: otherSocial || null,
          p_professional_background: background,
          p_statement: statement
        });
        if (error) {
          verificationFormStatus.textContent = error.message;
          return;
        }
        if (verificationStatus) { verificationStatus.textContent = 'Pending review'; verificationStatus.dataset.status = 'pending'; }
        verificationForm.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
        verificationFormStatus.textContent = 'Verification request submitted. An administrator will review your information.';
        await trackEvent('trainer_verification_requested');
      };
      const verificationSubmitButton = $('[data-submit-trainer-verification]');
      verificationSubmitButton?.addEventListener('click', submitVerification);
    }

    const updateWordCount = () => {
      const words = $('#trainerBio').value.trim() ? $('#trainerBio').value.trim().split(/\s+/).length : 0;
      const counter = $('[data-bio-count]');
      if (counter) { counter.textContent = `${words} / 250 words`; counter.classList.toggle('over-limit', words > 250); }
      return words;
    };
    $('#trainerBio').addEventListener('input', updateWordCount);
    updateWordCount();

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const bio = $('#trainerBio').value.trim();
      const bioWords = bio ? bio.split(/\s+/).length : 0;
      if (bioWords > 250) { status.textContent = 'Your short description must be 250 words or fewer.'; $('#trainerBio').focus(); return; }
      const trainingTypes = [...typesBox.querySelectorAll('input:checked')].map(input => Number(input.value));
      status.textContent = 'Saving…';
      const { error: profileError } = await supabase.from('profiles').update({ business_name: $('#trainerBusinessName').value.trim() || null }).eq('id', user.id);
      if (profileError) { status.textContent = profileError.message; return; }
      const payload = {
        user_id: user.id,
        bio: bio || null,
        location: $('#trainerLocation').value.trim() || null,
        phone: $('#trainerPhone').value.trim() || null,
        instagram: $('#trainerInstagram').value.trim() || null,
        facebook: $('#trainerFacebook').value.trim() || null,
        tiktok: $('#trainerTikTok').value.trim() || null,
        youtube: $('#trainerYoutube').value.trim() || null,
        website: $('#trainerWebsite').value.trim() || null,
        training_types: trainingTypes,
        price_range: $('#trainerPrice').value ? Number($('#trainerPrice').value) : null,
        years_experience: $('#trainerYears').value === '' ? null : Number($('#trainerYears').value),
        is_public: $('#trainerIsPublic').checked,
        updated_at: new Date().toISOString()
      };
      const { error: saveError } = await supabase.from('trainer_profiles').upsert(payload, { onConflict: 'user_id' });
      if (saveError) { status.textContent = saveError.message; return; }
      status.textContent = 'Trainer profile saved.';
    });
  }

  async function renderTrainers(){ const list=$('#trainerList'); if(!list)return; const run=async()=>{list.innerHTML='<p class="page-copy">Searching…</p>'; const {data,error}=await supabase.rpc('search_trainers',{p_query:$('#trainerSearch').value.trim(),p_training_type:$('#trainerType').value?Number($('#trainerType').value):null,p_price_range:$('#trainerPrice').value?Number($('#trainerPrice').value):null}); if(error)throw error; list.innerHTML=data?.length?data.map(renderTrainerCard).join(''):'<p class="page-copy">No public trainers matched your search.</p>'; list.querySelectorAll('[data-view-trainer]').forEach(b=>b.onclick=()=>showTrainerProfile(b.dataset.viewTrainer).catch(e=>alert(e.message)));}; $('#trainerSearchButton').onclick=()=>run().catch(e=>{list.innerHTML=`<p class="settings-status">${escapeHtml(e.message)}</p>`}); $('#trainerSearch').onkeydown=e=>{if(e.key==='Enter')run().catch(console.error)}; await run(); }

  async function renderSettings(){
    const nameInput = $('#settingsDisplayName');
    const emailInput = $('#settingsEmail');
    const roleText = $('#settingsRole');
    const status = $('[data-settings-status]');
    const feedbackStatus = $('[data-feedback-status]');
    const importInput = $('[data-import-csv]');
    $('[data-import-mfp]')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (file) await importMealCsv(file);
      importInput.value = '';
    });
    $('[data-export-meals]')?.addEventListener('click', exportMealHistoryCsv);
    const { data: profile, error } = await supabase.from('profiles').select('display_name,email,role,business_name,is_admin').eq('id', user.id).single();
    if (error) { if (status) status.textContent = error.message; return; }
    if (nameInput) nameInput.value = profile?.display_name || user.user_metadata?.display_name || '';
    if (emailInput) emailInput.value = user.email || profile?.email || '';
    if (roleText) roleText.textContent = profile?.is_admin ? 'Administrator' : (profile?.role === 'trainer' ? `Personal trainer${profile?.business_name ? ` · ${profile.business_name}` : ''}` : 'Normal user');
    setText('[data-app-version]', `MacroSync v${MACROSYNC_VERSION}`);

    $('[data-settings-profile-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const displayName = nameInput.value.trim();
      const displayNameValidation = validateDisplayName(displayName);
      if (displayNameValidation) { status.textContent = displayNameValidation; return; }
      status.textContent = 'Saving…';
      const { error: profileError } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
      if (profileError) { status.textContent = profileError.message; return; }
      const { error: authError } = await supabase.auth.updateUser({ data: { display_name: displayName } });
      if (authError) { status.textContent = authError.message; return; }
      user.user_metadata = { ...(user.user_metadata || {}), display_name: displayName };
      await supabase.from('moderation_flags').update({ status:'resolved', resolved_at:new Date().toISOString() }).eq('user_id', user.id).eq('content_type','display_name').eq('status','open');
      status.textContent = 'Display name updated.';
    });

    $('[data-settings-password-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const password = $('#settingsPassword').value;
      const confirm = $('#settingsPasswordConfirm').value;
      if (password.length < 8) { status.textContent = 'Password must be at least 8 characters.'; return; }
      if (password !== confirm) { status.textContent = 'The passwords do not match.'; return; }
      status.textContent = 'Updating password…';
      const { error: passwordError } = await supabase.auth.updateUser({ password });
      if (passwordError) { status.textContent = passwordError.message; return; }
      $('#settingsPassword').value = '';
      $('#settingsPasswordConfirm').value = '';
      status.textContent = 'Password updated successfully.';
    });

    $('[data-settings-email-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const newEmail = emailInput.value.trim();
      if (!newEmail) { status.textContent = 'Enter an email address.'; return; }
      if (newEmail === user.email) { status.textContent = 'That is already your current email.'; return; }
      status.textContent = 'Updating email…';
      const { error: emailError } = await supabase.auth.updateUser({ email: newEmail });
      if (emailError) { status.textContent = emailError.message; return; }
      await supabase.from('profiles').update({ email: newEmail }).eq('id', user.id);
      status.textContent = 'Email change requested. Check your inbox for any confirmation link.';
    });

    $('[data-feedback-form]')?.addEventListener('submit', async event => {
      event.preventDefault();
      const category = $('#feedbackCategory').value;
      const message = $('#feedbackMessage').value.trim();
      const feedbackValidation = validateMessageText(message);
      if (feedbackValidation) { feedbackStatus.textContent = feedbackValidation; return; }
      feedbackStatus.textContent = 'Sending feedback…';
      const { error: feedbackError } = await supabase.from('feedback').insert({ user_id: user.id, category, message, app_version: MACROSYNC_VERSION, page_path: location.pathname, user_agent: navigator.userAgent.slice(0, 500) });
      if (feedbackError) { feedbackStatus.textContent = feedbackError.message; return; }
      await trackEvent('feedback_submitted', { category });
      $('#feedbackMessage').value = '';
      feedbackStatus.textContent = 'Thanks! Your feedback was submitted.';
    });

    const isAdmin = profile?.is_admin === true;
    $$('[data-admin-only]').forEach(el => { el.hidden = !isAdmin; });
    const limitedMinor = isLimitedMinorProfile(profile);
    if (limitedMinor) {
      $$('a[href="social.html"], a[href="friends-add.html"], a[href="friends-messages.html"], a[href="friends-meals.html"], a[href="trainers.html"], a[href="goals.html"], a[href="progress.html"], a[href="recipes.html"], a[href="account.html"], a[href="settings.html"]').forEach(el => { el.hidden = true; });
      $$('[data-mobile-nav] a').forEach(el => { if (!['log_food.html','log.html'].includes(el.getAttribute('href'))) el.hidden = true; });
      $$('[data-mobile-menu] a').forEach(el => { if (!['log_food.html','log.html'].includes(el.getAttribute('href'))) el.hidden = true; });
    }
    const emailSearchToggle = $('[data-email-search-enabled]');
    if (emailSearchToggle) emailSearchToggle.checked = profile?.email_search_enabled !== false;
    emailSearchToggle?.addEventListener('change', async () => {
      const { error } = await supabase.from('profiles').update({ email_search_enabled: emailSearchToggle.checked }).eq('id', user.id);
      if (error) { emailSearchToggle.checked = !emailSearchToggle.checked; alert(error.message); }
    });
    $('[data-delete-account]')?.addEventListener('click', async () => {
      if (!confirm('Delete your MacroSync account and all of its application data permanently? This cannot be undone.')) return;
      const ds = $('[data-delete-account-status]'); if (ds) ds.textContent = 'Deleting account…';
      const { data, error } = await supabase.rpc('delete_my_account');
      if (error) { if (ds) ds.textContent = error.message; return; }
      await supabase.auth.signOut();
      window.location.href = 'auth.html';
    });
    const tabs = $$('[data-settings-tab]');
    const sections = $$('[data-settings-section]');
    const showTab = async tab => {
      if (tab === 'feedback-inbox' && !isAdmin) return;
      tabs.forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tab));
      sections.forEach(sec => { sec.hidden = sec.dataset.settingsSection !== tab; });
      if (tab === 'feedback-inbox') await loadFeedbackInbox();
    };
    tabs.forEach(b => b.onclick = () => showTab(b.dataset.settingsTab));

    async function loadFeedbackInbox(){
      const box = $('[data-feedback-inbox]'); const inboxStatus = $('[data-feedback-inbox-status]');
      if (!box) return; inboxStatus.textContent = 'Loading feedback…';
      const { data, error } = await supabase.from('feedback').select('id,user_id,category,message,created_at,read_at,profiles!feedback_user_id_profiles_fkey(display_name,email)').order('created_at',{ascending:false});
      if (error) { inboxStatus.textContent = error.message; return; }
      const unread = (data||[]).filter(x => !x.read_at).length;
      $$('[data-feedback-unread-count]').forEach(b => { b.hidden = unread === 0; b.textContent = unread; });
      box.innerHTML = (data||[]).length ? data.map(item => `
        <article class="feedback-item ${item.read_at ? '' : 'unread'}" data-feedback-id="${item.id}">
          <div class="feedback-item-head"><strong>${escapeHtml(item.category)}</strong><span>${new Date(item.created_at).toLocaleString()}</span></div>
          <div class="feedback-author">${escapeHtml(item.profiles?.display_name || 'Unknown user')} · ${escapeHtml(item.profiles?.email || '')}</div>
          <p>${escapeHtml(item.message)}</p>
          <div class="feedback-actions"><button class="ghost-button" type="button" data-mark-feedback-read="${item.id}" ${item.read_at ? 'disabled' : ''}>Mark as read</button><button class="ghost-button danger-button" type="button" data-delete-feedback="${item.id}">Delete</button></div>
        </article>`).join('') : '<p class="empty-state">No feedback has been submitted yet.</p>';
      inboxStatus.textContent = '';
      box.querySelectorAll('[data-mark-feedback-read]').forEach(b => b.onclick = async () => { await supabase.from('feedback').update({read_at:new Date().toISOString()}).eq('id',b.dataset.markFeedbackRead); await loadFeedbackInbox(); });
      box.querySelectorAll('[data-delete-feedback]').forEach(b => b.onclick = async () => { if (!confirm('Delete this feedback permanently?')) return; const {error}=await supabase.from('feedback').delete().eq('id',b.dataset.deleteFeedback); if(error) { inboxStatus.textContent=error.message; return; } await loadFeedbackInbox(); });
    }
    $('[data-refresh-feedback]')?.addEventListener('click', loadFeedbackInbox);
    if (isAdmin) {
      const { count } = await supabase.from('feedback').select('*',{count:'exact',head:true}).is('read_at',null);
      $$('[data-feedback-unread-count]').forEach(b => { b.hidden = !(count||0); b.textContent = count||0; });
    }
  }

  async function renderAccount(){
    const {data:profile,error}=await supabase.from('profiles').select('*').eq('id',user.id).single();
    if(error) throw error;
    $('#accountName').value=profile?.display_name || '';
    $('#businessName').value=profile?.business_name || '';
    const roleControls=$$('.account-type button');
    roleControls.forEach(btn=>{
      btn.classList.toggle('active',btn.dataset.accountRole===profile?.role);
      btn.onclick=()=>{ roleControls.forEach(b=>b.classList.remove('active')); btn.classList.add('active'); $('#businessName').closest('[data-business-field]').hidden=btn.dataset.accountRole!=='trainer'; };
    });
    $('[data-business-field]').hidden=profile?.role!=='trainer';
    const button=$('[data-add-account]');
    if(button) button.onclick=async()=>{
      const name=$('#accountName').value.trim()||'MacroSync User';
      const role=$('.account-type button.active')?.dataset.accountRole || 'user';
      const business=role==='trainer' ? $('#businessName').value.trim() || null : null;
      const {error}=await supabase.from('profiles').update({display_name:name,role,business_name:business}).eq('id',user.id);
      const old=button.parentElement.querySelector('.save-status'); old?.remove();
      const status=document.createElement('p'); status.className='save-status'; status.textContent=error?error.message:'Profile saved.'; button.parentElement.appendChild(status);
    };
    const list=$('[data-account-list]');
    if(list) list.innerHTML=`<div class="account-card selected"><div class="account-top"><div class="profile-strip"><span class="avatar">${escapeHtml((profile?.display_name||'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(profile?.display_name||'MacroSync User')}</strong><p>${profile?.role==='trainer'?'Personal trainer':'Normal user'}${profile?.business_name?' · '+escapeHtml(profile.business_name):''}</p></span></div><span class="role-badge">${profile?.is_admin?'Administrator':profile?.role==='trainer'?'Trainer':'Alpha'}</span></div></div>`;
  }

  async function renderGoals(){
    const goals=await getGoals();
    const {data:profile}=await supabase.from('profiles').select('primary_goal').eq('id',user.id).single();
    $('#calgoal').value=goals.calorie_goal; $('#proteinGoal').value=goals.protein_goal; $('#carbsGoal').value=goals.carbs_goal; $('#fatGoal').value=goals.fat_goal; $('#currentWeight').value=goals.current_weight ?? ''; $('#goalWeight').value=goals.goal_weight ?? '';
    const legacyGoal={lose:'lose_basic',gain:'gain_basic',maintain:'maintain'}[profile?.primary_goal] || profile?.primary_goal; $('#primaryGoal').value=GOAL_BY_VALUE[legacyGoal] ? legacyGoal : 'maintain';
    $('[data-current-weight]').textContent=goals.current_weight ? moneyless(goals.current_weight) : '—'; $('[data-goal-weight]').textContent=goals.goal_weight ? moneyless(goals.goal_weight) : '—';
    const status=$('[data-auto-macro-status]'), button=$('[data-auto-calculate]'), lowCarb=$('[data-low-carb]'), details=$('[data-goal-details]');
    if(lowCarb) lowCarb.querySelector('input').checked=Boolean(goals.low_carb);
    const sync=()=>{const goal=GOAL_BY_VALUE[$('#primaryGoal').value]; lowCarb.hidden=goal?.value!=='recomp'; details.innerHTML=goal?`<strong>${escapeHtml(goal.label)}</strong><p>${escapeHtml(goal.adjustment)}</p>${goal.value==='recomp'&&lowCarb.querySelector('input')?.checked?'<p><strong>Low-carb:</strong> 40 g carbs/day; fat fills the remaining calories.</p>':''}`:'';};
    $('#primaryGoal').addEventListener('change',sync); lowCarb.querySelector('input')?.addEventListener('change',sync); sync();
    button.addEventListener('click',()=>{const targets=calculateAutoMacroTargets(Number($('#currentWeight').value),$('#primaryGoal').value,Boolean(lowCarb.querySelector('input')?.checked));if(!targets){status.textContent='Select a goal and enter a valid current weight first.';return;}$('#calgoal').value=targets.calorie_goal;$('#proteinGoal').value=targets.protein_goal;$('#carbsGoal').value=targets.carbs_goal;$('#fatGoal').value=targets.fat_goal;status.textContent='Starting targets calculated. You can adjust them before saving.';});
    const save=$('.two-column-grid .panel .primary-button');
    if(save) save.onclick=async()=>{const payload={user_id:user.id,calorie_goal:Number($('#calgoal').value)||2050,protein_goal:Number($('#proteinGoal').value)||0,carbs_goal:Number($('#carbsGoal').value)||0,fat_goal:Number($('#fatGoal').value)||0,current_weight:Number($('#currentWeight').value)||null,goal_weight:Number($('#goalWeight').value)||null,low_carb:Boolean(lowCarb.querySelector('input')?.checked)};const {error}=await supabase.from('nutrition_goals').upsert(payload);if(!error) await supabase.from('profiles').update({primary_goal:$('#primaryGoal').value}).eq('id',user.id);save.parentElement.querySelector('.save-status')?.remove();const msg=document.createElement('p');msg.className='save-status';msg.textContent=error?error.message:'Goals saved.';save.parentElement.appendChild(msg);if(!error){$('[data-current-weight]').textContent=payload.current_weight?moneyless(payload.current_weight):'—';$('[data-goal-weight]').textContent=payload.goal_weight?moneyless(payload.goal_weight):'—';};};
  }

  async function renderProgress(){
    const { data: dailySummaries, error: entryError } = await supabase.from('daily_nutrition_summaries').select('logged_date').eq('user_id', user.id).order('logged_date', {ascending:true});
    if(entryError) throw entryError;
    const dates=[...new Set((dailySummaries||[]).map(e=>e.logged_date).filter(Boolean))].sort();
    const dateSet=new Set(dates);
    let current=0, longest=0, run=0, previous=null;
    for(const d of dates){
      const cur=new Date(`${d}T00:00:00`);
      if(previous && Math.round((cur-previous)/86400000)===1) run++; else run=1;
      current=run; longest=Math.max(longest,run); previous=cur;
    }
    setText('[data-current-streak]', current);
    setText('[data-longest-streak]', longest);
    setText('[data-days-logged]', dates.length);
    renderActivity(dates, dateSet);

    const {data:weights,error:weightError}=await supabase.from('weight_logs').select('*').eq('user_id',user.id).order('logged_date',{ascending:true}).order('created_at',{ascending:true});
    if(weightError) throw weightError;
    renderWeightProgress(weights||[]);

    const {data:measurements,error:measurementError}=await supabase.from('body_measurements').select('*').eq('user_id',user.id).order('logged_date',{ascending:false}).order('created_at',{ascending:false});
    if(measurementError) throw measurementError;
    renderMeasurements(measurements||[]);

    $('[data-add-weight]')?.addEventListener('click', openWeightModal);
    $('[data-add-measurement]')?.addEventListener('click', openMeasurementModal);
  }

  function renderActivity(dates,dateSet){
    const grid=$('[data-activity-grid]'); if(!grid) return;
    const today=new Date(); today.setHours(0,0,0,0);
    const start=addDays(today,-27);
    const days=[];
    for(let i=0;i<28;i++){const d=addDays(start,i);const key=dateKey(d);days.push(`<div class="activity-day ${dateSet.has(key)?'logged':''}" title="${d.toLocaleDateString(undefined,{month:'short',day:'numeric'})}"><span></span><small>${d.getDate()}</small></div>`);}
    grid.innerHTML=days.join('');
  }

  function renderWeightProgress(weights){
    const chart=$('[data-weight-chart]');
    if(!weights.length){
      setText('[data-current-progress-weight]','—'); setText('[data-weight-change]','Log a weight to start your history.'); setText('[data-start-weight]','—'); setText('[data-weight-change-total]','—'); setText('[data-lowest-weight]','—');
      if(chart) chart.innerHTML='<p class="page-copy">No weight history yet. Log your first weight above.</p>';
      return;
    }
    const first=Number(weights[0].weight), last=Number(weights[weights.length-1].weight), lowest=Math.min(...weights.map(w=>Number(w.weight))), change=last-first;
    setText('[data-current-progress-weight]',`${moneyless(last)} lb`); setText('[data-weight-change]',`${change===0?'No change':`${change>0?'+':''}${moneyless(change)} lb`} since first logged weight.`); setText('[data-start-weight]',`${moneyless(first)} lb`); setText('[data-weight-change-total]',`${change>0?'+':''}${moneyless(change)} lb`); setText('[data-lowest-weight]',`${moneyless(lowest)} lb`);
    if(!chart) return;
    const width=760,height=260,pad=38,vals=weights.map(w=>Number(w.weight)),min=Math.min(...vals),max=Math.max(...vals),range=Math.max(max-min,1);
    const points=weights.map((w,i)=>{const x=pad+(i/(Math.max(weights.length-1,1)))*(width-pad*2);const y=pad+((max-Number(w.weight))/range)*(height-pad*2);return {x,y,w};});
    const poly=points.map(p=>`${p.x},${p.y}`).join(' ');
    chart.innerHTML=`<svg class="weight-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weight history"><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" class="chart-axis"/><polyline points="${poly}" class="weight-line" fill="none"/>${points.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" class="weight-point"><title>${moneyless(p.w.weight)} lb · ${p.w.logged_date}</title></circle>`).join('')}<text x="${pad}" y="${height-8}" class="chart-label">${weights[0].logged_date}</text><text x="${width-pad}" y="${height-8}" text-anchor="end" class="chart-label">${weights[weights.length-1].logged_date}</text><text x="${pad}" y="18" class="chart-label">${moneyless(max)} lb</text><text x="${pad}" y="${height-28}" class="chart-label">${moneyless(min)} lb</text></svg>`;
    const history=$('[data-weight-history]'); if(history) { history.innerHTML=weights.slice().reverse().map(w=>`<div class="history-row"><div><strong>${moneyless(w.weight)} lb</strong><span>${w.logged_date}</span></div><button class="text-button danger-button" type="button" data-delete-weight="${w.id}">Delete</button></div>`).join(''); history.querySelectorAll('[data-delete-weight]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this weight entry permanently?'))return;const {error}=await supabase.from('weight_logs').delete().eq('id',b.dataset.deleteWeight).eq('user_id',user.id);if(error)return alert(error.message);await renderProgress();}); }
  }

  function renderMeasurements(rows){
    const list=$('[data-measurement-list]'); if(!list) return;
    const latest=new Map(); rows.forEach(r=>{if(!latest.has(r.measurement_type)) latest.set(r.measurement_type,r);});
    const order=['Waist','Hips','Chest','Left arm','Right arm','Left thigh','Right thigh','Neck'];
    const keys=[...order.filter(k=>latest.has(k)),...Array.from(latest.keys()).filter(k=>!order.includes(k))];
    list.innerHTML=keys.length?keys.map(k=>{const r=latest.get(k);return `<article class="measurement-card"><div><strong>${escapeHtml(k)}</strong><span>${moneyless(r.value)} ${r.unit}</span></div><small>${r.logged_date}</small><div class="measurement-actions"><button type="button" class="text-button" data-measurement-history="${escapeHtml(k)}">History</button><button type="button" class="text-button danger-button" data-delete-measurement="${r.id}">Delete latest</button></div></article>`}).join(''):'<p class="page-copy">No measurements logged yet.</p>';
    list.querySelectorAll('[data-measurement-history]').forEach(b=>b.onclick=()=>showMeasurementHistory(b.dataset.measurementHistory,rows)); list.querySelectorAll('[data-delete-measurement]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this measurement entry permanently?'))return;const {error}=await supabase.from('body_measurements').delete().eq('id',b.dataset.deleteMeasurement).eq('user_id',user.id);if(error)return alert(error.message);await renderProgress();});
  }

  function openWeightModal(){
    const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Weight</p><h2>Log weight</h2><div class="field"><label>Weight (lb)</label><input id="progressWeightInput" type="number" min="1" step="0.1" autofocus></div><div class="field"><label>Date</label><input id="progressWeightDate" type="date" value="${dateKey(new Date())}"></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-weight type="button">Save</button></div></section>`; document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove()); overlay.querySelector('[data-save-weight]').onclick=async()=>{const weight=Number(overlay.querySelector('#progressWeightInput').value),logged_date=overlay.querySelector('#progressWeightDate').value;if(!weight||!logged_date)return alert('Enter a valid weight and date.');const {error}=await supabase.from('weight_logs').insert({user_id:user.id,weight,logged_date});if(error)return alert(error.message);overlay.remove();await renderProgress();};
  }

  function openMeasurementModal(){
    const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Measurements</p><h2>Add measurement</h2><div class="form-grid"><div class="field"><label>Measurement</label><select id="measurementType"><option>Waist</option><option>Hips</option><option>Chest</option><option>Left arm</option><option>Right arm</option><option>Left thigh</option><option>Right thigh</option><option>Neck</option><option>Custom</option></select></div><div class="field"><label>Value</label><input id="measurementValue" type="number" min="0.1" step="0.1"></div><div class="field"><label>Unit</label><select id="measurementUnit"><option value="in">inches</option><option value="cm">centimeters</option></select></div><div class="field"><label>Date</label><input id="measurementDate" type="date" value="${dateKey(new Date())}"></div></div><div class="field" id="customMeasurementWrap" hidden><label>Custom name</label><input id="customMeasurementName" maxlength="40"></div><div class="modal-actions"><button class="ghost-button" data-close type="button">Cancel</button><button class="primary-button" data-save-measurement type="button">Save</button></div></section>`; document.body.appendChild(overlay); overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove()); const type=overlay.querySelector('#measurementType'), custom=overlay.querySelector('#customMeasurementWrap'); type.onchange=()=>custom.hidden=type.value!=='Custom'; overlay.querySelector('[data-save-measurement]').onclick=async()=>{const measurement_type=type.value==='Custom'?overlay.querySelector('#customMeasurementName').value.trim():type.value;const value=Number(overlay.querySelector('#measurementValue').value),unit=overlay.querySelector('#measurementUnit').value,logged_date=overlay.querySelector('#measurementDate').value;if(!measurement_type||!value||!logged_date)return alert('Complete the measurement fields.');const {error}=await supabase.from('body_measurements').insert({user_id:user.id,measurement_type,value,unit,logged_date});if(error)return alert(error.message);overlay.remove();await renderProgress();};
  }

  function showMeasurementHistory(name,rows){
    const history=rows.filter(r=>r.measurement_type===name).sort((a,b)=>String(b.logged_date).localeCompare(String(a.logged_date))); const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close type="button">×</button><p class="eyebrow">Measurement history</p><h2>${escapeHtml(name)}</h2><div class="history-list">${history.map(r=>`<div class="history-row"><div><strong>${moneyless(r.value)} ${r.unit}</strong><span>${r.logged_date}</span></div><button class="text-button danger-button" type="button" data-delete-history-measurement="${r.id}">Delete</button></div>`).join('')}</div></section>`;document.body.appendChild(overlay);overlay.querySelector('[data-close]').onclick=()=>overlay.remove(); overlay.querySelectorAll('[data-delete-history-measurement]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this measurement entry permanently?'))return;const {error}=await supabase.from('body_measurements').delete().eq('id',b.dataset.deleteHistoryMeasurement).eq('user_id',user.id);if(error)return alert(error.message);overlay.remove();await renderProgress();});
  }

  async function renderRecipes(){
    const list = $('[data-recipe-list]');
    const builder = $('[data-recipe-builder]');
    if (!list || !builder) return;
    let editingRecipeId = null;
    const resetRecipeEditor = () => { editingRecipeId=null; builder.querySelector('[data-save-recipe]').textContent='Save Recipe'; builder.querySelector('[data-recipe-name]').value=''; builder.querySelector('[data-recipe-servings]').value='1'; builder.querySelector('[data-recipe-public]').checked=false; ingredients=[]; drawIngredients(); };
    const beginRecipeEdit = (recipe) => { editingRecipeId=recipe.id; builder.querySelector('[data-save-recipe]').textContent='Update Recipe'; builder.querySelector('[data-recipe-name]').value=recipe.name; builder.querySelector('[data-recipe-servings]').value=recipe.servings; builder.querySelector('[data-recipe-public]').checked=Boolean(recipe.is_public); ingredients=(recipe.recipe_items||[]).map(i=>({name:i.food_name,amount:Number(String(i.serving||'1').split(' ')[0])||1,unit:String(i.serving||'serving').split(' ').slice(1).join(' ')||'serving',fdc_id:i.fdc_id,calories:Number(i.calories||0),protein:Number(i.protein||0),carbs:Number(i.carbs||0),fat:Number(i.fat||0),sourceLabel:'Saved ingredient'})); drawIngredients(); builder.scrollIntoView({behavior:'smooth',block:'start'}); };
    await loadRecipes(list, beginRecipeEdit);
    const personalSearch = builder.querySelector('[data-recipe-personal-search]');
    const personalResults = builder.querySelector('[data-recipe-personal-results]');
    const communitySearch = builder.querySelector('[data-recipe-community-search]');
    const communityResults = builder.querySelector('[data-recipe-community-results]');
    const referenceSearch = builder.querySelector('[data-recipe-reference-search]');
    const referenceResults = builder.querySelector('[data-recipe-reference-results]');
    const ingredientList = builder.querySelector('[data-recipe-ingredients]');
    let ingredients = [];

    const drawIngredients = () => {
      ingredientList.innerHTML = ingredients.length
        ? ingredients.map((item,index)=>`<div class="recipe-ingredient-row"><div><strong>${escapeHtml(item.name)}</strong><small>${moneyless(item.amount)} ${escapeHtml(item.unit)} · ${escapeHtml(item.sourceLabel || 'Food database')}</small></div><span>${moneyless(item.calories)} cal</span><button type="button" class="text-button" data-remove-ingredient="${index}">Remove</button></div>`).join('')
        : '<p class="page-copy">Add ingredients to build your recipe.</p>';
      ingredientList.querySelectorAll('[data-remove-ingredient]').forEach(b=>b.onclick=()=>{ingredients.splice(Number(b.dataset.removeIngredient),1);drawIngredients();});
      const totals=ingredients.reduce((a,i)=>({calories:a.calories+i.calories,protein:a.protein+i.protein,carbs:a.carbs+i.carbs,fat:a.fat+i.fat}),{calories:0,protein:0,carbs:0,fat:0});
      builder.querySelector('[data-recipe-totals]').innerHTML=`<div><strong>${moneyless(totals.calories)}</strong><span>Calories</span></div><div><strong>${moneyless(totals.protein)}g</strong><span>Protein</span></div><div><strong>${moneyless(totals.carbs)}g</strong><span>Carbs</span></div><div><strong>${moneyless(totals.fat)}g</strong><span>Fat</span></div>`;
    };

    const addFoodToRecipe = (food, sourceLabel) => {
      const n=food.nutrients||{};
      const amount=Number(food.servingSize||100);
      const unit=food.servingUnit||'g';
      const defaultText = food.householdServing || `${moneyless(amount)} ${unit}`;
      const raw=prompt(`How many ${unit} of ${food.name}?\\nDefault serving: ${defaultText}`, amount);
      const qty=Number(raw);
      if(!Number.isFinite(qty)||qty<=0)return;

      let factor;
      if(food.source === 'personal'){
        // Personal-food nutrition is stored for the creator's default serving,
        // so scale by the number of default servings rather than treating it as /100g.
        factor = qty / amount;
      } else {
        factor = String(unit).toLowerCase().includes('g') ? qty/100 : qty*amount/100;
      }

      ingredients.push({
        name:food.name,
        amount:qty,
        unit,
        fdc_id:/^\\d+$/.test(String(food.id))?Number(food.id):null,
        calories:Number(n.calories||0)*factor,
        protein:Number(n.protein||0)*factor,
        carbs:Number(n.carbs||0)*factor,
        fat:Number(n.fat||0)*factor,
        sourceLabel
      });
      drawIngredients();
    };

    const renderFoodResults = (box, foods, emptyText='No foods found.') => {
      box.innerHTML = foods.length
        ? foods.slice(0,12).map((f,i)=>`<button type="button" class="food-db-card" data-recipe-result-index="${i}"><strong>${escapeHtml(f.name)}</strong><p>${escapeHtml(f.brand||f.dataType||f.source||'Food database')}</p>${f.householdServing?`<small>${escapeHtml(f.householdServing)}</small>`:''}</button>`).join('')
        : `<p class="page-copy">${emptyText}</p>`;
      box.querySelectorAll('[data-recipe-result-index]').forEach(b=>b.onclick=()=>addFoodToRecipe(foods[Number(b.dataset.recipeResultIndex)], foods[Number(b.dataset.recipeResultIndex)]?.sourceLabel || foods[Number(b.dataset.recipeResultIndex)]?.dataType || 'Food database'));
    };

    drawIngredients();

    let personalTimer;
    personalSearch?.addEventListener('input',()=>{
      clearTimeout(personalTimer);
      personalTimer=setTimeout(async()=>{
        const q=personalSearch.value.trim();
        if(q.length<2){personalResults.innerHTML='';return;}
        personalResults.innerHTML='<p class="page-copy">Searching your Personal Foods…</p>';
        const {data,error}=await supabase.from('user_foods').select('*').eq('user_id',user.id).ilike('name',`%${q}%`).order('name').limit(20);
        if(error){personalResults.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
        const foods=(data||[]).map(f=>({
          id:`personal-${f.id}`,
          name:f.name,
          brand:'My Personal Foods',
          dataType:'Personal Food',
          servingSize:Number(f.serving_amount||1),
          servingUnit:f.serving_unit||'serving',
          householdServing:`${moneyless(Number(f.serving_amount||1))} ${f.serving_unit||'serving'}`,
          nutrients:{
            calories:Number(f.calories||0),
            protein:Number(f.protein||0),
            carbs:Number(f.carbs||0),
            fat:Number(f.fat||0)
          },
          source:'personal',
          sourceLabel:'Personal Food',
          personalServingAmount:Number(f.serving_amount||1),
          personalServingUnit:f.serving_unit||'serving'
        }));
        renderFoodResults(personalResults,foods,'No matching Personal Foods found.');
      },300);
    });

    let communityTimer;
    communitySearch?.addEventListener('input',()=>{
      clearTimeout(communityTimer);
      communityTimer=setTimeout(async()=>{
        const q=communitySearch.value.trim();
        if(q.length<2){communityResults.innerHTML='';return;}
        communityResults.innerHTML='<p class="page-copy">Searching Community Foods…</p>';
        const {data,error}=await supabase.from('community_foods').select('*').eq('is_public',true).ilike('name',`%${q}%`).order('name').limit(20);
        if(error){communityResults.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
        const foods=(data||[]).map(f=>({id:`community-${f.id}`,name:f.name,brand:'MacroSync Community Foods',dataType:'Community Food',servingSize:Number(f.serving_options?.[0]?.amount||f.serving_grams||100),servingUnit:f.serving_options?.[0]?.unit||'g',householdServing:f.serving_options?.[0]?.amount?`${f.serving_options[0].amount} ${f.serving_options[0].unit||''}`:'',nutrients:{calories:Number(f.calories_per_100g||0),protein:Number(f.protein_per_100g||0),carbs:Number(f.carbs_per_100g||0),fat:Number(f.fat_per_100g||0)},source:'community'}));
        foods.forEach(f=>f.sourceLabel='Community Food'); renderFoodResults(communityResults,foods,'No published Community Foods found.');
      },300);
    });

    let referenceTimer;
    referenceSearch?.addEventListener('input',()=>{
      clearTimeout(referenceTimer);
      referenceTimer=setTimeout(async()=>{
        const q=referenceSearch.value.trim();
        if(q.length<2){referenceResults.innerHTML='';return;}
        referenceResults.innerHTML='<p class="page-copy">Searching USDA, Canada CNF, UK CoFID, and Open Food Facts…</p>';
        try {
          const endpoints=[
            ['/api/foods/search', 'USDA FoodData Central'],
            ['/api/foods/search-cnf', 'Canadian Nutrient File'],
            ['/api/foods/search-cofid', 'UK CoFID (2021)'],
            ['/api/foods/search-openfoodfacts', 'Open Food Facts']
          ];
          const settled=await Promise.all(endpoints.map(async([url,label])=>{
            try { const r=await fetch(`${url}?q=${encodeURIComponent(q)}`); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Search failed'); return (d.foods||[]).map(f=>({...f,sourceLabel:label})); }
            catch { return []; }
          }));
          const foods=settled.flat().slice(0,24);
          renderFoodResults(referenceResults,foods,'No matching foods were found in the reference databases.');
        } catch(e) { referenceResults.innerHTML=`<p class="page-copy">${escapeHtml(e.message)}</p>`; }
      },350);
    });

    builder.querySelector('[data-save-recipe]')?.addEventListener('click',async()=>{
      const name=builder.querySelector('[data-recipe-name]').value.trim(); const servings=Math.max(1,Number(builder.querySelector('[data-recipe-servings]').value)||1); const isPublic=Boolean(builder.querySelector('[data-recipe-public]')?.checked);
      if(!name||!ingredients.length){alert('Enter a recipe name and add at least one ingredient.');return;}
      if(editingRecipeId){
        const {error}=await supabase.from('recipes').update({name,servings,is_public:isPublic}).eq('id',editingRecipeId).eq('user_id',user.id); if(error){alert(error.message);return;}
        const {error:deleteError}=await supabase.from('recipe_items').delete().eq('recipe_id',editingRecipeId).eq('user_id',user.id); if(deleteError){alert(deleteError.message);return;}
        const rows=ingredients.map(i=>({recipe_id:editingRecipeId,user_id:user.id,food_name:i.name,serving:`${moneyless(i.amount)} ${i.unit}`,fdc_id:i.fdc_id,calories:i.calories,protein:i.protein,carbs:i.carbs,fat:i.fat}));
        const {error:itemError}=await supabase.from('recipe_items').insert(rows); if(itemError){alert(itemError.message);return;}
        const editedName=name; resetRecipeEditor(); await loadRecipes(list,beginRecipeEdit); alert(`${editedName} was updated.`); return;
      }
      const {data:recipe,error}=await supabase.from('recipes').insert({user_id:user.id,name,servings,is_public:isPublic}).select('*').single(); if(error){alert(error.message);return;}
      const rows=ingredients.map(i=>({recipe_id:recipe.id,user_id:user.id,food_name:i.name,serving:`${moneyless(i.amount)} ${i.unit}`,fdc_id:i.fdc_id,calories:i.calories,protein:i.protein,carbs:i.carbs,fat:i.fat}));
      const {error:itemError}=await supabase.from('recipe_items').insert(rows); if(itemError){alert(itemError.message);return;}
      ingredients=[];builder.querySelector('[data-recipe-name]').value='';drawIngredients();await loadRecipes(list,beginRecipeEdit);alert(`${name} was saved.`);
    });;
  }

  async function loadRecipes(list,onEdit){
    const {data,error}=await supabase.from('recipes').select('*, recipe_items(*)').eq('user_id',user.id).order('name');
    if(error){list.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const recipes=data||[];list.innerHTML=recipes.length?recipes.map(r=>{const items=r.recipe_items||[];const t=items.reduce((a,i)=>({calories:a.calories+Number(i.calories||0),protein:a.protein+Number(i.protein||0),carbs:a.carbs+Number(i.carbs||0),fat:a.fat+Number(i.fat||0)}),{calories:0,protein:0,carbs:0,fat:0});return `<article class="recipe-card"><div><h2>${escapeHtml(r.name)}</h2><p>${items.length} ingredient${items.length===1?'':'s'} · ${moneyless(t.calories/Number(r.servings||1))} cal per serving</p><div class="macro-row"><span>P ${moneyless(t.protein/Number(r.servings||1))}g</span><span>C ${moneyless(t.carbs/Number(r.servings||1))}g</span><span>F ${moneyless(t.fat/Number(r.servings||1))}g</span></div></div><div class="recipe-card-actions"><button class="ghost-button" type="button" data-edit-recipe="${r.id}">Edit</button><button class="primary-button" type="button" data-use-recipe="${r.id}">Use recipe</button></div></article>`}).join(''):'<p class="page-copy">No recipes yet. Create your first reusable recipe above.</p>';
    list.querySelectorAll('[data-edit-recipe]').forEach(b=>b.onclick=()=>onEdit?.(recipes.find(r=>String(r.id)===b.dataset.editRecipe)));
    list.querySelectorAll('[data-use-recipe]').forEach(b=>b.onclick=()=>openRecipeLogModal(recipes.find(r=>String(r.id)===b.dataset.useRecipe)));
  }

  function openRecipeLogModal(recipe){
    const items=recipe?.recipe_items||[];if(!recipe||!items.length)return;const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close-modal type="button">×</button><p class="eyebrow">Recipe</p><h2>${escapeHtml(recipe.name)}</h2><div class="form-grid"><div class="field"><label>Servings</label><input data-recipe-log-amount type="number" min="0.25" step="0.25" value="1"></div><div class="field"><label>Meal</label><select data-recipe-log-meal>${mealOptionsMarkup(userMeals[0]?.name || "Meal 1")}</select></div></div><div data-recipe-log-preview class="nutrition-summary"></div><div class="modal-actions"><button class="ghost-button" data-close-modal type="button">Cancel</button><button class="primary-button" data-confirm-recipe type="button">Add to meal</button></div></section>`;document.body.appendChild(overlay);overlay.querySelectorAll('[data-close-modal]').forEach(b=>b.onclick=()=>overlay.remove());const amount=overlay.querySelector('[data-recipe-log-amount]');const preview=overlay.querySelector('[data-recipe-log-preview]');const total=items.reduce((a,i)=>({calories:a.calories+Number(i.calories||0),protein:a.protein+Number(i.protein||0),carbs:a.carbs+Number(i.carbs||0),fat:a.fat+Number(i.fat||0)}),{calories:0,protein:0,carbs:0,fat:0});const per={calories:total.calories/Number(recipe.servings||1),protein:total.protein/Number(recipe.servings||1),carbs:total.carbs/Number(recipe.servings||1),fat:total.fat/Number(recipe.servings||1)};const calc=()=>{const x=Number(amount.value)||1;preview.innerHTML=`<div><strong>${moneyless(per.calories*x)}</strong><span>Calories</span></div><div><strong>${moneyless(per.protein*x)}g</strong><span>Protein</span></div><div><strong>${moneyless(per.carbs*x)}g</strong><span>Carbs</span></div><div><strong>${moneyless(per.fat*x)}g</strong><span>Fat</span></div>`};amount.oninput=calc;calc();overlay.querySelector('[data-confirm-recipe]').onclick=async()=>{const x=Number(amount.value)||1;const meal=overlay.querySelector('[data-recipe-log-meal]').value;const row={user_id:user.id,logged_date:dateKey(selectedDate),meal,food_name:recipe.name,serving:`${moneyless(x)} serving${x===1?'':'s'}`,fdc_id:null,calories:per.calories*x,protein:per.protein*x,carbs:per.carbs*x,fat:per.fat*x};const {error}=await supabase.from('food_entries').insert(row);if(error){alert(error.message);return;}overlay.remove();await renderSelectedDateEntries();};
  }

  async function renderAdmin() {
    const gate = $('[data-admin-dashboard]'); if (!gate) return;
    const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('id', user.id).single();
    if (profileError || !profile?.is_admin) { gate.innerHTML = '<section class="panel"><h2>Administrator access required</h2><p class="page-copy">This page is restricted to MacroSync administrators.</p></section>'; return; }
    const status = $('[data-admin-status]');
    const esc = escapeHtml;
    const loadFlags = async () => {
      const list = $('[data-admin-queue]');
      const { data, error } = await supabase.rpc('admin_list_moderation_queue');
      if (error) { list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`; return; }
      const flags=data||[];
      list.innerHTML=flags.length?flags.map(f=>{const isName=f.content_type==='display_name';const actions=isName?'<button class="primary-button" data-admin-action="replace">Change name</button><button class="ghost-button danger-button" data-admin-action="reset_name">Reset name</button>':'<button class="primary-button" data-admin-action="replace">Replace message</button><button class="ghost-button danger-button" data-admin-action="delete">Delete message</button>';return `<article class="admin-flag-item" data-admin-flag="${f.flag_id}"><div class="feedback-item-head"><strong>${esc(isName?'Flagged display name':'Flagged message')}</strong><span>${formatTimestamp(f.created_at)}</span></div><div class="feedback-author">${esc(f.display_name||'Unknown')} · ${esc(f.email||'Email hidden')}</div><p><strong>Reason:</strong> ${esc(f.reason)}</p><div class="admin-content-preview">${esc(f.content||'[content unavailable]')}</div><div class="field"><label>Replacement</label><textarea rows="2" data-admin-replacement></textarea></div><div class="field"><label>Message to user</label><textarea rows="2" data-admin-note placeholder="Explain the action and what the user should do next."></textarea></div><div class="feedback-actions">${actions}<button class="ghost-button" data-admin-status-action="${f.user_id}">Suspend / ban account</button></div></article>`}).join(''):'<p class="empty-state">No open flagged names or messages.</p>';
      list.querySelectorAll('[data-admin-action]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-admin-flag]');const {error}=await supabase.rpc('admin_moderation_action',{p_flag_id:Number(card.dataset.adminFlag),p_action:btn.dataset.adminAction,p_replacement:card.querySelector('[data-admin-replacement]')?.value||null,p_note:card.querySelector('[data-admin-note]')?.value||null});if(error){alert(error.message);return;}await loadFlags();});
      list.querySelectorAll('[data-admin-status-action]').forEach(btn=>btn.onclick=()=>openAccountStatusModal(btn.dataset.adminStatusAction));
      return flags.length;
    };
    const loadReports = async () => {
      const list=$('[data-admin-reports]'); const {data,error}=await supabase.rpc('admin_list_reports');
      if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;}
      const reports=data||[]; list.innerHTML=reports.length?reports.map(r=>`<article class="admin-flag-item" data-report="${r.report_id}" data-reported-user="${r.reported_user_id}"><div class="feedback-item-head"><strong>Report #${r.report_id}</strong><span>${formatTimestamp(r.created_at)}</span></div><div class="feedback-author">Reporter: ${esc(r.reporter_name)} · Reported: ${esc(r.reported_name)}</div><p><strong>Reason:</strong> ${esc(r.reason)}</p><div class="admin-content-preview">${esc(r.message_content||'[message deleted]')}</div><div class="field"><label>Admin note</label><textarea rows="2" data-report-note placeholder="Explain the action taken."></textarea></div><div class="feedback-actions"><button class="ghost-button" data-report-status="dismissed">Dismiss</button><button class="ghost-button" data-report-status="resolved">Resolve</button><button class="primary-button" data-report-suspend> Suspend account </button><button class="danger-button" data-report-ban>Ban account</button></div></article>`).join(''):'<p class="empty-state">No open user reports.</p>';
      list.querySelectorAll('[data-report-status]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-report]');const {error}=await supabase.rpc('admin_update_report',{p_report_id:Number(card.dataset.report),p_status:btn.dataset.reportStatus,p_note:card.querySelector('[data-report-note]').value||null});if(error)alert(error.message);else await loadReports();});
      list.querySelectorAll('[data-report-suspend],[data-report-ban]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-report]');await openAccountStatusModal(card.dataset.reportedUserId,btn.hasAttribute('data-report-ban')?'banned':'suspended',Number(card.dataset.report));});
    };
    const loadTrainerVerifications = async()=>{
      const list=$('[data-admin-trainer-verifications]'); if(!list) return;
      const {data,error}=await supabase.rpc('admin_list_trainer_verifications');
      if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;}
      const rows=data||[];
      list.innerHTML=rows.length?rows.map(v=>`<article class="admin-flag-item" data-verification-user="${v.user_id}"><div class="feedback-item-head"><strong>${esc(v.display_name||'Unknown')} ${v.status==='approved'?'✓':''}</strong><span>${esc(v.status)}</span></div><div class="feedback-author">${esc(v.email||'Email hidden')}${v.business_name?' · '+esc(v.business_name):''}</div><p>Requested ${formatTimestamp(v.requested_at)}</p><div class="trainer-verification-review"><p><strong>Training experience</strong><br>${esc(v.experience||'Not provided')}</p><p><strong>Credentials</strong><br>${esc(v.credentials||'Not provided')}</p>${v.credential_number?`<p><strong>Credential number</strong><br>${esc(v.credential_number)}</p>`:''}${v.proof_url?`<p><strong>Verification link</strong><br><a href="${esc(v.proof_url)}" target="_blank" rel="noopener noreferrer">${esc(v.proof_url)}</a></p>`:''}${(v.instagram||v.facebook||v.tiktok||v.youtube||v.other_social)?`<p><strong>Social media</strong><br>${[['Instagram',v.instagram],['Facebook',v.facebook],['TikTok',v.tiktok],['YouTube',v.youtube],['Other',v.other_social]].filter(([,value])=>value).map(([label,value])=>`${label}: ${esc(value)}`).join('<br>')}</p>`:''}<p><strong>Resume / professional background</strong><br>${esc(v.professional_background||'Not provided')}</p><p><strong>Applicant statement</strong><br>${esc(v.statement||'Not provided')}</p></div><div class="field"><label>Admin note</label><textarea rows="2" data-verification-note placeholder="Explain the decision or request more evidence."></textarea></div><div class="feedback-actions"><button class="primary-button" data-verification-action="approved">Approve</button><button class="ghost-button" data-verification-action="rejected">Reject</button>${v.status==='approved'?'<button class="danger-button" data-verification-action="revoked">Revoke</button>':''}</div></article>`).join(''):'<p class="empty-state">No trainer verification requests.</p>';
      list.querySelectorAll('[data-verification-action]').forEach(btn=>btn.onclick=async()=>{const card=btn.closest('[data-verification-user]');const {error}=await supabase.rpc('admin_set_trainer_verification',{p_user_id:card.dataset.verificationUser,p_status:btn.dataset.verificationAction,p_note:card.querySelector('[data-verification-note]').value||null});if(error){alert(error.message);return;}await loadTrainerVerifications();});
    };
    const loadFeedback=async()=>{const list=$('[data-admin-feedback]');const {data,error}=await supabase.from('feedback').select('id,user_id,category,message,created_at,read_at').order('created_at',{ascending:false});if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;}const rows=data||[];list.innerHTML=rows.length?rows.map(f=>`<article class="admin-flag-item"><div class="feedback-item-head"><strong>${esc(f.category)}</strong><span>${formatTimestamp(f.created_at)}</span></div><p>${esc(f.message)}</p><div class="feedback-actions"><button class="ghost-button" data-feedback-delete="${f.id}">Delete feedback</button></div></article>`).join(''):'<p class="empty-state">No feedback yet.</p>';list.querySelectorAll('[data-feedback-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this feedback?'))return;const {error}=await supabase.from('feedback').delete().eq('id',Number(b.dataset.feedbackDelete));if(error)alert(error.message);else await loadFeedback();});};
    async function openAccountStatusModal(targetId, preset=null, reportId=null){
      const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" type="button" data-close>×</button><p class="eyebrow">Account moderation</p><h2>Suspend or ban account</h2><div class="field"><label>Status</label><select data-status><option value="suspended">Suspended</option><option value="banned">Banned</option><option value="active">Restore active</option></select></div><div class="field"><label>Explanation to user</label><textarea rows="4" data-status-note placeholder="Explain why this action was taken."></textarea></div><div class="field"><label>Suspension end (optional)</label><input type="datetime-local" data-status-until></div><div class="modal-actions"><button class="ghost-button" data-close>Cancel</button><button class="primary-button" data-apply-status>Apply</button></div></section>`;document.body.appendChild(overlay);overlay.querySelector('[data-status]').value=preset||'suspended';overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>overlay.remove());overlay.querySelector('[data-apply-status]').onclick=async()=>{const statusValue=overlay.querySelector('[data-status]').value;const note=overlay.querySelector('[data-status-note]').value||null;const until=overlay.querySelector('[data-status-until]').value?new Date(overlay.querySelector('[data-status-until]').value).toISOString():null;const {error}=await supabase.rpc('admin_set_account_status',{p_user_id:targetId,p_status:statusValue,p_note:note,p_until:until});if(error){alert(error.message);return;}if(reportId)await supabase.rpc('admin_update_report',{p_report_id:reportId,p_status:'resolved',p_note:note});overlay.remove();await Promise.all([loadFlags(),loadReports(),loadTrainerVerifications()]);};
    }
    const loadAnalytics=async()=>{const list=$('[data-admin-analytics]'); if(!list)return; const {data,error}=await supabase.from('app_events').select('event_name,created_at').order('created_at',{ascending:false}).limit(5000); if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;} const rows=data||[]; const counts=new Map(); rows.forEach(e=>counts.set(e.event_name,(counts.get(e.event_name)||0)+1)); const ordered=[...counts.entries()].sort((a,b)=>b[1]-a[1]); list.innerHTML=ordered.length?`<div class="analytics-summary-grid">${ordered.slice(0,12).map(([name,count])=>`<article class="panel analytics-summary-card"><strong>${esc(name)}</strong><span>${count.toLocaleString()} events</span></article>`).join('')}</div><p class="page-copy">Showing the most recent ${rows.length.toLocaleString()} recorded events.</p>`:'<p class="empty-state">No analytics events have been recorded yet.</p>';};
    const loadErrors=async()=>{const list=$('[data-admin-errors]'); if(!list)return; const {data,error}=await supabase.from('app_error_events').select('id,user_id,page_path,message,stack,context,created_at').order('created_at',{ascending:false}).limit(100); if(error){list.innerHTML=`<p class="page-copy">${esc(error.message)}</p>`;return;} const rows=data||[]; list.innerHTML=rows.length?rows.map(e=>`<article class="admin-flag-item"><div class="feedback-item-head"><strong>${esc(e.page_path||'Unknown page')}</strong><span>${formatTimestamp(e.created_at)}</span></div><p>${esc(e.message)}</p><div class="admin-content-preview"><strong>Version:</strong> ${esc(e.context?.app_version||'Unknown')}<br><strong>Source:</strong> ${esc(e.context?.source||'Runtime')}<br><strong>Stack:</strong><pre class="error-stack">${esc(e.stack||'No stack captured')}</pre></div></article>`).join(''):'<p class="empty-state">No client errors have been reported.</p>';};
    $('[data-admin-refresh]')?.addEventListener('click',async()=>{await Promise.all([loadFlags(),loadReports(),loadFeedback(),loadTrainerVerifications(),loadErrors(),loadAnalytics()]);status.textContent='Admin data refreshed.';});
    $('[data-admin-scan]')?.addEventListener('click',async()=>{status.textContent='Scanning existing content…';const {error}=await supabase.rpc('admin_scan_existing_content',{p_limit:1000});if(error){status.textContent=error.message;return;}await loadFlags();status.textContent='Existing-content scan complete.';});
    $$('[data-admin-tab]').forEach(tab=>tab.onclick=()=>{$$('[data-admin-tab]').forEach(x=>x.classList.toggle('primary-button',x===tab));$$('[data-admin-tab]').forEach(x=>x.classList.toggle('ghost-button',x!==tab));$$('[data-admin-section]').forEach(sec=>sec.hidden=sec.dataset.adminSection!==tab.dataset.adminTab);});
    await Promise.all([loadFlags(),loadReports(),loadFeedback(),loadTrainerVerifications(),loadErrors(),loadAnalytics()]);
  }

  async function renderSocial() {
    if (messageRealtimeChannel) { try { await supabase.removeChannel(messageRealtimeChannel); } catch {} messageRealtimeChannel = null; }
    if (mealRealtimeChannel) { try { await supabase.removeChannel(mealRealtimeChannel); } catch {} mealRealtimeChannel = null; }
    conversationBeforeCursor = null;
    conversationHasOlder = false;
    const page = document.body.dataset.page || 'social';
    const search = $('[data-friend-search]');
    const peopleList = $('[data-people-list]');
    const friendList = $('[data-friend-list]');
    const messageThread = $('[data-message-thread]');
    const sharedMealList = $('[data-shared-meal-list]');
    const hasSocialSurface = peopleList || friendList || messageThread || sharedMealList;
    if (!hasSocialSurface) return;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id,display_name,email,role,business_name')
      .eq('id', user.id)
      .single();
    if (profileError) throw profileError;

    await loadSocialData('');

    const acceptedFriends = getAcceptedFriends();
    if (!selectedFriendId || !acceptedFriends.some(friend => friend.id === selectedFriendId)) {
      selectedFriendId = acceptedFriends[0]?.id || null;
    }
    if (!selectedMealFriendId || !acceptedFriends.some(friend => friend.id === selectedMealFriendId)) {
      selectedMealFriendId = acceptedFriends[0]?.id || null;
    }

    const drawPeople = async () => {
      if (!search && !peopleList) return;
      await loadSocialData(search?.value || '');
      renderPeople(search?.value || '');
      renderFriendsList();
      renderFriendSelectors();
      renderFriendRequests();
      renderNutritionShares().catch(console.error);
      wireSocialButtons(profile);
    };

    if (search) {
      let timer;
      search.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => drawPeople().catch(console.error), 220);
      };
    }

    socialCurrentProfile = profile;
    await loadSocialData('');
    renderPeople(search?.value || '');
    renderFriendsList();
    renderFriendSelectors();
    renderFriendRequests();
    renderSharingControls(profile);
    await renderMessages();
    await renderSharedMeals(profile);
    await renderNutritionShares();
    wireSocialButtons(profile);

    if (page === 'friends-add') {
      // Add-friends page is search-driven; no realtime subscription is needed.
      return;
    }

    // Messaging uses a tiny message_events realtime payload, then refreshes the
    // bounded conversation RPC. The message body itself is never exposed through
    // Realtime, which preserves the age-aware moderation boundary.
    if (page === 'friends-messages' || page === 'social') {
      messageRealtimeChannel = supabase.channel(`macrosync-message-events-${user.id}-${Date.now()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_events', filter: `recipient_id=eq.${user.id}` }, payload => {
          const row = payload.new || {};
          if (selectedFriendId && row.sender_id === selectedFriendId) renderMessages().catch(console.error);
        })
        .subscribe();
    }

    // Meal updates are user-owned rows. Shared-meal viewers can still use the
    // page's explicit refresh/navigation; removing the 3-second global poll is
    // substantially cheaper at scale.
    if (page === 'friends-meals' || page === 'social') {
      mealRealtimeChannel = supabase.channel(`macrosync-meal-updates-${user.id}-${Date.now()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'meals', filter: `user_id=eq.${user.id}` }, () => {
          if (selectedMealFriendId) renderSharedMeals(profile).catch(console.error);
        })
        .subscribe();
    }
  }

  async function loadSocialData(query='') {
    const [{ data: people, error: peopleError }, { data: connections, error: connectionsError }] = await Promise.all([
      supabase.rpc('search_people', { p_query: query || '' }),
      supabase.rpc('get_my_friend_connections')
    ]);
    if (peopleError) throw peopleError;
    if (connectionsError) throw connectionsError;
    socialPeople = people || [];
    socialConnections = connections || [];
  }

  function connectionFor(personId) {
    return socialConnections.find(c =>
      (c.requester_id === user.id && c.addressee_id === personId) ||
      (c.addressee_id === user.id && c.requester_id === personId)
    );
  }

  function otherId(connection) {
    return connection.requester_id === user.id ? connection.addressee_id : connection.requester_id;
  }

  function personById(id) { return socialPeople.find(p => p.id === id); }
  function roleLabel(role) { return role === 'trainer' ? 'Personal trainer' : 'Personal'; }

  function getAcceptedFriends() {
    return socialConnections
      .filter(c => c.status === 'accepted')
      .map(c => personById(otherId(c)))
      .filter(Boolean)
      .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  }

  function renderPeople(query='') {
    const list = $('[data-people-list]'); if (!list) return;
    const q = query.trim().toLowerCase();
    const people = socialPeople.filter(p => !q || `${p.display_name} ${p.email} ${p.business_name || ''}`.toLowerCase().includes(q));
    const renderGroup = (role, title) => {
      const group = people.filter(p => p.role === role);
      return `<section class="social-category"><div class="social-category-header"><h3>${title}</h3><span>${group.length}</span></div>${group.length ? group.map(renderPersonCard).join('') : '<p class="page-copy">No matching people.</p>'}</section>`;
    };
    list.innerHTML = renderGroup('trainer','Personal trainers') + renderGroup('user','Personal');
  }

  function renderFriendRequests() {
    const list = $('[data-friend-requests]');
    if (!list) return;
    const incoming = socialConnections
      .filter(c => c.status === 'pending' && c.addressee_id === user.id)
      .map(c => ({ connection: c, person: personById(c.requester_id) }))
      .filter(x => x.connection);
    if (!incoming.length) {
      list.innerHTML = '<p class="page-copy">No pending friend requests.</p>';
      return;
    }
    list.innerHTML = incoming.map(({connection, person}) => {
      const name = person?.display_name || 'MacroSync User';
      const role = person?.role || 'user';
      const expiry = connection.expires_at ? `Expires ${formatTimestamp(connection.expires_at)}` : 'Expires after 7 days';
      return `<article class="friend-request-card"><div><strong>${escapeHtml(name)}</strong><p>${escapeHtml(roleLabel(role))} · ${escapeHtml(expiry)}</p></div><div class="social-request-actions"><button class="primary-button" type="button" data-accept-request="${connection.id}">Accept</button><button class="ghost-button danger-button" type="button" data-reject-request="${connection.id}">Reject</button></div></article>`;
    }).join('');
  }

  function nutritionTotals(items) {
    return (items || []).reduce((a, i) => ({
      calories: a.calories + Number(i.calories || 0),
      protein: a.protein + Number(i.protein || 0),
      carbs: a.carbs + Number(i.carbs || 0),
      fat: a.fat + Number(i.fat || 0)
    }), {calories:0,protein:0,carbs:0,fat:0});
  }

  function nutritionSnapshotLabel(type) {
    return ({food:'Food', meal:'Meal', recipe:'Recipe', day_plan:'Day plan'})[type] || 'Nutrition';
  }

  async function loadNutritionShareChoices(type) {
    if (type === 'recipe') {
      const {data,error}=await supabase.from('recipes').select('*, recipe_items(*)').eq('user_id',user.id).order('name');
      if(error) throw error;
      return (data||[]).map(r=>({id:r.id,title:r.name,snapshot:{name:r.name,servings:r.servings,items:r.recipe_items||[]}}));
    }
    if (type === 'meal') {
      const {data,error}=await supabase.from('saved_meals').select('*, saved_meal_items(*)').eq('user_id',user.id).order('name');
      if(error) throw error;
      return (data||[]).map(m=>({id:m.id,title:m.name,snapshot:{name:m.name,items:m.saved_meal_items||[]}}));
    }
    if (type === 'food') {
      const {data,error}=await supabase.from('food_entries').select('*').eq('user_id',user.id).eq('logged_date',dateKey(selectedDate)).order('created_at',{ascending:false}).limit(50);
      if(error) throw error;
      const seen=new Set();
      return (data||[]).filter(f=>{const key=`${f.food_name}|${f.serving}|${f.calories}|${f.protein}|${f.carbs}|${f.fat}`;if(seen.has(key))return false;seen.add(key);return true;}).map(f=>({id:f.id,title:f.food_name,snapshot:{food_name:f.food_name,serving:f.serving,fdc_id:f.fdc_id,calories:f.calories,protein:f.protein,carbs:f.carbs,fat:f.fat}}));
    }
    const {data,error}=await supabase.from('food_entries').select('*').eq('user_id',user.id).eq('logged_date',dateKey(selectedDate)).order('created_at');
    if(error) throw error;
    const entries=data||[];
    const groups={};
    for(const entry of entries){const key=entry.meal||'Meal';(groups[key] ||= []).push(entry);}
    return Object.entries(groups).map(([name,items])=>({id:null,title:name,snapshot:{date:dateKey(selectedDate),meals:[{name,items}],totals:nutritionTotals(items)}}));
  }

  async function openNutritionShareModal() {
    if (!selectedFriendId) { alert('Select a friend first.'); return; }
    const friend=personById(selectedFriendId);
    if (!friend) { alert('Select an accepted friend first.'); return; }
    const overlay=document.createElement('div'); overlay.className='modal-overlay';
    overlay.innerHTML=`<section class="modal-card nutrition-share-modal" role="dialog" aria-modal="true" aria-labelledby="nutritionShareTitle"><button class="modal-close" data-close-share type="button">×</button><p class="eyebrow">Share nutrition</p><h2 id="nutritionShareTitle">Send something to ${escapeHtml(friend.display_name)}</h2><p class="page-copy">This sends a suggestion. ${escapeHtml(friend.display_name)} must accept it before they can choose to add or save it.</p><div class="field"><label for="nutritionShareType">What are you sending?</label><select id="nutritionShareType" data-nutrition-share-type><option value="food">Food</option><option value="meal">Saved meal</option><option value="recipe">Recipe</option><option value="day_plan">Day plan</option></select></div><div class="field"><label for="nutritionShareChoice">Choose an item</label><select id="nutritionShareChoice" data-nutrition-share-choice><option value="">Loading…</option></select></div><div class="field"><label for="nutritionShareNote">Optional note</label><textarea id="nutritionShareNote" data-nutrition-share-note rows="3" placeholder="Add a note about why you are sharing this."></textarea></div><div class="modal-actions"><button class="ghost-button" data-close-share type="button">Cancel</button><button class="primary-button" data-send-nutrition-share type="button">Send</button></div></section>`;
    document.body.appendChild(overlay);
    const typeSelect=overlay.querySelector('[data-nutrition-share-type]'); const choiceSelect=overlay.querySelector('[data-nutrition-share-choice]');
    const populate=async()=>{choiceSelect.innerHTML='<option value="">Loading…</option>';try{const choices=await loadNutritionShareChoices(typeSelect.value);choiceSelect.innerHTML=choices.length?choices.map((x,i)=>`<option value="${i}">${escapeHtml(x.title)}</option>`).join(''):'<option value="">No items available</option>';choiceSelect._choices=choices;}catch(e){choiceSelect.innerHTML=`<option value="">${escapeHtml(e.message||'Could not load items.')}</option>`;}};
    overlay.querySelectorAll('[data-close-share]').forEach(b=>b.onclick=()=>overlay.remove());
    typeSelect.onchange=populate; await populate();
    overlay.querySelector('[data-send-nutrition-share]').onclick=async()=>{const choices=choiceSelect._choices||[];const choice=choices[Number(choiceSelect.value)];if(!choice){alert('Choose an item first.');return;}const note=overlay.querySelector('[data-nutrition-share-note]').value.trim()||null;const {error}=await supabase.rpc('create_nutrition_share',{p_recipient_id:selectedFriendId,p_item_type:typeSelect.value,p_title:choice.title,p_note:note,p_snapshot:choice.snapshot,p_source_id:choice.id,p_attach_to_message:true});if(error){alert(error.message);return;}overlay.remove();await renderMessages();await renderNutritionShares();};
  }

  function nutritionShareCard(share, senderName, inThread=false) {
    const snap=share.snapshot||{}; const totals=snap.totals||nutritionTotals(snap.items||[]); const status=share.status;
    let detail='';
    if(share.item_type==='food'){detail=`${escapeHtml(snap.serving||'')} · ${moneyless(snap.calories)} cal · P ${moneyless(snap.protein)}g · C ${moneyless(snap.carbs)}g · F ${moneyless(snap.fat)}g`;}
    else if(share.item_type==='recipe'){detail=`${Array.isArray(snap.items)?snap.items.length:0} ingredient${Array.isArray(snap.items)&&snap.items.length===1?'':'s'} · ${moneyless(Number(totals.calories)/(Number(snap.servings)||1))} cal/serving`;}
    else if(share.item_type==='meal'){detail=`${Array.isArray(snap.items)?snap.items.length:0} food${Array.isArray(snap.items)&&snap.items.length===1?'':'s'} · ${moneyless(totals.calories)} cal`;}
    else {detail=`${Array.isArray(snap.meals)?snap.meals.length:0} meal${Array.isArray(snap.meals)&&snap.meals.length===1?'':'s'} · ${moneyless(totals.calories)} cal`;
    }
    const incoming=share.recipient_id===user.id;
    const pending=incoming && status==='pending';
    const accepted=incoming && status==='accepted';
    const actions=pending?`<div class="nutrition-share-actions"><button class="primary-button" type="button" data-accept-nutrition-share="${share.id}">Accept</button><button class="ghost-button danger-button" type="button" data-decline-nutrition-share="${share.id}">Decline</button></div>`:accepted?`<div class="nutrition-share-actions"><button class="primary-button" type="button" data-use-nutrition-share="${share.id}">Use this</button></div>`:'';
    const statusText=status==='pending'?(incoming?'Waiting for your decision':'Waiting for recipient'):status.charAt(0).toUpperCase()+status.slice(1);
    return `<article class="nutrition-share-card ${pending?'pending':''}"><div class="nutrition-share-head"><span class="role-badge">${escapeHtml(nutritionSnapshotLabel(share.item_type))}</span><span>${escapeHtml(statusText)}</span></div><h3>${escapeHtml(share.title)}</h3><p>${escapeHtml(senderName ? `${senderName} shared this with you.` : '')}</p><div class="nutrition-share-summary"><strong>${detail}</strong></div>${share.note?`<p class="nutrition-share-note">${escapeHtml(share.note)}</p>`:''}${actions}</article>`;
  }

  async function fetchNutritionSharesForMessages(rows) {
    const ids=(rows||[]).map(m=>m.id).filter(Boolean); if(!ids.length)return [];
    const {data,error}=await supabase.from('nutrition_shares').select('*').in('message_id',ids); if(error) throw error; return data||[];
  }

  async function renderNutritionShares() {
    const list=$('[data-nutrition-shares-list]'); if(!list)return;
    const {data,error}=await supabase.rpc('get_my_nutrition_shares'); if(error){list.innerHTML=`<p class="page-copy">${escapeHtml(error.message)}</p>`;return;}
    const rows=(data||[]).filter(s=>s.recipient_id===user.id).slice(0,30);
    if(!rows.length){list.innerHTML='<p class="page-copy">Nothing has been shared with you yet.</p>';return;}
    const names={}; for(const r of rows){names[r.sender_id]=personById(r.sender_id)?.display_name||'A friend';}
    list.innerHTML=rows.map(r=>nutritionShareCard(r,names[r.sender_id])).join(''); bindNutritionShareActions(list);
  }

  function bindNutritionShareActions(scope=document) {
    scope.querySelectorAll('[data-accept-nutrition-share]').forEach(b=>b.onclick=async()=>{const {error}=await supabase.rpc('accept_nutrition_share',{p_share_id:Number(b.dataset.acceptNutritionShare)});if(error){alert(error.message);return;}await renderNutritionShares();await renderMessages();});
    scope.querySelectorAll('[data-decline-nutrition-share]').forEach(b=>b.onclick=async()=>{const {error}=await supabase.rpc('decline_nutrition_share',{p_share_id:Number(b.dataset.declineNutritionShare)});if(error){alert(error.message);return;}await renderNutritionShares();await renderMessages();});
    scope.querySelectorAll('[data-use-nutrition-share]').forEach(b=>b.onclick=()=>openNutritionUseModal(Number(b.dataset.useNutritionShare)));
  }

  async function openNutritionUseModal(shareId) {
    const {data,error}=await supabase.from('nutrition_shares').select('*').eq('id',shareId).eq('recipient_id',user.id).single(); if(error){alert(error.message);return;}
    if(data.status!=='accepted'){alert('Accept this item before using it.');return;}
    const options=data.item_type==='recipe'?'<option value="save_recipe">Save to my recipes</option><option value="log_recipe">Add recipe to today</option>':data.item_type==='meal'?'<option value="save_meal">Save as a meal</option><option value="log_meal">Add meal to today</option>':data.item_type==='day_plan'?'<option value="log_day">Add day plan to today</option>':'<option value="log_food">Add food to today</option>';
    const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML=`<section class="modal-card" role="dialog" aria-modal="true"><button class="modal-close" data-close-use type="button">×</button><p class="eyebrow">Use shared nutrition</p><h2>${escapeHtml(data.title)}</h2><p class="page-copy">Choose what you want MacroSync to do. Accepting the share never changes your log by itself.</p><div class="field"><label>Action</label><select data-use-action>${options}</select></div><div class="modal-actions"><button class="ghost-button" data-close-use type="button">Cancel</button><button class="primary-button" data-confirm-use type="button">Continue</button></div></section>`;document.body.appendChild(overlay);overlay.querySelectorAll('[data-close-use]').forEach(b=>b.onclick=()=>overlay.remove());overlay.querySelector('[data-confirm-use]').onclick=async()=>{try{await applyNutritionShare(data,overlay.querySelector('[data-use-action]').value);overlay.remove();await renderNutritionShares();await renderMessages();if(document.body.dataset.page==='log')await renderPage();}catch(e){alert(e.message||String(e));}};
  }

  async function applyNutritionShare(share, action) {
    const snap=share.snapshot||{};
    if(action==='log_food'){
      const f=snap; const {error}=await supabase.from('food_entries').insert({user_id:user.id,logged_date:dateKey(selectedDate),meal:userMeals[0]?.name||'Meal 1',food_name:f.food_name||share.title,serving:f.serving||'1 serving',fdc_id:f.fdc_id||null,calories:Number(f.calories||0),protein:Number(f.protein||0),carbs:Number(f.carbs||0),fat:Number(f.fat||0)});if(error)throw error;return;
    }
    if(action==='log_meal'){
      const mealName=userMeals[0]?.name||'Meal 1'; const rows=(snap.items||[]).map(i=>({user_id:user.id,logged_date:dateKey(selectedDate),meal:mealName,food_name:i.food_name,serving:i.serving,fdc_id:i.fdc_id||null,calories:Number(i.calories||0),protein:Number(i.protein||0),carbs:Number(i.carbs||0),fat:Number(i.fat||0)})); if(!rows.length)throw new Error('This shared meal has no foods.'); const {error}=await supabase.from('food_entries').insert(rows);if(error)throw error;return;
    }
    if(action==='log_day'){
      const mealNameBase=userMeals[0]?.name||'Meal 1'; const rows=[]; for(const meal of snap.meals||[]){for(const i of meal.items||[]){rows.push({user_id:user.id,logged_date:dateKey(selectedDate),meal:meal.name||mealNameBase,food_name:i.food_name,serving:i.serving,fdc_id:i.fdc_id||null,calories:Number(i.calories||0),protein:Number(i.protein||0),carbs:Number(i.carbs||0),fat:Number(i.fat||0)});}} if(!rows.length)throw new Error('This day plan has no foods.'); const {error}=await supabase.from('food_entries').insert(rows);if(error)throw error;return;
    }
    if(action==='save_meal'){
      const {data:meal,error}=await supabase.from('saved_meals').insert({user_id:user.id,name:share.title}).select('*').single();if(error)throw error; const rows=(snap.items||[]).map(i=>({saved_meal_id:meal.id,user_id:user.id,food_name:i.food_name,serving:i.serving,fdc_id:i.fdc_id||null,source:i.source||'saved_meal',source_id:i.source_id||'',serving_amount:i.serving_amount||parseServingAmount(i.serving)||1,serving_unit:i.serving_unit||'serving',serving_grams:i.serving_grams||null,brand_name:i.brand_name||null,store_name:i.store_name||null,calories:Number(i.calories||0),protein:Number(i.protein||0),carbs:Number(i.carbs||0),fat:Number(i.fat||0)}));if(rows.length){const {error:e}=await supabase.from('saved_meal_items').insert(rows);if(e)throw e;}return;
    }
    if(action==='save_recipe'){
      const {data:recipe,error}=await supabase.from('recipes').insert({user_id:user.id,name:share.title,servings:Number(snap.servings||1)}).select('*').single();if(error)throw error; const rows=(snap.items||[]).map(i=>({recipe_id:recipe.id,user_id:user.id,food_name:i.food_name,serving:i.serving,fdc_id:i.fdc_id||null,calories:Number(i.calories||0),protein:Number(i.protein||0),carbs:Number(i.carbs||0),fat:Number(i.fat||0)}));if(rows.length){const {error:e}=await supabase.from('recipe_items').insert(rows);if(e)throw e;}return;
    }
    if(action==='log_recipe'){
      const total=nutritionTotals(snap.items||[]);const servings=Number(snap.servings||1);const {error}=await supabase.from('food_entries').insert({user_id:user.id,logged_date:dateKey(selectedDate),meal:userMeals[0]?.name||'Meal 1',food_name:share.title,serving:'1 serving',fdc_id:null,calories:total.calories/servings,protein:total.protein/servings,carbs:total.carbs/servings,fat:total.fat/servings});if(error)throw error;
    }
  }

  function renderPersonCard(person) {
    const connection = connectionFor(person.id);
    let action = `<button class="ghost-button" type="button" data-add-person="${person.id}">Add friend</button>`;
    if (connection?.status === 'accepted') {
      action = `<button class="primary-button" type="button" data-select-friend="${person.id}">Open</button>`;
    } else if (connection?.status === 'pending') {
      action = connection.requester_id === user.id
        ? `<button class="ghost-button" type="button" disabled>Request sent</button>`
        : `<div class="social-request-actions"><button class="primary-button" type="button" data-accept-request="${connection.id}" data-person-id="${person.id}">Accept</button><button class="ghost-button danger-button" type="button" data-reject-request="${connection.id}">Reject</button></div>`;
    } else if (connection?.status === 'declined' || connection?.status === 'expired') {
      action = `<button class="ghost-button" type="button" data-add-person="${person.id}">Send again</button>`;
    }
    if (person.role === 'user' && socialCurrentProfile?.role === 'trainer') {
      action = connection?.status === 'accepted'
        ? `<button class="primary-button" type="button" data-select-friend="${person.id}">Open</button>`
        : connection?.requester_id === user.id && connection?.status === 'pending'
          ? `<button class="ghost-button" type="button" disabled>Request sent</button>`
          : `<span class="page-copy">The user must send the friend request.</span>`;
    }
    return `<article class="friend-card"><div class="friend-top"><div class="profile-strip"><span class="avatar">${escapeHtml((person.display_name || 'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(person.display_name || 'MacroSync User')}</strong><p>${escapeHtml(person.email || 'Email unavailable')}</p>${person.business_name ? `<p>${escapeHtml(person.business_name)}</p>` : ''}</span></div><span class="role-badge ${person.role === 'trainer' ? 'trainer' : ''}">${roleLabel(person.role)}</span></div><div class="social-card-actions">${action}</div></article>`;
  }

  function renderFriendsList() {
    const list = $('[data-friend-list]'); if (!list) return;
    const friends = getAcceptedFriends();
    const renderGroup = (role, title) => {
      const group = friends.filter(p => p.role === role);
      return `<section class="social-category"><div class="social-category-header"><h3>${title}</h3><span>${group.length}</span></div>${group.length ? group.map(p => `<button class="friend-card friend-select-card${p.id === selectedFriendId ? ' selected' : ''}" type="button" data-select-friend="${p.id}"><div class="friend-top"><div class="profile-strip"><span class="avatar">${escapeHtml((p.display_name || 'P').charAt(0).toUpperCase())}</span><span><strong>${escapeHtml(p.display_name)}</strong><p>${escapeHtml(p.email || 'Email unavailable')}</p></span></div><span class="role-badge ${p.role === 'trainer' ? 'trainer' : ''}">${roleLabel(p.role)}</span></div></button>`).join('') : '<p class="page-copy">No friends in this category.</p>'}`;
    };
    list.innerHTML = friends.length ? renderGroup('trainer','Personal trainers') + renderGroup('user','Personal') : '<p class="page-copy">Add a friend to start messaging and sharing.</p>';
  }

  function renderFriendSelectors() {
    const friends = getAcceptedFriends();
    const messageSelect = $('[data-message-friend-select]');
    const mealSelect = $('[data-meal-friend-select]');

    const options = friends.length
      ? friends.map(friend => `<option value="${friend.id}">${escapeHtml(friend.display_name)}${friend.role === 'trainer' ? ' · Trainer' : ''}</option>`).join('')
      : '<option value="">No accepted friends</option>';

    if (messageSelect) {
      messageSelect.innerHTML = options;
      messageSelect.value = selectedFriendId || '';
      messageSelect.onchange = async () => {
        selectedFriendId = messageSelect.value || null;
        renderFriendsList();
        renderSharingControls(await getCurrentProfile());
        await renderMessages();
      };
    }

    if (mealSelect) {
      mealSelect.innerHTML = options;
      mealSelect.value = selectedMealFriendId || '';
      mealSelect.onchange = async () => {
        selectedMealFriendId = mealSelect.value || null;
        renderSharingControls(await getCurrentProfile());
        await renderSharedMeals(await getCurrentProfile());
      };
    }

    setText('[data-chat-title]', selectedFriendId ? (personById(selectedFriendId)?.display_name || 'Select a friend') : 'Select a friend');
  }

  async function getCurrentProfile() {
    const { data, error } = await supabase.from('profiles').select('id,display_name,email,role,business_name').eq('id', user.id).single();
    if (error) throw error;
    return data;
  }

  async function wireSocialButtons(profile) {
    document.querySelectorAll('[data-add-person]').forEach(btn => btn.onclick = async () => {
      const { error } = await supabase.rpc('send_friend_request', { p_addressee_id: btn.dataset.addPerson });
      if (error) { alert(error.message); return; }
      await renderSocial();
    });

    document.querySelectorAll('[data-accept-request]').forEach(btn => btn.onclick = async () => {
      const { error } = await supabase.rpc('accept_friend_request', { p_connection_id: Number(btn.dataset.acceptRequest) });
      if (error) { alert(error.message); return; }
      await renderSocial();
    });

    document.querySelectorAll('[data-reject-request]').forEach(btn => btn.onclick = async () => {
      const { error } = await supabase.rpc('reject_friend_request', { p_connection_id: Number(btn.dataset.rejectRequest) });
      if (error) { alert(error.message); return; }
      await renderSocial();
    });

    document.querySelectorAll('[data-select-friend]').forEach(btn => btn.onclick = async () => {
      selectedFriendId = btn.dataset.selectFriend;
      conversationBeforeCursor = null;
      conversationHasOlder = false;
      selectedMealFriendId = selectedMealFriendId || selectedFriendId;
      renderFriendsList();
      renderFriendSelectors();
      const currentProfile = await getCurrentProfile();
      renderSharingControls(currentProfile);
      await renderMessages();
      await renderSharedMeals(currentProfile);
    });

    if ($('[data-send-message]')) $('[data-send-message]').onclick = sendMessage;
    if ($('[data-share-nutrition]')) $('[data-share-nutrition]').onclick = openNutritionShareModal;
    if ($('[data-message-text]')) $('[data-message-text]').onkeydown = e => { if (e.key === 'Enter') sendMessage(); };
  }

  async function renderMessages(loadOlder = false) {
    const thread = $('[data-message-thread]');
    if (!thread || !selectedFriendId) {
      if (thread) thread.innerHTML = '<p class="page-copy">Select a friend to view messages.</p>';
      return;
    }

    const args = { p_friend_id: selectedFriendId, p_limit: 50 };
    if (loadOlder && conversationBeforeCursor) {
      args.p_before = conversationBeforeCursor.created_at;
      args.p_before_id = conversationBeforeCursor.id;
    }
    const { data, error } = await supabase.rpc('get_conversation_messages', args);
    if (error) throw error;

    const rows = data || [];
    conversationHasOlder = rows.length >= 50;
    if (!loadOlder) {
      conversationBeforeCursor = rows[0] ? { id: rows[0].id, created_at: rows[0].created_at } : null;
      const shares = await fetchNutritionSharesForMessages(rows);
      const shareByMessage = new Map(shares.map(s => [s.message_id, s]));
      thread.innerHTML = rows.length
        ? `${conversationHasOlder ? '<button type="button" class="ghost-button" data-load-older-messages>Load older messages</button>' : ''}${rows.map(m => messageMarkup(m, shareByMessage.get(m.id))).join('')}`
        : '<p class="page-copy">No messages yet.</p>';
      thread.scrollTop = thread.scrollHeight;
    } else if (rows.length) {
      const oldScrollHeight = thread.scrollHeight;
      const oldScrollTop = thread.scrollTop;
      conversationBeforeCursor = { id: rows[0].id, created_at: rows[0].created_at };
      const button = thread.querySelector('[data-load-older-messages]');
      const shares = await fetchNutritionSharesForMessages(rows);
      const shareByMessage = new Map(shares.map(s => [s.message_id, s]));
      const html = rows.map(m => messageMarkup(m, shareByMessage.get(m.id))).join('');
      if (button) button.insertAdjacentHTML('afterend', html); else thread.insertAdjacentHTML('afterbegin', html);
      if (!conversationHasOlder) thread.querySelector('[data-load-older-messages]')?.remove();
      thread.scrollTop = oldScrollTop + (thread.scrollHeight - oldScrollHeight);
    } else if (loadOlder) {
      thread.querySelector('[data-load-older-messages]')?.remove();
    }

    thread.querySelector('[data-load-older-messages]')?.addEventListener('click', () => renderMessages(true).catch(console.error));
    bindMessageActions(thread);
    setText('[data-chat-title]', personById(selectedFriendId)?.display_name || 'Select a friend');
  }

  function messageMarkup(m, share=null) {
    const shareMarkup = share ? nutritionShareCard(share, personById(share.sender_id)?.display_name || (share.sender_id===user.id ? 'You' : 'A friend'), true) : '';
    return `<article class="message-bubble ${m.sender_id === user.id ? 'mine' : ''}"><div>${escapeHtml(m.body)}</div>${shareMarkup}<p>${formatTimestamp(m.created_at)}</p>${m.sender_id === user.id ? `<button type="button" class="text-button danger-button message-delete-button" data-delete-message="${m.id}">Delete</button>` : `<button type="button" class="text-button danger-button" data-report-message="${m.id}">Report</button>`}</article>`;
  }

  function bindMessageActions(thread) {
    thread.querySelectorAll('[data-report-message]').forEach(button => {
      button.onclick = async () => {
        const reason = prompt('Why are you reporting this message?');
        if (!reason?.trim()) return;
        const { error } = await supabase.rpc('report_message', { p_message_id: Number(button.dataset.reportMessage), p_reason: reason.trim() });
        if (error) alert(error.message); else { alert('Report submitted to MacroSync administrators.'); button.disabled = true; button.textContent = 'Reported'; }
      };
    });
    thread.querySelectorAll('[data-delete-message]').forEach(button => {
      button.onclick = async () => {
        if (!confirm('Delete this message permanently?')) return;
        const { data: deleted, error: deleteError } = await supabase.rpc('delete_message', { p_message_id: Number(button.dataset.deleteMessage) });
        if (deleteError) { alert(deleteError.message); return; }
        if (!deleted) { alert('The message could not be deleted. It may already be gone or you may not own it.'); return; }
        await renderMessages();
      };
    });
  }

  async function sendMessage() {
    if (!selectedFriendId) { alert('Select a friend first.'); return; }
    const input = $('[data-message-text]'); const body = input?.value.trim();
    const { data: ageProfile } = await supabase.from('profiles').select('date_of_birth').eq('id', user.id).single();
    const isMinor = ageProfile?.date_of_birth ? ageInYears(ageProfile.date_of_birth) < 18 : true;
    const validation = validateMessageText(body, isMinor); if (validation) { alert(validation); return; }
    const { error } = await supabase.rpc('send_message', { p_recipient_id: selectedFriendId, p_body: body });
    if (error) { alert(error.message); return; }
    input.value = '';
    await renderMessages();
  }

  function shareMealsEnabledBy(connection, ownerId) {
    if (!connection || !ownerId) return false;
    if (connection.requester_id === ownerId) return Boolean(connection.requester_share_meals);
    if (connection.addressee_id === ownerId) return Boolean(connection.addressee_share_meals);
    return false;
  }

  async function renderSharingControls(profile) {
    const box = $('[data-sharing-controls]'); if (!box) return;
    const targetId = selectedMealFriendId || selectedFriendId;
    if (!targetId) { box.hidden = true; return; }
    const friend = personById(targetId); const connection = connectionFor(targetId);
    if (!friend || !connection || connection.status !== 'accepted') { box.hidden = true; return; }
    box.hidden = false;

    const myShare = shareMealsEnabledBy(connection, user.id);
    const friendShare = shareMealsEnabledBy(connection, friend.id);
    const trainerViewingClient = profile.role === 'trainer' && friend.role === 'user';
    const clientViewingTrainer = profile.role === 'user' && friend.role === 'trainer';

    const automaticTrainerNote = trainerViewingClient
      ? `<p class="page-copy">You can always view this client's daily food log as their personal trainer. You can also choose to share your own food log with them.</p>`
      : '';
    const mandatoryClientSharingNote = clientViewingTrainer
      ? `<div class="sharing-info"><strong>Meal sharing with your personal trainer cannot be disabled.</strong><p class="page-copy">Your daily food log is shared with your personal trainer while you are connected.</p></div>`
      : '';
    const friendStatus = friendShare
      ? `${escapeHtml(friend.display_name)} is sharing their daily food log with you.`
      : `${escapeHtml(friend.display_name)} is not currently sharing their daily food log with you.`;

    const mySharingControl = clientViewingTrainer
      ? mandatoryClientSharingNote
      : `<label class="toggle-row"><input type="checkbox" data-share-meals-toggle ${myShare ? 'checked' : ''}><span><strong>Share my daily food log with ${escapeHtml(friend.display_name)}</strong><small>You can turn your own meal sharing on or off for this friend.</small></span></label>`;

    box.innerHTML = `${automaticTrainerNote}${mySharingControl}<p class="page-copy sharing-status">${friendStatus}</p>`;
    box.querySelector('[data-share-meals-toggle]')?.addEventListener('change', toggleMealSharing);
  }

  async function toggleMealSharing(event) {
    const targetId = selectedMealFriendId || selectedFriendId;
    if (!targetId) return;
    const connection = connectionFor(targetId);
    if (!connection) return;
    const { data: currentProfile, error: profileError } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (profileError) { alert(profileError.message); event.target.checked = !event.target.checked; return; }
    const { error } = await supabase.rpc('set_meal_sharing', { connection_id: connection.id, enabled: event.target.checked });
    if (error) {
      alert(error.message);
      event.target.checked = !event.target.checked;
      return;
    }
    await loadSocialData();
    renderFriendSelectors();
    await renderSharingControls(currentProfile);
    await renderSharedMeals(currentProfile);
  }

  async function renderSharedMeals(profile) {
    const list = $('[data-shared-meal-list]');
    if (!list) return;
    const targetId = selectedMealFriendId;
    const friend = targetId ? personById(targetId) : null;
    const connection = targetId ? connectionFor(targetId) : null;
    const title = $('[data-meal-view-title]');
    const note = $('[data-meal-view-note]');

    if (!targetId || !friend || !connection || connection.status !== 'accepted') {
      if (title) title.textContent = 'Choose whose meals to view';
      if (note) note.textContent = 'Select an accepted friend. Personal trainers can always view their clients\' daily food logs; other friends only appear when that person has enabled sharing.';
      list.innerHTML = '<p class="page-copy">Select a friend to view shared meals.</p>';
      return;
    }

    if (title) title.textContent = `${friend.display_name}\'s meals`;
    const friendShare = shareMealsEnabledBy(connection, friend.id);
    const canView = (profile.role === 'trainer' && friend.role === 'user') || friendShare;
    if (!canView) {
      if (note) note.textContent = `${friend.display_name} has not enabled meal sharing with you.`;
      list.innerHTML = '<p class="page-copy">Meals are private for this friend right now.</p>';
      await renderSharingControls(profile);
      return;
    }

    if (note) note.textContent = `Showing ${friend.display_name}\'s meals for ${formatDate(selectedDate)}.`;
    const { data, error } = await supabase.from('food_entries').select('*').eq('user_id', friend.id).eq('logged_date', dateKey(selectedDate)).order('created_at');
    if (error) throw error;
    const entries = data || [];
    const totals = totalsFor(entries);
    if (!entries.length) {
      list.innerHTML = `<div class="share-preview"><strong>${escapeHtml(friend.display_name)} has no food logged for this day.</strong></div>`;
      return;
    }
    const { data: friendMeals, error: friendMealsError } = await supabase.from('meals').select('id,meal_number,name').eq('user_id', friend.id).order('meal_number');
    if (friendMealsError) throw friendMealsError;
    const mealCategories = (friendMeals || []).length
      ? friendMeals.map(meal => ({ key: meal.name, label: meal.name, id: meal.id }))
      : [...new Set(entries.map(entry => String(entry.meal || '').trim()).filter(Boolean))].map((name, index) => ({ key: name, label: name, id: `legacy-${index}` }));
    const categoryMarkup = mealCategories.map(category => {
      const categoryEntries = entries.filter(entry => String(entry.meal || '').trim().toLowerCase() === category.key.toLowerCase());
      const categoryTotals = totalsFor(categoryEntries);
      const body = categoryEntries.length
        ? categoryEntries.map(entry => `<article class="meal-card"><div><strong>${escapeHtml(entry.food_name)}</strong><p>${escapeHtml(entry.serving)}</p></div><strong>${moneyless(entry.calories)} cal</strong></article>`).join('')
        : '<p class="page-copy shared-meal-empty">No meals logged in this category.</p>';
      const stateKey = `${friend.id}:${dateKey(selectedDate)}:${category.id}`;
      const isOpen = !sharedMealCollapsed.has(stateKey);
      return `<details class="shared-meal-category" data-shared-meal-category="${category.key.toLowerCase()}" data-shared-meal-state-key="${stateKey}"${isOpen ? ' open' : ''}><summary><span><strong>${category.label}</strong><small>${categoryEntries.length} meal${categoryEntries.length === 1 ? '' : 's'} · ${moneyless(categoryTotals.calories)} cal</small></span><span class="shared-meal-chevron" aria-hidden="true">⌄</span></summary><div class="shared-meal-category-body">${body}</div></details>`;
    }).join('');
    list.innerHTML = `<div class="shared-meal-summary"><strong>${moneyless(totals.calories)} calories</strong><span>Protein ${moneyless(totals.protein)}g · Carbs ${moneyless(totals.carbs)}g · Fat ${moneyless(totals.fat)}g</span></div><div class="shared-meal-categories">${categoryMarkup}</div>`;

    // Preserve each category's collapsed state across any re-render of the shared-meal list.
    // The shared-meal viewer is refreshed in several places, so relying only on the native
    // <details> state would cause a collapsed section to pop open again.
    list.querySelectorAll('[data-shared-meal-state-key]').forEach(details => {
      details.addEventListener('toggle', () => {
        const stateKey = details.dataset.sharedMealStateKey;
        if (!stateKey) return;
        if (details.open) sharedMealCollapsed.delete(stateKey);
        else sharedMealCollapsed.add(stateKey);
      });
    });
  }

  function renderCalendar(){
    const cal=$('[data-calendar-days]');
    if(!cal)return;
    const monthLabel=$('[data-calendar-month]');
    if(monthLabel) monthLabel.textContent=weekStart.toLocaleDateString(undefined,{month:'long',year:'numeric'});
    cal.innerHTML='';
    for(let i=0;i<7;i++){
      const d=addDays(weekStart,i);
      const b=document.createElement('button');
      b.type='button';
      b.className='calendar-day'+(dateKey(d)===dateKey(selectedDate)?' active':'');
      b.innerHTML=`<span>${d.toLocaleDateString(undefined,{weekday:'short'})}</span><strong>${d.getDate()}</strong>`;
      b.onclick=async()=>{selectedDate=d; await renderPage();};
      cal.appendChild(b);
    }
  }
  function wireDateControls(){ $$('[data-prev-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,-1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-next-day]').forEach(b=>b.onclick=async()=>{selectedDate=addDays(selectedDate,1);weekStart=startOfWeek(selectedDate);await renderPage();}); $$('[data-prev-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,-7);selectedDate=weekStart;await renderPage();}); $$('[data-next-week]').forEach(b=>b.onclick=async()=>{weekStart=addDays(weekStart,7);selectedDate=weekStart;await renderPage();}); $$('[data-today-button]').forEach(b=>b.onclick=async()=>{selectedDate=new Date();weekStart=startOfWeek(selectedDate);await renderPage();}); }
  function setText(sel,val){ $$(sel).forEach(n=>n.textContent=val); }
  function setWidth(sel,pct){ $$(sel).forEach(n=>n.style.width=`${Math.max(0,Math.min(pct,100))}%`); }
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  return { init };
})();

PulsePlateApp.init();
